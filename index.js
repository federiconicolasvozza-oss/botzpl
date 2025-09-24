// index.js – Zupply Bot
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
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
const sessions = new Map();
function getSession(wa_id) {
  if (!sessions.has(wa_id)) sessions.set(wa_id, { rol: null, step: null, data: {} });
  return sessions.get(wa_id);
}
function resetSession(wa_id) {
  sessions.delete(wa_id);
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

// Lista interactiva (hasta 10 ítems). Header SIN markdown.
function sendList(to, headerText, bodyText, rows) {
  const cleanHeader = String(headerText || "").replace(/[*_~`]/g, "");
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: cleanHeader },
      body: { text: bodyText },
      action: {
        button: "Elegir",
        sections: [
          {
            title: "Opciones",
            rows: rows.map(r => ({
              id: r.id,
              title: (r.title || "").slice(0, 24),
              description: r.desc || ""
            }))
          }
        ]
      }
    }
  });
}

// Botón de link
function sendLinkButton(to, text, url, title="Hablar con asesor") {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: {
        buttons: [
          {
            type: "url",
            url,
            title
          }
        ]
      }
    }
  });
}

/* ============ Copy ============ */
const LINKS = {
  asesor: "https://wa.me/5491137829642"
};

const COPY = {
  bienvenida:
    "👋 ¡Hola! Soy el asistente de *Zupply*.\n" +
    "Te ayudamos a ordenar tu operación logística: datos claros, control de flota y visibilidad en tiempo real.\n\n" +
    "Primero, contame qué buscás:",
  lead_empresa: "🏢 Decime el *nombre de tu empresa*.",
  lead_email: "📧 Ahora un *email* de contacto.",
  email_inval: "⚠️ Ese email no parece válido. Probá de nuevo.",
  gracias: "✅ ¡Gracias! Te contactamos a la brevedad.",
};

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
async function recordLead(obj) {
  const ts = new Date().toISOString();
  const { wa_id, rol, empresa, email, segment, choferes, facturacion, mejora } = obj;
  await appendToSheet([ts, wa_id, rol || "", empresa || "", email || "", segment || "", choferes || "", facturacion || "", mejora || ""]);
}

/* ============ UI steps ============ */
async function sendWelcome(to) {
  return sendButtons(to, COPY.bienvenida, [
    { id: "rol_logi", title: "🚚 Soy Logística" },
    { id: "rol_vta",  title: "🙋 Soy Vendedor" },
    { id: "rol_srv",  title: "🧰 + Servicios" },
  ]);
}

function btnLogiPaquetes(to) {
  return sendButtons(to, "📦 *¿Cuántos paquetes diarios manejás?*", [
    { id: "seg_0_10", title: "0–10" },
    { id: "seg_11_20", title: "11–20" },
    { id: "seg_20p", title: "20+" },
  ]);
}
function btnLogiChoferes(to) {
  return sendButtons(to, "🧑‍✈️ *¿Cuántos choferes?*", [
    { id: "chof_1_3", title: "1–3" },
    { id: "chof_4_10", title: "4–10" },
    { id: "chof_11p", title: "11+" },
  ]);
}
function btnLogiFacturacion(to) {
  return sendButtons(to, "💵 *¿Cómo facturás?*", [
    { id: "fact_viaje", title: "Por viaje" },
    { id: "fact_excel", title: "Excel" },
    { id: "fact_sis", title: "Sistema" },
  ]);
}

function btnVtaPaquetes(to) {
  return sendButtons(to, "📦 *¿Cuántos envíos diarios hacés?*", [
    { id: "vta_0_10", title: "0–10" },
    { id: "vta_11_30", title: "11–30" },
    { id: "vta_30p", title: "30+" },
  ]);
}
function btnMejoraVta(to) {
  return sendList(to, "Mejoras", "*¿Qué te gustaría mejorar?*", [
    { id: "vta_costos",      title: "💵 Costos" },
    { id: "vta_tiempos",     title: "⏱️ Tiempos" },
    { id: "vta_devol",       title: "↩️ Devoluciones" },
    { id: "vta_seguimiento", title: "📍 Seguimiento" }
  ]);
}

function servicesList(to) {
  return sendList(to, "Otros servicios Zupply", "*Elegí el que más te interese:*", [
    { id: "srv_bot",    title: "🤖 Bot WhatsApp" },
    { id: "srv_auto",   title: "⚙️ Automatización" },
    { id: "srv_stock",  title: "📦 Inventario" },
    { id: "srv_dash",   title: "📊 Analytics" },
    { id: "srv_web",    title: "🛍️ Tienda Web" },
    { id: "srv_fisica", title: "🏬 Tienda Física" },
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
    const body = (msg.text?.body || "").trim();

    // === INTERACTIVE ===
    if (type === "interactive") {
      const id = msg?.interactive?.button_reply?.id || msg?.interactive?.list_reply?.id;

      // Roles
      if (id === "rol_logi") { session.rol = "logistica"; session.step = "paq_logi"; await btnLogiPaquetes(from); return res.sendStatus(200); }
      if (id === "rol_vta")  { session.rol = "vendedor"; session.step = "paq_vta";  await btnVtaPaquetes(from); return res.sendStatus(200); }
      if (id === "rol_srv")  { session.rol = "servicios"; session.step = "srv_list"; await servicesList(from); return res.sendStatus(200); }

      // Logística
      if (id.startsWith("seg_")) { session.segment = id; session.step = "choferes"; await btnLogiChoferes(from); return res.sendStatus(200); }
      if (id.startsWith("chof_")) { session.choferes = id; session.step = "facturacion"; await btnLogiFacturacion(from); return res.sendStatus(200); }
      if (id.startsWith("fact_")) { session.facturacion = id; session.step = "empresa"; await sendText(from, COPY.lead_empresa); return res.sendStatus(200); }

      // Vendedor
      if (id.startsWith("vta_")) { session.segment = id; session.step = "mejora_vta"; await btnMejoraVta(from); return res.sendStatus(200); }
      if (["vta_costos","vta_tiempos","vta_devol","vta_seguimiento"].includes(id)) { session.mejora = id; session.step = "empresa"; await sendText(from, COPY.lead_empresa); return res.sendStatus(200); }

      // Servicios
      if (["srv_bot","srv_auto","srv_stock","srv_dash","srv_web","srv_fisica"].includes(id)) { session.mejora = id; session.step = "empresa"; await sendText(from, COPY.lead_empresa); return res.sendStatus(200); }
    }

    // === TEXTO ===
    if (type === "text") {
      if (session.step === "empresa") {
        session.data.empresa = body;
        if (session.rol === "logistica") {
          await recordLead({ wa_id: from, rol: session.rol, empresa: session.data.empresa, segment: session.segment, choferes: session.choferes, facturacion: session.facturacion });
          await sendText(from, COPY.gracias);
          await sendLinkButton(from, "👉 Abrí este botón para hablar con un asesor:", LINKS.asesor, "Hablar con asesor");
          resetSession(from);
        } else {
          session.step = "email";
          await sendText(from, COPY.lead_email);
        }
        return res.sendStatus(200);
      }
      if (session.step === "email") {
        const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body);
        if (!ok) { await sendText(from, COPY.email_inval); return res.sendStatus(200); }
        session.data.email = body;
        await recordLead({ wa_id: from, rol: session.rol, empresa: session.data.empresa, email: session.data.email, segment: session.segment, mejora: session.mejora });
        await sendText(from, COPY.gracias);
        await sendLinkButton(from, "👉 Abrí este botón para hablar con un asesor:", LINKS.asesor, "Hablar con asesor");
        resetSession(from);
        return res.sendStatus(200);
      }
      if (["hola","menu","menú","inicio","start"].includes(body.toLowerCase())) {
        resetSession(from);
        await sendWelcome(from);
        return res.sendStatus(200);
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("💥 Webhook error:", e);
    return res.sendStatus(200);
  }
});

/* ============ Start ============ */
app.listen(PORT, () => {
  console.log(`🚀 Zupply Bot en http://localhost:${PORT}`);
  console.log("📞 PHONE_NUMBER_ID:", PHONE_NUMBER_ID || "(vacío)");
  console.log("📄 Google Sheets:", GOOGLE_SHEETS_ID ? "ON" : "OFF");
});
