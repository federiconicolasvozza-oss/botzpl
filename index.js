// index.js – Zupply Bot (Logística, Vendedor y Otros servicios)
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { google } from "googleapis";
// import { fetch } from "undici"; // descomentar si usás Node < 18

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

// Template para botón-URL de asesor (créalo en Meta y usá ese nombre)
const ADVISOR_TEMPLATE_NAME = (process.env.ADVISOR_TEMPLATE_NAME || "asesor_zupply").trim();

// Link del asesor (usado solo en fallback)
const ASESOR_WA = "https://wa.me/5491137829642";

/* ========= Credenciales Google ========= */
function chooseCredPath(filename) {
  const fromSecrets = path.join("/etc/secrets", filename);
  const fromRepo = path.join(process.cwd(), "credentials", filename);
  try { fs.accessSync(fromSecrets); return fromSecrets; } catch {}
  return fromRepo;
}
const CLIENT_PATH = chooseCredPath("oauth_client.json");
const TOKEN_PATH  = chooseCredPath("oauth_token.json");

/* ========= Sesiones ========= */
/**
 * sessions[wa_id] = {
 *   rol: "logistica" | "vendedor" | "servicios" | null,
 *   step: string|null,
 *   // comunes
 *   segment: "seg_0_100"|"seg_100_300"|"seg_300"|null,
 *   // logística
 *   mejora_logi: "orden"|"choferes"|"rendiciones"|"facturacion"|null,
 *   choferes: "1_3"|"4_10"|"11_plus"|null,
 *   facturacion: "viaje"|"planilla"|"mixto"|null,
 *   // vendedor
 *   rubro: "retail"|"industria"|"servicios"|null,
 *   mejora_vta: "costos"|"tiempos"|"devol"|"seguimiento"|null,
 *   // lead
 *   data: { empresa?: string, email?: string },
 *   updatedAt: number
 * }
 */
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;
function getSession(wa_id) {
  const now = Date.now();
  let s = sessions.get(wa_id);
  if (s && now - (s.updatedAt || 0) > SESSION_TTL_MS) { sessions.delete(wa_id); s = null; }
  if (!s) { s = { rol: null, step: "inicio", data: {}, updatedAt: now }; sessions.set(wa_id, s); }
  s.updatedAt = now;
  return s;
}
function resetSession(wa_id) { sessions.delete(wa_id); }

/* ========= WhatsApp helpers ========= */
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
  // WhatsApp: título máx 20 chars
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
// Enviar template con botón URL (no muestra link en el texto)
async function sendAdvisorTemplate(to) {
  // Creá en Meta un template (ej: asesor_zupply) con 1 botón URL apuntando a ASESOR_WA.
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: ADVISOR_TEMPLATE_NAME,
      language: { code: "es" },
      // Si tu template usa URL fija, NO hace falta components.
      // Si fuera URL con parámetro, agregar components con el parámetro.
    },
  });
}

/* ========= Copy ========= */
const COPY = {
  bienvenida:
    "👋 ¡Hola! Soy el asistente de *Zupply*.\n" +
    "Te ayudamos a ordenar tu operación logística: datos claros, control de flota y visibilidad en tiempo real.\n\n" +
    "Primero, contame qué buscás:",
  cta_principal: "Elegí una opción:",
  otros_servicios:
    "🧰 *Otros servicios Zupply*\n" +
    "• 🤖 Bot de WhatsApp\n" +
    "• ⚙️ Automatización de procesos\n" +
    "• 📦 Gestión de Inventario\n" +
    "• 📊 Analytics & Reportes\n" +
    "• 🛍️ Tienda Web\n" +
    "• 🏬 Digitalización de tienda física",
  lead_empresa: "Perfecto. Decime el *nombre de tu empresa*.",
  lead_email: "📧 Ahora un *email* de contacto.",
  email_inval: "⚠️ Ese email no parece válido. Probá de nuevo.",
  gracias: "✅ ¡Gracias! Te contactamos a la brevedad.",
};

/* ========= UI builders ========= */
async function sendWelcome(to) {
  await sendText(to, COPY.bienvenida);
  return sendButtons(to, COPY.cta_principal, [
    { id: "rol_logi", title: "🚚 Logística" },
    { id: "rol_vta",  title: "🧑‍💼 Vendedor" },
    { id: "rol_srv",  title: "🧰 Otros serv." },
  ]);
}

