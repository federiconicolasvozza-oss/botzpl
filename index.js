// index.js – Zupply Bot (Flujo de ventas: calificación por volumen de envíos)
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { google } from "googleapis";

dotenv.config();
const app = express();
app.use(express.json({ limit: "20mb" }));

/* ===================== ENV ===================== */
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "botconektar123").trim();
const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const API_VERSION = (process.env.API_VERSION || "v23.0").trim();

// Google Sheets opcional
const GOOGLE_SHEETS_ID = (process.env.GOOGLE_SHEETS_ID || "").trim();
const TAB_LEADS = (process.env.TAB_LEADS || "Leads").trim();

/* ========= Credenciales Google opcionales ========= */
function chooseCredPath(filename) {
  const fromSecrets = path.join("/etc/secrets", filename);
  const fromRepo = path.join(process.cwd(), "credentials", filename);
  try { fs.accessSync(fromSecrets); return fromSecrets; } catch {}
  return fromRepo;
}
const CLIENT_PATH = chooseCredPath("oauth_client.json");
const TOKEN_PATH  = chooseCredPath("oauth_token.json");

/* ============ Sesiones por usuario ============ */
/**
 * sessions[wa_id] = {
 *   step: null | "lead_empresa" | "lead_email",
 *   segment: null | "seg_0_100" | "seg_100_300" | "seg_300",
 *   data: { empresa?: string, email?: string }
 * }
 */
const sessions = new Map();
function getSession(wa_id) {
  if (!sessions.has(wa_id)) sessions.set(wa_id, { step: null, segment: null, data: {} });
  return sessions.get(wa_id);
}

/* ============ WhatsApp helpers ============ */
async function sendMessage(payload) {
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ Error enviando mensaje:", res.status, txt);
  }
  return res.ok;
}

function sendText(to, body) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  });
}

function sendButtons(to, text, buttons) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: {
        buttons: buttons.map(({ id, title }) => ({
          type: "reply",
          reply: { id, title },
        })),
      },
    },
  });
}

/* ============ Copy editable ============ */
const LINKS = {
  web: "https://zupply.tech/",
  mail: "hola@zupply.tech",
  demo: "https://zupply.tech/", // poné aquí la URL de agenda si la tenés
};

const COPY = {
  bienvenida:
    "👋 ¡Hola! Soy el asistente comercial de *Zupply*.\n" +
    "Digitalizamos tu logística: ingesta automática, asignación inteligente y visibilidad total.\n\n" +
    "Para orientarte mejor, decime:",
  preguntaVolumen: "¿Cuántos envíos diarios manejás?",
  ctasPostPitch:
    "¿Cómo seguimos? Elegí una opción:",
  pedirEmpresa:
    "Genial. Para coordinar, decime el *nombre de tu empresa*.",
  pedirEmail:
    "📧 Perfecto. Ahora un *email* de contacto para enviarte la info y coordinar la demo.",
  emailInvalido: "⚠️ Ese email no parece válido. Probá nuevamente.",
  graciasLead:
    "✅ ¡Gracias! Un asesor te contactará a la brevedad. Mientras tanto, podés visitar: " + LINKS.web,
  fallback:
    "No tengo una respuesta exacta para eso 🤔. ¿Querés que te contacte un asesor?",
};

/* ============ Pitches por segmento ============ */
function pitchBySegment(id) {
  if (id === "seg_0_100") {
    return {
      title: "🎯 Segmento: 0–100 envíos/día",
      text:
        "Ideal para estandarizar rápido sin fricción.\n" +
        "• Ingesta automática (CSV/QR/API)\n" +
        "• Reglas simples de asignación\n" +
        "• Tracking y panel unificado\n" +
        "• Reportes básicos para decisiones\n",
      plan: "Sugerencia: *Plan Emprendedor/Starter*",
    };
  }
  if (id === "seg_100_300") {
    return {
      title: "🚀 Segmento: 100–300 envíos/día",
      text:
        "Escalá con control operativo real.\n" +
        "• Reglas avanzadas por zona/SLAs\n" +
        "• Integraciones bidireccionales (API/Webhooks)\n" +
        "• KPIs operativos y calidad de servicio\n" +
        "• Onboarding guiado en días\n",
      plan: "Sugerencia: *Plan Profesional*",
    };
  }
  // seg_300
  return {
    title: "🏢 Segmento: 300+ envíos/día",
    text:
      "Enterprise para alta escala y compliance.\n" +
      "• Multi-depósito / multi-transportista\n" +
      "• Reglas complejas, ruteo y SLAs\n" +
      "• Integraciones a medida (ERP/BI)\n" +
      "• Gobernanza, auditoría y soporte priorizado\n",
    plan: "Sugerencia: *Plan Enterprise*",
  };
}

