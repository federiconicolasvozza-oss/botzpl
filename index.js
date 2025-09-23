// index.js – Zupply Bot (Ventas: calificación + guardado en Google Sheets)
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { google } from "googleapis";
// import { fetch } from "undici"; // descomentar si Node <18

dotenv.config();
const app = express();
app.use(express.json({ limit: "20mb" }));

/* ===================== ENV ===================== */
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "botconektar123").trim();
const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const API_VERSION = (process.env.API_VERSION || "v23.0").trim();

// Google Sheets
const GOOGLE_SHEETS_ID = (process.env.GOOGLE_SHEETS_ID || "14B7OvEJ3TWloCHRhuCVbIVWHWkAaoSVyL0Cf6NCnXbM").trim();
const TAB_LEADS = (process.env.TAB_LEADS || "Hoja 1").trim();

/* ========= Credenciales Google opcionales ========= */
function chooseCredPath(filename) {
  const fromSecrets = path.join("/etc/secrets", filename);
  const fromRepo = path.join(process.cwd(), "credentials", filename);
  try { fs.accessSync(fromSecrets); return fromSecrets; } catch {}
  return fromRepo;
}
const CLIENT_PATH = chooseCredPath("oauth_client.json");
const TOKEN_PATH  = chooseCredPath("oauth_token.json");

/* ========= Validación mínima ========= */
if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
  console.warn("⚠️ Falta WHATSAPP_TOKEN o PHONE_NUMBER_ID. El bot no podrá enviar mensajes.");
}

/* ============ Sesiones (con TTL) ============ */
/**
 * sessions[wa_id] = {
 *   step: "inicio"|"tipo"|"q_vol"|"q_sector"|"q_origen"|"q_integr"|"lead_empresa"|"lead_email",
 *   tipo: "logistica"|"servicios"|null,
 *   segment: "seg_0_100"|"seg_100_300"|"seg_300"|null,
 *   sector: "retail"|"industria"|"servicios"|null,
 *   origen: "ml"|"tienda"|"mixto"|null,
 *   integr: "si"|"no"|null,
 *   data: { empresa?: string, email?: string },
 *   updatedAt: number
 * }
 */
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min
function getSession(wa_id) {
  const now = Date.now();
  let s = sessions.get(wa_id);
  if (s && (now - (s.updatedAt || 0) > SESSION_TTL_MS)) { sessions.delete(wa_id); s = null; }
  if (!s) { s = { step: "inicio", tipo: null, segment: null, sector: null, origen: null, integr: null, data: {}, updatedAt: now }; sessions.set(wa_id, s); }
  s.updatedAt = now;
  return s;
}
function resetSession(wa_id) { sessions.delete(wa_id); }

/* ============ WhatsApp helpers ============ */
async function sendMessage(payload) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) { console.error("❌ Falta token/phone id"); return false; }
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("❌ Error enviando mensaje:", res.status, txt);
    return false;
  }
  return true;
}
function sendText(to, body) {
  return sendMessage({ messaging_product: "whatsapp", to, type: "text", text: { body } });
}
function sendButtons(to, text, buttons) {
  // Aseguramos títulos <=20 chars
  const norm = buttons.map(b => {
    let t = b.title || "";
    if (t.length > 20) t = t.slice(0, 20);
    return { type: "reply", reply: { id: b.id, title: t } };
  });
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: { type: "button", body: { text }, action: { buttons: norm } },
  });
}

/* ============ Copy ============ */
const LINKS = {
  web: "https://zupply.tech/",
  mail: "hola@zupply.tech",
  demo: "https://zupply.tech/",
  asesor_tel: "+54 9 11 3782-9642",
  asesor_wa: "https://wa.me/5491137829642",
};

const COPY = {
  bienvenida:
    "👋 ¡Hola! Soy el asistente de *Zupply*.\n" +
    "Digitalizamos tu logística: ingesta automática, asignación inteligente y visibilidad total.\n\n" +
    "Primero, contame qué buscás:",
  tipos: "Elegí una opción:",
  logi_p1: "🟩 *Soy logística* → vamos con 4 preguntas rápidas para entender tu operación.",
  serv_p1: "🟦 *Otros servicios* → te cuento brevemente qué hacemos y coordinamos.",
  preguntaVolumen: "¿Cuántos envíos diarios manejás?",
  preguntaSector: "¿En qué sector operás?",
  preguntaOrigen: "¿De dónde viene la mayoría de tus pedidos?",
  preguntaIntegr: "¿Necesitás integraciones (ERP/BI/tienda)?",
  pedirEmpresa: "Genial. Decime el *nombre de tu empresa*.",
  pedirEmail: "📧 Perfecto. Ahora un *email* de contacto.",
  emailInvalido: "⚠️ Ese email no parece válido. Probá nuevamente.",
  graciasLead: "✅ ¡Gracias! Te contactamos a la brevedad. Mientras tanto: " + LINKS.web,
  otrosServicios:
    "🟦 *Otros servicios Zupply*\n" +
    "• 🤖 Automatización de Procesos\n" +
    "• 🧾 Gestión de Inventario\n" +
    "• 📊 Analytics & Reportes\n" +
    "• 🛍️ Tienda Web / Digitalización de Tienda Física\n\n" +
    "Podemos ayudarte a evaluar tu caso y armar un plan.",
  ctas: "¿Cómo seguimos?",
};

