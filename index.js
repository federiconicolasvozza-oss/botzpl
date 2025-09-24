// index.js — Zupply Bot (v6) — listo para copiar/pegar

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

// Google Sheets (SIEMPRE string)
const GOOGLE_SHEETS_ID = (process.env.GOOGLE_SHEETS_ID || "14B7OvEJ3TWloCHRhuCVbIVWHWkAaoSVyL0Cf6NCnXbM").trim();
// Nombres de pestañas
const TAB_NAMES = {
  logistica: (process.env.TAB_LOGISTICA || "Logistica").trim(),
  vendedor:  (process.env.TAB_VENDEDOR  || "Vendedor").trim(),
  servicios: (process.env.TAB_SERVICIOS || "Servicios").trim(),
};

// Template botón-URL de asesor (recomendado URL dinámica https://wa.me/{{1}})
const ADVISOR_TEMPLATE_NAME = (process.env.ADVISOR_TEMPLATE_NAME || "asesor_zupply").trim();
const ADVISOR_WA_PARAM = (process.env.ADVISOR_WA_PARAM || "5491137829642").trim();

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
 * sessions[wa_id] = { rol, step, segment, mejora_logi, choferes, facturacion, mejora_vta, servicio, data:{empresa,email} }
 */
const sessions = new Map();
function getSession(wa_id) {
  if (!sessions.has(wa_id)) sessions.set(wa_id, { rol: null, step: "inicio", data: {} });
  return sessions.get(wa_id);
}
function resetSession(wa_id) { sessions.delete(wa_id); }

/* ========= WhatsApp helpers ========= */
async function sendMessage(payload) {
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("❌ Error enviando mensaje:", res.status, txt);
  }
  return res.ok;
}

function sendText(to, body) {
  return sendMessage({ messaging_product: "whatsapp", to, type: "text", text: { body } });
}

function sendButtons(to, text, buttons) {
  // Máx 3 botones; títulos ≤ 20 chars
  const norm = buttons.slice(0, 3).map(({ id, title }) => ({
    type: "reply",
    reply: { id, title: String(title).slice(0, 20) },
  }));
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: { type: "button", body: { text }, action: { buttons: norm } },
  });
}

// Lista interactiva (header SIN markdown; body puede llevar negrita)
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
        sections: [{
          title: "Opciones",
          rows: rows.map(r => ({
            id: r.id,
            title: (r.title || "").slice(0, 24),
            description: r.desc || ""
          }))
        }]
      }
    }
  });
}

// Botón asesor vía TEMPLATE con URL
async function sendAdvisorTemplate(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: ADVISOR_TEMPLATE_NAME,
      language: { code: "es" },
      components: [{
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: ADVISOR_WA_PARAM }]
      }]
    }
  });
}

/* ========= Copy ========= */
const COPY = {
  bienvenida:
    "👋 ¡Hola! Soy el asistente de *Zupply*.\n" +
    "Te ayudamos a ordenar tu operación logística: *datos claros*, *control de flota* y *visibilidad* en tiempo real.\n\n" +
    "_Primero, contame qué buscás:_",
  cta_principal: "Elegí una opción:",
  lead_empresa: "🏢 Decime el *nombre de tu empresa*.",
  lead_email: "📧 Ahora un *email* de contacto.",
  email_inval: "⚠️ Ese email no parece válido. Probá de nuevo.",
  gracias: "✅ ¡Gracias! Te contactamos a la brevedad.",
};

/* ========= UI builders ========= */
async function sendWelcome(to) {
  await sendText(to, COPY.bienvenida);
  return sendButtons(to, COPY.cta_principal, [
    { id: "rol_logi", title: "🚚 Soy Logística" },
    { id: "rol_vta",  title: "🧑‍💼 Vendedor" },
    { id: "rol_srv",  title: "🧰 + Servicios" },
  ]);
}

// LOGÍSTICA
function btnLogiMejora(to) {
  return sendList(
    to,
    "🧰 ¿Qué querés mejorar?",
    "*Elegí una opción:*",
    [
      { id: "logi_mej_orden",       title: "🟩 Orden flota" },
      { id: "logi_mej_choferes",    title: "🟩 Control chofer" },
      { id: "logi_mej_rendiciones", title: "🟩 Rendiciones" },
      { id: "logi_mej_fact",        title: "🟩 Facturación" }
    ]
  );
}
function btnLogiChoferes(to) {
  return sendButtons(to, "🧑‍✈️ *¿Cuántos choferes?*", [
    { id: "logi_ch_2_10",  title: "2–10" },
    { id: "logi_ch_11_20", title: "11–20" },
    { id: "logi_ch_20p",   title: "+20" },
  ]);
}
function btnLogiFacturacion(to) {
  return sendButtons(to, "🧾 *¿Cómo facturás?*", [
    { id: "logi_fac_viaje", title: "Por viaje" },
    { id: "logi_fac_excel", title: "Excel" },
    { id: "logi_fac_sis",   title: "Sistema Gest." },
  ]);
}
function btnVolumenLogi(to) {
  return sendButtons(to, "📦 *¿Volumen diario?*", [
    { id: "seg_0_100",   title: "0–100" },
    { id: "seg_100_300", title: "100–300" },
    { id: "seg_300",     title: "300+" },
  ]);
}