/* ============ Google Sheets opcional (leads) ============ */
function hasGoogle() {
  try {
    fs.accessSync(CLIENT_PATH);
    fs.accessSync(TOKEN_PATH);
    return Boolean(GOOGLE_SHEETS_ID);
  } catch {
    return false;
  }
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
async function recordLead({ wa_id, segment, empresa, email, origen = "Zupply Ventas" }) {
  const ts = new Date().toISOString();
  await appendToSheet([ts, wa_id, segment || "", empresa || "", email || "", origen]);
}

/* ============ UI ============ */
async function sendWelcome(to) {
  await sendText(to, `${COPY.bienvenida}\n\n${COPY.preguntaVolumen}`);
  return sendButtons(to, "Elegí una opción:", [
    { id: "seg_0_100",   title: "📦 0–100/día" },
    { id: "seg_100_300", title: "🚚 100–300/día" },
    { id: "seg_300",     title: "🏢 300+ /día" },
  ]);
}
function sendSegmentCTAs(to) {
  return sendButtons(to, COPY.ctasPostPitch, [
    { id: "cta_demo",   title: "🗓️ Quiero una demo" },
    { id: "cta_asesor", title: "💬 Hablar con un asesor" },
    { id: "cta_volver", title: "⬅️ Cambiar volumen" },
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
    const messages = change?.messages;
    if (!messages || messages.length === 0) return res.sendStatus(200);

    const msg = messages[0];
    const from = msg.from;
    const type = msg.type;
    const session = getSession(from);

    // === INTERACTIVE ===
    if (type === "interactive") {
      const btn = msg?.interactive?.button_reply?.id;
      const list = msg?.interactive?.list_reply?.id;
      const id = btn || list;

      if (!id) { await sendWelcome(from); return res.sendStatus(200); }

      // Selección de segmento
      if (["seg_0_100", "seg_100_300", "seg_300"].includes(id)) {
        session.segment = id;
        const p = pitchBySegment(id);
        await sendText(from, `*${p.title}*\n${p.text}${p.plan}`);
        await sendSegmentCTAs(from);
        return res.sendStatus(200);
      }

      // CTAs
      if (id === "cta_volver") {
        sessions.delete(from);
        await sendWelcome(from);
        return res.sendStatus(200);
      }
      if (id === "cta_demo") {
        await sendText(from, `🗓️ Agenda rápida: ${LINKS.demo}\n\nSi preferís, dejamos tus datos y te contactamos:`);
        await askLead(from, session);
        return res.sendStatus(200);
      }
      if (id === "cta_asesor") {
        await askLead(from, session);
        return res.sendStatus(200);
      }

      // Cualquier otro botón
      await sendWelcome(from);
      return res.sendStatus(200);
    }

    // === TEXTO ===
    if (type === "text") {
      const body = (msg.text?.body || "").trim().toLowerCase();

      // Comandos globales
      if (["hola", "menu", "menú", "inicio", "start", "ayuda"].includes(body)) {
        sessions.delete(from);
        await sendWelcome(from);
        return res.sendStatus(200);
      }

      // Flujo lead: empresa -> email
      if (session.step === "lead_empresa") {
        session.data.empresa = (msg.text?.body || "").trim();
        session.step = "lead_email";
        await sendText(from, COPY.pedirEmail);
        return res.sendStatus(200);
      }
      if (session.step === "lead_email") {
        const email = (msg.text?.body || "").trim();
        const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        if (!ok) { await sendText(from, COPY.emailInvalido); return res.sendStatus(200); }
        session.data.email = email;
        try { await recordLead({ wa_id: from, segment: session.segment, empresa: session.data.empresa, email }); } catch {}
        await sendText(from, COPY.graciasLead);
        sessions.delete(from);
        await sendButtons(from, "¿Querés seguir?", [
          { id: "seg_0_100",   title: "📦 0–100/día" },
          { id: "seg_100_300", title: "🚚 100–300/día" },
          { id: "seg_300",     title: "🏢 300+ /día" },
        ]);
        return res.sendStatus(200);
      }

      // Intenciones rápidas
      if (body.includes("demo")) {
        await sendText(from, `🗓️ Agenda: ${LINKS.demo}`);
        await askLead(from, session);
        return res.sendStatus(200);
      }
      if (body.includes("asesor") || body.includes("contact")) {
        await askLead(from, session);
        return res.sendStatus(200);
      }
      if (body.includes("precio") || body.includes("plan")) {
        // Usa el segmento si ya lo eligió, sino preguntamos volumen
        if (!session.segment) { await sendWelcome(from); return res.sendStatus(200); }
        const p = pitchBySegment(session.segment);
        await sendText(from, `${p.plan}\nPodemos cotizar según tu caso y volumen.`);
        await sendSegmentCTAs(from);
        return res.sendStatus(200);
      }

      // Fallback de ventas
      await sendText(from, COPY.fallback);
      await sendButtons(from, "Elegí una opción:", [
        { id: "cta_asesor", title: "💬 Hablar con asesor" },
        { id: "cta_demo",   title: "🗓️ Quiero una demo" },
        { id: "cta_volver", title: "⬅️ Cambiar volumen" },
      ]);
      return res.sendStatus(200);
    }

    // Otros tipos (audio/imágenes/etc.)
    await sendWelcome(from);
    return res.sendStatus(200);
  } catch (e) {
    console.error("💥 Webhook error:", e);
    return res.sendStatus(200);
  }
});

/* ====== Helpers ====== */
async function askLead(to, session) {
  session.step = "lead_empresa";
  session.data = {};
  await sendText(to, `${COPY.pedirEmpresa}\n\n📧 ${LINKS.mail}`);
}

/* ============ Start ============ */
app.listen(PORT, () => {
  console.log(`🚀 Zupply Ventas Bot en http://localhost:${PORT}`);
  console.log("📞 PHONE_NUMBER_ID:", PHONE_NUMBER_ID || "(vacío)");
  console.log("📄 Google Sheets:", GOOGLE_SHEETS_ID ? "ON" : "OFF");
});


