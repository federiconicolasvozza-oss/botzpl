// index.js – Bot Zupply (Q&A con roles Transportista/Cliente)
// Mantiene tu base: Express + webhook + sesiones + botones/listas

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

// Google Sheets opcional (para registrar leads)
const GOOGLE_SHEETS_ID = (process.env.GOOGLE_SHEETS_ID || "").trim();
const TAB_LEADS = (process.env.TAB_LEADS || "Leads").trim();

/* ========= Rutas de credenciales opcionales ========= */
function chooseCredPath(filename) {
  const fromSecrets = path.join("/etc/secrets", filename); // Render Secret Files
  const fromRepo = path.join(process.cwd(), "credentials", filename); // Repo
  try { fs.accessSync(fromSecrets); return fromSecrets; } catch {}
  return fromRepo;
}
const CLIENT_PATH = chooseCredPath("oauth_client.json");
const TOKEN_PATH  = chooseCredPath("oauth_token.json");

/* ============ Estado en memoria por usuario ============ */
/**
 * sessions[wa_id] = {
 *   step: null | "lead_empresa" | "lead_email",
 *   role: null | "transportista" | "cliente",
 *   data: { empresa?: string, email?: string }
 * }
 */
const sessions = new Map();
function getSession(wa_id) {
  if (!sessions.has(wa_id)) sessions.set(wa_id, { step: null, role: null, data: {} });
  return sessions.get(wa_id);
}

/* ============ Helpers WhatsApp ============ */
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

function sendList(to, { header = "Zupply", body, buttonText, sections }) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: header },
      body: { text: body },
      footer: { text: "zupply.tech" },
      action: { button: buttonText, sections },
    },
  });
}

/* ====== Mensajes base (editables) ====== */
const LINKS = {
  web: "https://zupply.tech/",
  mail: "hola@zupply.tech",
  demo: "https://zupply.tech/", // actualizá si tenés URL de agenda
};

const COPY = {
  bienvenida:
    "👋 ¡Hola! Bienvenido/a a *Zupply*. Centralizamos tus envíos, " +
    "automatizamos la ingesta y te damos visibilidad total. ¿Cómo te ayudamos hoy?",
  pedirRol: "Elegí una opción para continuar:",
  seguimientoNoDisponible:
    "📦 *Seguimiento por WhatsApp*\nAún no está disponible esta opción. " +
    "Muy pronto podrás consultar el estado de tus envíos por aquí. 🙌",
  asesorCTA:
    "¿Querés que te contacte un asesor? Decime *el nombre de tu empresa* y luego un *email*.",
  emailInvalido: "⚠️ Ese email no parece válido. Probá de nuevo.",
  graciasLead: "✅ ¡Gracias! Un asesor te escribirá a la brevedad.",
  fallback:
    "No tengo una respuesta exacta para eso 🤔. Te puedo derivar con un asesor o ver otras opciones del menú.",
};

/* ====== Contenidos por rol ====== */
// Transportista
const TRANSP = {
  intro:
    "🚚 *Soy transportista*\n" +
    "Podemos integrarnos a tu operación para automatizar la *ingesta de pedidos*, " +
    "normalizar datos y asignar envíos con visibilidad en tiempo real.",
  integraciones:
    "🔌 *Integraciones*\n" +
    "• Ingesta automática desde QR/CSV y marketplaces\n" +
    "• API + Webhooks para sincronización bidireccional\n" +
    "• Listas de precios por cliente y reglas por zona\n" +
    "• Panel de asignación y mapa interactivo\n\n" +
    "¿Querés que veamos tu caso? Podés hablar con un asesor.",
  comoFunciona:
    "⚙️ *¿Cómo funciona?*\n" +
    "1) Ingesta de pedidos (evitás carga manual)\n" +
    "2) Normalización y validaciones en tiempo real\n" +
    "3) Asignación por reglas/zonas o mapa\n" +
    "4) Reportes y trazabilidad punta a punta\n",
  requisitos:
    "🧩 *Requisitos técnicos*\n" +
    "• Token/API o archivo estándar (CSV/QR)\n" +
    "• Webhooks opcionales para eventos\n" +
    "• Onboarding guiado: empezás en días, no meses",
  beneficios:
    "✅ *Beneficios*\n" +
    "• Menos procesos manuales y errores\n" +
    "• Visibilidad total en tiempo real\n" +
    "• Escalabilidad sin sumar más planillas\n" +
    "• Reportes operativos y métricas de calidad",
};