/* Logística */
function btnLogiMejora(to) {
  return sendButtons(to, "¿Qué querés mejorar?", [
    { id: "logi_mej_orden",       title: "🟩 Orden flota" },
    { id: "logi_mej_choferes",    title: "🟩 Control chofer" },
    { id: "logi_mej_rendiciones", title: "🟩 Rendiciones" },
    { id: "logi_mej_fact",        title: "🟩 Facturación" },
  ]);
}
function btnLogiChoferes(to) {
  return sendButtons(to, "¿Cuántos choferes?", [
    { id: "logi_ch_1_3",   title: "1–3" },
    { id: "logi_ch_4_10",  title: "4–10" },
    { id: "logi_ch_11p",   title: "11+" },
  ]);
}
function btnLogiFacturacion(to) {
  return sendButtons(to, "¿Cómo facturás?", [
    { id: "logi_fac_viaje",   title: "Por viaje" },
    { id: "logi_fac_plan",    title: "Planilla" },
    { id: "logi_fac_mixto",   title: "Mixto" },
  ]);
}
function btnVolumen(to) {
  return sendButtons(to, "¿Volumen diario?", [
    { id: "seg_0_100",   title: "📦 0–100" },
    { id: "seg_100_300", title: "🚚 100–300" },
    { id: "seg_300",     title: "🏢 300+" },
  ]);
}

/* Vendedor */
function btnRubro(to) {
  return sendButtons(to, "¿A qué rubro pertenecés?", [
    { id: "rub_retail",    title: "🛒 Retail" },
    { id: "rub_industria", title: "🏭 Industria" },
    { id: "rub_servicios", title: "🧑‍💼 Servicios" },
  ]);
}
function btnMejoraVta(to) {
  return sendButtons(to, "¿Qué querés mejorar?", [
    { id: "vta_costos",      title: "💵 Costos" },
    { id: "vta_tiempos",     title: "⏱️ Tiempos" },
    { id: "vta_devol",       title: "↩️ Devoluc." },
    { id: "vta_seguimiento", title: "📍 Seguim." },
  ]);
}

/* CTAs finales */
function btnCTAs(to) {
  return sendButtons(to, "¿Cómo seguimos?", [
    { id: "cta_demo",   title: "🗓️ Demo" },
    { id: "cta_asesor", title: "👤 Asesor" },
    { id: "cta_volver", title: "⬅️ Volver" },
  ]);
}

/* ========= Google Sheets ========= */
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
    wa_id, rol, segment, mejora_logi, choferes, facturacion,
    rubro, mejora_vta, empresa, email, origen_registro = "Zupply Ventas"
  } = row;
  await appendToSheet([
    ts, wa_id, rol || "", segment || "",
    mejora_logi || "", choferes || "", facturacion || "",
    rubro || "", mejora_vta || "",
    empresa || "", email || "", origen_registro
  ]);
}