// VENDEDOR
function btnVolumenVta(to) {
  return sendButtons(to, "📦 *¿Paquetes por día?*", [
    { id: "vta_seg_0_10",  title: "0–10" },
    { id: "vta_seg_11_30", title: "11–30" },
    { id: "vta_seg_30p",   title: "+30" },
  ]);
}
function btnMejoraVta(to) {
  return sendList(
    to,
    "🧯 ¿Qué querés mejorar?",
    "*Elegí una opción:*",
    [
      { id: "vta_costos",      title: "💵 Costos" },
      { id: "vta_tiempos",     title: "⏱️ Tiempos" },
      { id: "vta_devol",       title: "↩️ Devoluciones" },
      { id: "vta_seguimiento", title: "📍 Seguimiento" }
    ]
  );
}

// SERVICIOS
function servicesList(to) {
  return sendList(
    to,
    "🧰 Otros servicios Zupply",
    "*Elegí el que más te interese:*",
    [
      { id: "srv_bot",    title: "🤖 Bot WhatsApp" },
      { id: "srv_auto",   title: "⚙️ Automatización" },
      { id: "srv_stock",  title: "📦 Inventario" },
      { id: "srv_dash",   title: "📊 Analytics" },
      { id: "srv_web",    title: "🛍️ Tienda Web" },
      { id: "srv_fisica", title: "🏬 Tienda Física" },
    ]
  );
}