// Cliente
const CLIENTE = {
  intro:
    "🧑‍💼 *Soy cliente*\n" +
    "Zupply te ayuda a ordenar logística y crecer: menos tareas manuales, más control y " +
    "mejor experiencia para tus clientes.",
  conocer:
    "🧭 *¿Qué es Zupply?*\n" +
    "Una plataforma para gestionar tus envíos en un solo lugar: carga automática, " +
    "asignación, seguimiento y reportes.",
  comoAyuda:
    "🎯 *¿Cómo me ayuda?*\n" +
    "• Ahorro de tiempo: menos planillas y coordinación\n" +
    "• Menos errores: validaciones y reglas\n" +
    "• Visibilidad: estado de cada envío al instante\n" +
    "• Decisiones: reportes y métricas",
  planes:
    "💵 *Planes y precios*\n" +
    "Trabajamos con planes según volumen y módulos (Emprendedor / Profesional / Enterprise).\n" +
    "Te cotizamos según tu operación y podemos agendar una demo.",
};

/* ============ Google Sheets opcional (Leads) ============ */
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
async function recordLead({ wa_id, empresa, email, origen = "Zupply Bot" }) {
  const ts = new Date().toISOString();
  await appendToSheet([ts, wa_id, empresa || "", email || "", origen]);
}

/* ============ UI (menús) ============ */
function sendWelcome(to) {
  return sendButtons(to, `${COPY.bienvenida}\n\n${COPY.pedirRol}`, [
    { id: "rol_transportista", title: "🚚 Soy transportista" },
    { id: "rol_cliente",       title: "🧑‍💼 Soy cliente" },
  ]);
}

function sendTransportistaMenu(to) {
  return sendList(to, {
    header: "Zupply – Transportistas",
    body: TRANSP.intro,
    buttonText: "Ver opciones",
    sections: [
      {
        title: "Información",
        rows: [
          { id: "t_integraciones",   title: "🔌 Integraciones" },
          { id: "t_como",            title: "⚙️ ¿Cómo funciona?" },
          { id: "t_requisitos",      title: "🧩 Requisitos técnicos" },
          { id: "t_beneficios",      title: "✅ Beneficios" },
        ],
      },
      {
        title: "Acciones",
        rows: [
          { id: "t_asesor",          title: "💬 Hablar con un asesor" },
          { id: "abrir_web",         title: "🌐 Abrir sitio" },
          { id: "volver_inicio",     title: "⬅️ Volver al inicio" },
        ],
      },
    ],
  });
}

function sendClienteMenu(to) {
  return sendList(to, {
    header: "Zupply – Clientes",
    body: CLIENTE.intro,
    buttonText: "Ver opciones",
    sections: [
      {
        title: "Información",
        rows: [
          { id: "c_conocer",         title: "🧭 Conocer el servicio" },
          { id: "c_como_ayuda",      title: "🎯 ¿Cómo me ayuda?" },
          { id: "c_planes",          title: "💵 Planes / Precios" },
          { id: "c_seguimiento",     title: "📦 ¿Dónde está mi envío?" },
        ],
      },
      {
        title: "Acciones",
        rows: [
          { id: "c_asesor",          title: "💬 Hablar con un asesor" },
          { id: "abrir_web",         title: "🌐 Abrir sitio" },
          { id: "volver_inicio",     title: "⬅️ Volver al inicio" },
        ],
      },
    ],
  });
}