/* ========= Rutas ========= */
app.get("/webhook", (req, res) => {
  const mode = String(req.query["hub.mode"] || "");
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.get("/health", (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

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

      /* ===== INTERACTIVE ===== */
      if (type === "interactive") {
        const id = msg?.interactive?.button_reply?.id || msg?.interactive?.list_reply?.id || null;
        if (!id) { await sendWelcome(from); continue; }

        // Menú principal
        if (id === "rol_logi") { session.rol = "logistica"; session.step = "logi_mejora"; await btnLogiMejora(from); continue; }
        if (id === "rol_vta")  { session.rol = "vendedor";  session.step = "vta_rubro";   await btnRubro(from);      continue; }
        if (id === "rol_srv")  {
          session.rol = "servicios";
          await sendText(from, COPY.otros_servicios);
          await sendButtons(from, "¿Te interesa alguno?", [
            { id: "srv_si", title: "✅ Sí" },
            { id: "srv_no", title: "❌ No" },
          ]);
          continue;
        }

        // Logística → mejora
        if (["logi_mej_orden","logi_mej_choferes","logi_mej_rendiciones","logi_mej_fact"].includes(id)) {
          session.mejora_logi = id.replace("logi_mej_","").replace("fact","facturacion");
          session.step = "logi_choferes";
          await btnLogiChoferes(from);
          continue;
        }
        // Logística → choferes
        if (["logi_ch_1_3","logi_ch_4_10","logi_ch_11p"].includes(id)) {
          session.choferes = id === "logi_ch_1_3" ? "1_3" : id === "logi_ch_4_10" ? "4_10" : "11_plus";
          session.step = "logi_facturacion";
          await btnLogiFacturacion(from);
          continue;
        }
        // Logística → facturación
        if (["logi_fac_viaje","logi_fac_plan","logi_fac_mixto"].includes(id)) {
          session.facturacion = id === "logi_fac_viaje" ? "viaje" : id === "logi_fac_plan" ? "planilla" : "mixto";
          session.step = "logi_volumen";
          await btnVolumen(from);
          continue;
        }
        // Volumen
        if (["seg_0_100","seg_100_300","seg_300"].includes(id)) {
          session.segment = id;
          session.step = "lead_empresa";
          await sendText(from, COPY.lead_empresa);
          continue;
        }

        // Vendedor → rubro
        if (["rub_retail","rub_industria","rub_servicios"].includes(id)) {
          session.rubro = id.replace("rub_","");
          session.step = "vta_mejora";
          await btnMejoraVta(from);
          continue;
        }
        // Vendedor → mejora
        if (["vta_costos","vta_tiempos","vta_devol","vta_seguimiento"].includes(id)) {
          session.mejora_vta = id.replace("vta_","");
          session.step = "vta_volumen";
          await btnVolumen(from);
          continue;
        }

        // Otros servicios → interés
        if (id === "srv_si") { session.step = "lead_empresa"; await sendText(from, COPY.lead_empresa); continue; }
        if (id === "srv_no") { await btnCTAs(from); continue; }

        // CTAs
        if (id === "cta_volver") { resetSession(from); await sendWelcome(from); continue; }
        if (id === "cta_demo")   { await sendText(from, "🗓️ Coordinemos una demo."); await btnCTAs(from); continue; }
        if (id === "cta_asesor") {
          const ok = await sendAdvisorTemplate(from);
          if (!ok) await sendText(from, "Abrí este botón para hablar con un asesor:\n" + ASESOR_WA);
          continue;
        }

        await sendWelcome(from);
        continue;
      }

      /* ===== TEXTO ===== */
      if (type === "text") {
        const raw = (msg.text?.body || "").trim();
        const body = raw.toLowerCase();

        if (["hola","menu","menú","inicio","start","ayuda"].includes(body)) {
          resetSession(from);
          await sendWelcome(from);
          continue;
        }

        // Lead → empresa
        if (session.step === "lead_empresa") {
          session.data.empresa = raw;
          session.step = "lead_email";
          await sendText(from, COPY.lead_email);
          continue;
        }
        // Lead → email + guardar
        if (session.step === "lead_email") {
          const email = raw;
          const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
          if (!ok) { await sendText(from, COPY.email_inval); continue; }
          session.data.email = email;

          try {
            await recordLead({
              wa_id: from,
              rol: session.rol,
              segment: session.segment,
              mejora_logi: session.mejora_logi,
              choferes: session.choferes,
              facturacion: session.facturacion,
              rubro: session.rubro,
              mejora_vta: session.mejora_vta,
              empresa: session.data.empresa,
              email,
            });
          } catch {}

          await sendText(from, COPY.gracias);
          resetSession(from);
          await btnCTAs(from);
          continue;
        }

        // Atajos
        if (body.includes("asesor")) {
          const ok = await sendAdvisorTemplate(from);
          if (!ok) await sendText(from, "Abrí este botón para hablar con un asesor:\n" + ASESOR_WA);
          continue;
        }
        if (body.includes("demo")) { await sendText(from, "🗓️ Coordinemos una demo."); await btnCTAs(from); continue; }

        // Fallback
        await btnCTAs(from);
        continue;
      }

      // Otros tipos → menú
      await sendWelcome(from);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("💥 Webhook error:", e);
    return res.sendStatus(200);
  }
});

/* ========= Start ========= */
app.listen(PORT, () => {
  console.log(`🚀 Zupply Bot en http://localhost:${PORT}`);
  console.log("📞 PHONE_NUMBER_ID:", PHONE_NUMBER_ID || "(vacío)");
  console.log("📄 Google Sheets:", GOOGLE_SHEETS_ID ? `ON (${GOOGLE_SHEETS_ID} / ${TAB_LEADS})` : "OFF");
  console.log("🔗 Template asesor:", ADVISOR_TEMPLATE_NAME);
});