/* ========= Google Sheets ========= */
function hasGoogle() {
  try { fs.accessSync(CLIENT_PATH); fs.accessSync(TOKEN_PATH); return Boolean(GOOGLE_SHEETS_ID); } catch { return false; }
}
function getOAuthClient() {
  const { installed } = JSON.parse(fs.readFileSync(CLIENT_PATH, "utf-8"));
  const { client_id, client_secret, redirect_uris } = installed;
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0] || "http://127.0.0.1");
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  oauth2.setCredentials(tokens);
  return oauth2;
}
async function appendToSheetCustom(sheetName, values) {
  if (!hasGoogle()) return;
  const auth = getOAuthClient();
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEETS_ID, // <-- STRING SIEMPRE
    range: `${sheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}
async function recordLead(row) {
  const ts = new Date().toISOString();
  const {
    wa_id, rol, segment, mejora_logi, choferes, facturacion,
    mejora_vta, servicio, empresa, email, origen_registro = "Zupply Ventas"
  } = row;

  const values = [
    ts, wa_id, rol || "", segment || "",
    (mejora_logi || ""), (choferes || ""), (facturacion || ""),
    (mejora_vta || ""), (servicio || ""),
    (empresa || ""), (email || ""), origen_registro
  ];

  let tab = "Logistica";
  if (rol === "vendedor")  tab = TAB_NAMES.vendedor;
  else if (rol === "servicios") tab = TAB_NAMES.servicios;
  else tab = TAB_NAMES.logistica;

  try {
    await appendToSheetCustom(tab, values);
  } catch (err) {
    console.error("❌ Error Google Sheets:", err?.response?.data || err);
  }
}

/* ========= Webhook Verify ========= */
app.get("/webhook", (req, res) => {
  const mode = String(req.query["hub.mode"] || "");
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.get("/health", (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ========= Webhook Events ========= */
app.post("/webhook", async (req, res) => {
  try {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!change) return res.sendStatus(200);
    if (Array.isArray(change.statuses) && change.statuses.length > 0) return res.sendStatus(200);

    const msg = change?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const type = msg.type;
    const session = getSession(from);

    // ----- INTERACTIVE -----
    if (type === "interactive") {
      const id = msg?.interactive?.button_reply?.id || msg?.interactive?.list_reply?.id || null;
      if (!id) { await sendWelcome(from); return res.sendStatus(200); }

      // Menú
      if (id === "rol_logi") { session.rol = "logistica"; session.step = "logi_mejora"; await btnLogiMejora(from); return res.sendStatus(200); }
      if (id === "rol_vta")  { session.rol = "vendedor";  session.step = "vta_volumen"; await btnVolumenVta(from);  return res.sendStatus(200); }
      if (id === "rol_srv")  { session.rol = "servicios"; session.step = "srv_list";     await servicesList(from);  return res.sendStatus(200); }

      // LOGÍSTICA
      if (["logi_mej_orden","logi_mej_choferes","logi_mej_rendiciones","logi_mej_fact"].includes(id)) {
        session.mejora_logi = id.replace("logi_mej_","").replace("fact","facturacion");
        session.step = "logi_choferes";
        await btnLogiChoferes(from);
        return res.sendStatus(200);
      }
      if (["logi_ch_2_10","logi_ch_11_20","logi_ch_20p"].includes(id)) {
        session.choferes = id === "logi_ch_2_10" ? "2_10" : id === "logi_ch_11_20" ? "11_20" : "20_plus";
        session.step = "logi_facturacion";
        await btnLogiFacturacion(from);
        return res.sendStatus(200);
      }
      if (["logi_fac_viaje","logi_fac_excel","logi_fac_sis"].includes(id)) {
        session.facturacion = id === "logi_fac_viaje" ? "viaje" : id === "logi_fac_excel" ? "excel" : "sistema";
        session.step = "logi_volumen";
        await btnVolumenLogi(from);
        return res.sendStatus(200);
      }
      if (["seg_0_100","seg_100_300","seg_300"].includes(id)) {
        session.segment = id;
        session.step = "lead_empresa"; // SIN email para logística
        await sendText(from, COPY.lead_empresa);
        return res.sendStatus(200);
      }

      // VENDEDOR
      if (["vta_seg_0_10","vta_seg_11_30","vta_seg_30p"].includes(id)) {
        session.segment = id;
        session.step = "vta_mejora";
        await btnMejoraVta(from);
        return res.sendStatus(200);
      }
      if (["vta_costos","vta_tiempos","vta_devol","vta_seguimiento"].includes(id)) {
        session.mejora_vta = id.replace("vta_","");
        session.step = "lead_empresa";
        await sendText(from, COPY.lead_empresa);
        return res.sendStatus(200);
      }

      // SERVICIOS
      if (["srv_bot","srv_auto","srv_stock","srv_dash","srv_web","srv_fisica"].includes(id)) {
        session.servicio = id.replace("srv_","");
        session.step = "lead_empresa";
        await sendText(from, COPY.lead_empresa);
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    // ----- TEXT -----
    if (type === "text") {
      const raw = (msg.text?.body || "").trim();
      const body = raw.toLowerCase();

      if (["hola","menu","menú","inicio","start","ayuda"].includes(body)) {
        resetSession(from); await sendWelcome(from); return res.sendStatus(200);
      }

      // Lead → empresa
      if (session.step === "lead_empresa") {
        session.data.empresa = raw;

        if (session.rol === "logistica") {
          // guarda sin email
          await recordLead({
            wa_id: from,
            rol: session.rol,
            segment: session.segment,
            mejora_logi: session.mejora_logi,
            choferes: session.choferes,
            facturacion: session.facturacion,
            empresa: session.data.empresa,
          });
          await sendText(from, COPY.gracias);
          const ok = await sendAdvisorTemplate(from);
          if (!ok) await sendText(from, "👤 *Listo.* Un asesor te va a escribir por este chat.");
          resetSession(from);
          return res.sendStatus(200);
        } else {
          session.step = "lead_email";
          await sendText(from, COPY.lead_email);
          return res.sendStatus(200);
        }
      }

      // Lead → email (Vendedor/Servicios)
      if (session.step === "lead_email") {
        const email = raw;
        const okMail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        if (!okMail) { await sendText(from, COPY.email_inval); return res.sendStatus(200); }
        session.data.email = email;

        await recordLead({
          wa_id: from,
          rol: session.rol,
          segment: session.segment,
          mejora_logi: session.mejora_logi,
          choferes: session.choferes,
          facturacion: session.facturacion,
          mejora_vta: session.mejora_vta,
          servicio: session.servicio,
          empresa: session.data.empresa,
          email,
        });

        await sendText(from, COPY.gracias);
        const ok = await sendAdvisorTemplate(from);
        if (!ok) await sendText(from, "👤 *Listo.* Un asesor te va a escribir por este chat.");
        resetSession(from);
        return res.sendStatus(200);
      }

      // Si escribe “asesor”
      if (body.includes("asesor")) {
        const ok = await sendAdvisorTemplate(from);
        if (!ok) await sendText(from, "👤 *Listo.* Un asesor te contacta por acá.");
        return res.sendStatus(200);
      }

      // Fallback
      await sendWelcome(from);
      return res.sendStatus(200);
    }

    // Otros tipos → menú
    await sendWelcome(from);
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
  console.log("📄 Google Sheets:", GOOGLE_SHEETS_ID ? `ON (${GOOGLE_SHEETS_ID})` : "OFF");
  console.log("🗂️ Tabs:", TAB_NAMES);
  console.log("🔗 Template asesor:", ADVISOR_TEMPLATE_NAME, "| param:", ADVISOR_WA_PARAM);
});