/* ============ Webhook Verify (GET) ============ */
app.get("/webhook", (req, res) => {
  const mode = String(req.query["hub.mode"] || "");
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* ============ Health simple ============ */
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

    // === INTERACTIVE: botones o listas ===
    if (type === "interactive") {
      const btn = msg?.interactive?.button_reply?.id;
      const list = msg?.interactive?.list_reply?.id;
      const id = btn || list;

      if (!id) {
        await sendWelcome(from);
        return res.sendStatus(200);
      }

      // Roles
      if (id === "rol_transportista") { session.role = "transportista"; await sendTransportistaMenu(from); return res.sendStatus(200); }
      if (id === "rol_cliente")       { session.role = "cliente";       await sendClienteMenu(from);      return res.sendStatus(200); }

      // Transportista opciones
      if (session.role === "transportista") {
        if (id === "t_integraciones")  { await sendText(from, TRANSP.integraciones); await sendTransportistaMenu(from); return res.sendStatus(200); }
        if (id === "t_como")           { await sendText(from, TRANSP.comoFunciona); await sendTransportistaMenu(from); return res.sendStatus(200); }
        if (id === "t_requisitos")     { await sendText(from, TRANSP.requisitos);   await sendTransportistaMenu(from); return res.sendStatus(200); }
        if (id === "t_beneficios")     { await sendText(from, TRANSP.beneficios);   await sendTransportistaMenu(from); return res.sendStatus(200); }
        if (id === "t_asesor")         { await askLead(from, session);               return res.sendStatus(200); }
      }

      // Cliente opciones
      if (session.role === "cliente") {
        if (id === "c_conocer")     { await sendText(from, CLIENTE.conocer);     await sendClienteMenu(from); return res.sendStatus(200); }
        if (id === "c_como_ayuda")  { await sendText(from, CLIENTE.comoAyuda);   await sendClienteMenu(from); return res.sendStatus(200); }
        if (id === "c_planes")      { await sendText(from, CLIENTE.planes);      await sendClienteMenu(from); return res.sendStatus(200); }
        if (id === "c_seguimiento") { await sendText(from, COPY.seguimientoNoDisponible); await sendClienteMenu(from); return res.sendStatus(200); }
        if (id === "c_asesor")      { await askLead(from, session);              return res.sendStatus(200); }
      }

      // Acciones comunes
      if (id === "abrir_web")     { await sendText(from, `🌐 ${LINKS.web}`); await (session.role==="transportista"?sendTransportistaMenu(from):sendClienteMenu(from)); return res.sendStatus(200); }
      if (id === "volver_inicio") { sessions.delete(from); await sendWelcome(from); return res.sendStatus(200); }

      // Cualquier otro botón/lista
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
        await sendText(from, "📧 Perfecto. Decime un *email* de contacto.");
        return res.sendStatus(200);
      }
      if (session.step === "lead_email") {
        const email = (msg.text?.body || "").trim();
        const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        if (!ok) { await sendText(from, COPY.emailInvalido); return res.sendStatus(200); }
        session.data.email = email;
        try { await recordLead({ wa_id: from, empresa: session.data.empresa, email }); } catch {}
        await sendText(from, COPY.graciasLead);
        sessions.delete(from);
        await sendButtons(from, "¿Querés hacer algo más?", [
          { id: "rol_transportista", title: "🚚 Transportista" },
          { id: "rol_cliente",       title: "🧑‍💼 Cliente" },
          { id: "abrir_web",         title: "🌐 Abrir sitio" },
        ]);
        return res.sendStatus(200);
      }

      // Intenciones rápidas
      if (body.includes("envío") || body.includes("envio") || body.includes("seguimiento")) {
        await sendText(from, COPY.seguimientoNoDisponible);
        if (session.role === "transportista") await sendTransportistaMenu(from);
        else await sendClienteMenu(from);
        return res.sendStatus(200);
      }
      if (body.includes("asesor") || body.includes("contact")) {
        await askLead(from, session);
        return res.sendStatus(200);
      }

      // Fallback
      await sendText(from, COPY.fallback);
      await sendButtons(from, "¿Cómo seguimos?", [
        { id: "rol_transportista", title: "🚚 Transportista" },
        { id: "rol_cliente",       title: "🧑‍💼 Cliente" },
        { id: "c_asesor",          title: "💬 Hablar con asesor" },
      ]);
      return res.sendStatus(200);
    }

    // Otros tipos
    await sendWelcome(from);
    return res.sendStatus(200);
  } catch (e) {
    console.error("💥 Webhook error:", e);
    return res.sendStatus(200);
  }
});

/* ====== Helpers de flujo ====== */
async function askLead(to, session) {
  session.step = "lead_empresa";
  session.data = {};
  await sendText(to, `${COPY.asesorCTA}\n\n📧 ${LINKS.mail}`);
}

/* ============ Start ============ */
app.listen(PORT, () => {
  console.log(`🚀 Zupply Bot escuchando en http://localhost:${PORT}`);
  console.log("📞 PHONE_NUMBER_ID:", PHONE_NUMBER_ID || "(vacío)");
  console.log("📄 Credenciales usadas (Google opcional):", { CLIENT_PATH, TOKEN_PATH });
});