/* ============ Pitches por segmento (resumen) ============ */
function pitchBySegment(id) {
  if (id === "seg_0_100") return { title: "🎯 0–100 envíos/día", plan: "Plan sugerido: *Starter*" };
  if (id === "seg_100_300") return { title: "🚀 100–300 envíos/día", plan: "Plan sugerido: *Profesional*" };
  return { title: "🏢 300+ envíos/día", plan: "Plan sugerido: *Enterprise*" };
}

/* ============ Google Sheets (append) ============ */
function hasGoogle() {
  try { fs.accessSync(CLIENT_PATH); fs.accessSync(TOKEN_PATH); return Boolean(GOOGLE_SHEETS_ID); } catch { return false; }
}
function getOAuthClient() {
  const missing = [];
  try { fs.accessSync(CLIENT_PATH); } catch { missing.push(CLIENT_PATH); }
  try { fs.accessSync(TOKEN_PATH); }  catch { missing.push(TOKEN_PATH); }
  if (missing.length) throw new Error("Faltan credenciales Google: " + missing.join(", "));
  const { installed } = JSON.parse(fs.readFileSync(CLIENT_PATH, "utf-8"));
  const { client_id, client_secret, redirect_uris } = installed;
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0] || "http://127.0.0.1");
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  oauth2.setCredentials(tokens);
  return oauth2;
}
async function appendToSheet(values) {
  if (!hasGoogle()) return;
  try {
    const auth = getOAuthClient();
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${TAB_LEADS}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [values] },
    });
  } catch (err) {
    console.error("❌ Error Google Sheets:", err?.response?.data || err);
  }
}
async function recordLead(row) {
  const ts = new Date().toISOString();
  const {
    wa_id, tipo, segment, sector, origen, integr, empresa, email,
    origen_registro = "Zupply Ventas",
  } = row;
  await appendToSheet([ts, wa_id, tipo || "", segment || "", sector || "", origen || "", integr || "", empresa || "", email || "", origen_registro]);
}

/* ============ UI helpers ============ */
async function sendWelcome(to) {
  await sendText(to, COPY.bienvenida);
  return sendButtons(to, COPY.tipos, [
    { id: "tipo_logi", title: "🚚 Soy logística" },
    { id: "tipo_serv", title: "🧰 Otros servicios" },
  ]);
}
function segmentButtons(to) {
  return sendButtons(to, COPY.preguntaVolumen, [
    { id: "seg_0_100",   title: "📦 0–100" },
    { id: "seg_100_300", title: "🚚 100–300" },
    { id: "seg_300",     title: "🏢 300+" },
  ]);
}
function sectorButtons(to) {
  return sendButtons(to, COPY.preguntaSector, [
    { id: "sec_retail",    title: "🛒 Retail" },
    { id: "sec_industria", title: "🏭 Industria" },
    { id: "sec_servicios", title: "🧑‍💼 Servicios" },
  ]);
}
function origenButtons(to) {
  return sendButtons(to, COPY.preguntaOrigen, [
    { id: "org_ml",     title: "🟡 ML" },
    { id: "org_tienda", title: "🛍️ Tienda" },
    { id: "org_mixto",  title: "🔀 Mixto" },
  ]);
}
function integrButtons(to) {
  return sendButtons(to, COPY.preguntaIntegr, [
    { id: "int_si", title: "✅ Sí" },
    { id: "int_no", title: "❌ No" },
  ]);
}
function ctasFinales(to) {
  return sendButtons(to, COPY.ctas, [
    { id: "cta_demo",   title: "🗓️ Demo" },
    { id: "cta_asesor", title: "💬 Asesor" },
    { id: "cta_volver", title: "⬅️ Cambiar" },
  ]);
}

/* ============ Webhook Verify (GET) ============ */
app.get("/webhook", (req, res) => {
  const mode = String(req.query["hub.mode"] || "");
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* ============ Health ============ */
app.get("/health", (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ============ Webhook Events (POST) ============ */
app.post("/webhook", async (req, res) => {
  try {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!change) return res.sendStatus(200);
    if (Array.isArray(change.statuses) && change.statuses.length > 0) return res.sendStatus(200);

    const messages = change?.messages;
    if (!messages || messages.length === 0) return res.sendStatus(200);

    for (const msg of messages) {
      const from = msg.from;
      if (!from) continue;
      const session = getSession(from);
      const type = msg.type;

      /* ========== INTERACTIVE ========== */
      if (type === "interactive") {
        const id = msg?.interactive?.button_reply?.id || msg?.interactive?.list_reply?.id || null;
        if (!id) { await sendWelcome(from); continue; }

        // Entrada principal
        if (id === "tipo_logi") {
          session.tipo = "logistica";
          session.step = "q_vol";
          await sendText(from, COPY.logi_p1);
          await segmentButtons(from);
          continue;
        }
        if (id === "tipo_serv") {
          session.tipo = "servicios";
          await sendText(from, COPY.serv_p1);
          await sendText(from, COPY.otrosServicios + `\n\n🗓️ Demo: ${LINKS.demo}\n💬 Asesor: ${LINKS.asesor_tel} (${LINKS.asesor_wa})`);
          await ctasFinales(from);
          continue;
        }

        // Volumen
        if (["seg_0_100", "seg_100_300", "seg_300"].includes(id)) {
          session.segment = id;
          const p = pitchBySegment(id);
          await sendText(from, `*${p.title}* — ${p.plan}`);
          session.step = "q_sector";
          await sectorButtons(from);
          continue;
        }

        // Sector
        if (["sec_retail","sec_industria","sec_servicios"].includes(id)) {
          session.sector = id.replace("sec_","");
          session.step = "q_origen";
          await origenButtons(from);
          continue;
        }

        // Origen
        if (["org_ml","org_tienda","org_mixto"].includes(id)) {
          session.origen = id.replace("org_","");
          session.step = "q_integr";
          await integrButtons(from);
          continue;
        }

        // Integraciones
        if (["int_si","int_no"].includes(id)) {
          session.integr = id === "int_si" ? "si" : "no";
          session.step = "lead_empresa";
          await sendText(from, COPY.pedirEmpresa);
          continue;
        }

        // CTAs
        if (id === "cta_volver") { resetSession(from); await sendWelcome(from); continue; }
        if (id === "cta_demo")   { await sendText(from, `🗓️ Agenda rápida: ${LINKS.demo}`); continue; }
        if (id === "cta_asesor") {
          await sendText(from, `💬 Contacto directo con asesor: ${LINKS.asesor_tel}\nWhatsApp: ${LINKS.asesor_wa}`);
          continue;
        }

        // Default
        await sendWelcome(from);
        continue;
      }

      /* ========== TEXTO ========== */
      if (type === "text") {
        const raw = (msg.text?.body || "").trim();
        const body = raw.toLowerCase();

        if (["hola","menu","menú","inicio","start","ayuda"].includes(body)) {
          resetSession(from);
          await sendWelcome(from);
          continue;
        }

        if (session.step === "lead_empresa") {
          session.data.empresa = raw;
          session.step = "lead_email";
          await sendText(from, COPY.pedirEmail);
          continue;
        }
        if (session.step === "lead_email") {
          const email = raw;
          const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
          if (!ok) { await sendText(from, COPY.emailInvalido); continue; }
          session.data.email = email;

          try {
            await recordLead({
              wa_id: from,
              tipo: session.tipo,
              segment: session.segment,
              sector: session.sector,
              origen: session.origen,
              integr: session.integr,
              empresa: session.data.empresa,
              email,
              origen_registro: "Zupply Ventas",
            });
          } catch {}

          await sendText(from, COPY.graciasLead);
          resetSession(from);
          await sendButtons(from, "¿Querés seguir?", [
            { id: "tipo_logi", title: "🚚 Soy logística" },
            { id: "tipo_serv", title: "🧰 Otros servicios" },
          ]);
          continue;
        }

        // Atajos
        if (body.includes("asesor")) {
          await sendText(from, `💬 Asesor: ${LINKS.asesor_tel} | ${LINKS.asesor_wa}`);
          continue;
        }
        if (body.includes("demo")) {
          await sendText(from, `🗓️ Demo: ${LINKS.demo}`);
          continue;
        }

        // Fallback
        await sendText(from, "¿Preferís que te contacte un asesor o agendamos demo?");
        await ctasFinales(from);
        continue;
      }

      // Otros tipos → re-mostrar menú
      await sendWelcome(from);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("💥 Webhook error:", e);
    return res.sendStatus(200);
  }
});

/* ============ Start ============ */
app.listen(PORT, () => {
  console.log(`🚀 Zupply Bot en http://localhost:${PORT}`);
  console.log("📞 PHONE_NUMBER_ID:", PHONE_NUMBER_ID || "(vacío)");
  console.log("📄 Google Sheets:", GOOGLE_SHEETS_ID ? `ON (${GOOGLE_SHEETS_ID} / ${TAB_LEADS})` : "OFF");
});
