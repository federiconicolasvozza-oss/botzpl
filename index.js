// index.js — Zupply Bot (OAuth + Google Sheets single tab) — listo para tu repo
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import { google } from "googleapis";

dotenv.config();
const app = express();
app.use(express.json({ limit: "20mb" }));

/* ============== ENV ============== */
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "botconektar123").trim();
const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const API_VERSION = (process.env.API_VERSION || "v23.0").trim();

const GOOGLE_SHEETS_ID = (process.env.GOOGLE_SHEETS_ID || "").trim();
const SHEET_TAB = (process.env.PRODUCT_MATRIX_TAB || "Hoja 1").trim(); // una sola pestaña

/* ============== OAuth cred paths (raíz del repo o /etc/secrets) ============== */
function pickPath(filename) {
  const sec = `/etc/secrets/${filename}`;
  try { fs.accessSync(sec); return sec; } catch {}
  return `${process.cwd()}/${filename}`;
}
const OAUTH_CLIENT_PATH = pickPath("oauth_client.json");
const OAUTH_TOKEN_PATH  = pickPath("oauth_token.json");

/* ============== WhatsApp helpers ============== */
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
  // máx 3 botones, título ≤ 20 chars
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
function sendList(to, headerText, bodyText, rows) {
  // header SIN markdown (WhatsApp no lo permite)
  const clean = String(headerText || "").replace(/[*_~`]/g, "");
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: clean },
      body: { text: bodyText },
      action: {
        button: "Elegir",
        sections: [{
          title: "Opciones",
          rows: rows.map(r => ({
            id: r.id,
            title: String(r.title || "").slice(0, 24),
            description: r.desc || ""
          }))
        }]
      }
    }
  });
}

/* ============== Copy ============== */
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
  asesor_btn: "👤 Abrí este enlace para hablar con un asesor: https://wa.me/5491137829642"
};

/* ============== UI ============== */
async function sendWelcome(to) {
  await sendText(to, COPY.bienvenida);
  return sendButtons(to, COPY.cta_principal, [
    { id: "rol_logi", title: "🚚 Logística" },
    { id: "rol_vta",  title: "🧑‍💼 Vendedor" },
    { id: "rol_srv",  title: "🧰 Servicios" },
  ]);
}

// LOGÍSTICA
function listLogiMejora(to) {
  return sendList(
    to, "🧰 ¿Qué querés mejorar?", "*Elegí una opción:*",
    [
      { id: "logi_mej_orden",       title: "🟩 Orden flota" },
      { id: "logi_mej_choferes",    title: "🟩 Control chofer" },
      { id: "logi_mej_rendiciones", title: "🟩 Rendiciones" },
      { id: "logi_mej_fact",        title: "🟩 Facturación" },
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
function btnLogiFact(to) {
  return sendButtons(to, "🧾 *¿Cómo facturás?*", [
    { id: "logi_fac_viaje", title: "Por viaje" },
    { id: "logi_fac_excel", title: "Excel" },
    { id: "logi_fac_sis",   title: "Sistema" },
  ]);
}
function btnLogiVol(to) {
  return sendButtons(to, "📦 *¿Volumen diario?*", [
    { id: "seg_0_100",   title: "0–100" },
    { id: "seg_100_300", title: "100–300" },
    { id: "seg_300",     title: "300+" },
  ]);
}

// VENDEDOR
function btnVtaVol(to) {
  return sendButtons(to, "📦 *¿Paquetes por día?*", [
    { id: "vta_seg_0_10",  title: "0–10" },
    { id: "vta_seg_11_30", title: "11–30" },
    { id: "vta_seg_30p",   title: "+30" },
  ]);
}
function listVtaMejora(to) {
  return sendList(
    to, "🧯 ¿Qué querés mejorar?", "*Elegí una opción:*",
    [
      { id: "vta_costos",      title: "💵 Costos" },
      { id: "vta_tiempos",     title: "⏱️ Tiempos" },
      { id: "vta_devol",       title: "↩️ Devoluciones" },
      { id: "vta_seguimiento", title: "📍 Seguimiento" },
    ]
  );
}

// SERVICIOS
function listServicios(to) {
  return sendList(
    to, "🧰 Otros servicios Zupply", "*Elegí el que más te interese:*",
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

/* ============== Session ============== */
const sessions = new Map();
function sess(id) { if (!sessions.has(id)) sessions.set(id, { step: "inicio", rol: null, data: {} }); return sessions.get(id); }
function reset(id) { sessions.delete(id); }

/* ============== Google Sheets (OAuth) ============== */
function haveOAuth() {
  try { fs.accessSync(OAUTH_CLIENT_PATH); fs.accessSync(OAUTH_TOKEN_PATH); return true; } catch { return false; }
}
function getOAuthSheets() {
  if (!haveOAuth()) throw new Error("Faltan oauth_client.json / oauth_token.json");
  const { installed } = JSON.parse(fs.readFileSync(OAUTH_CLIENT_PATH, "utf-8"));
  const { client_id, client_secret, redirect_uris } = installed;
  const tokens = JSON.parse(fs.readFileSync(OAUTH_TOKEN_PATH, "utf-8"));
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0] || "http://127.0.0.1");
  oauth2.setCredentials(tokens);
  return google.sheets({ version: "v4", auth: oauth2 });
}
const HEADERS = [
  "Fecha ISO","WhatsApp ID","Rol","Segmento",
  "Mejora Logística","Choferes","Facturación",
  "Mejora Vendedor","Servicio","Empresa","Email","Origen"
];
async function ensureSheet() {
  const sheets = getOAuthSheets();
  // crea pestaña si no existe
  const meta = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SHEETS_ID });
  const found = meta.data.sheets?.find(s => s.properties?.title === SHEET_TAB);
  if (!found) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: GOOGLE_SHEETS_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_TAB } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [HEADERS] }
    });
    console.log(`🆕 Creada pestaña "${SHEET_TAB}" con encabezados`);
  } else {
    const r0 = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEETS_ID, range: `${SHEET_TAB}!A1:L1` });
    if (!r0.data.values || r0.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEETS_ID,
        range: `${SHEET_TAB}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [HEADERS] }
      });
    }
  }
  return sheets;
}
async function appendRow(values) {
  try {
    const sheets = await ensureSheet();
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [values] },
    });
    console.log("✅ Guardado en Sheets");
  } catch (err) {
    console.error("❌ No se pudo guardar en Sheets:", err?.response?.data || err?.message || err);
  }
}
async function recordLead({ wa_id, rol, segment, mejora_logi, choferes, facturacion, mejora_vta, servicio, empresa, email }) {
  const ts = new Date().toISOString();
  const row = [
    ts, wa_id, rol || "", segment || "",
    mejora_logi || "", choferes || "", facturacion || "",
    mejora_vta || "", servicio || "",
    empresa || "", email || "", "Zupply Ventas"
  ];
  await appendRow(row);
}

/* ============== Webhook verify ============== */
app.get("/webhook", (req, res) => {
  const mode = String(req.query["hub.mode"] || "");
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* ============== Webhook events ============== */
app.post("/webhook", async (req, res) => {
  try {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!change) return res.sendStatus(200);
    const msg = change?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const type = msg.type;
    const S = sess(from);

    // INTERACTIVE
    if (type === "interactive") {
      const id = msg?.interactive?.button_reply?.id || msg?.interactive?.list_reply?.id || null;
      if (!id) { await sendWelcome(from); return res.sendStatus(200); }

      // Menú
      if (id === "rol_logi") { S.rol = "logistica"; S.step = "logi_mejora"; await listLogiMejora(from); return res.sendStatus(200); }
      if (id === "rol_vta")  { S.rol = "vendedor";  S.step = "vta_vol";     await btnVtaVol(from);     return res.sendStatus(200); }
      if (id === "rol_srv")  { S.rol = "servicios"; S.step = "srv_list";    await listServicios(from); return res.sendStatus(200); }

      // LOGÍSTICA
      if (["logi_mej_orden","logi_mej_choferes","logi_mej_rendiciones","logi_mej_fact"].includes(id)) {
        S.mejora_logi = id.replace("logi_mej_","").replace("fact","facturacion");
        S.step = "logi_ch"; await btnLogiChoferes(from); return res.sendStatus(200);
      }
      if (["logi_ch_2_10","logi_ch_11_20","logi_ch_20p"].includes(id)) {
        S.choferes = id === "logi_ch_2_10" ? "2_10" : id === "logi_ch_11_20" ? "11_20" : "20_plus";
        S.step = "logi_fact"; await btnLogiFact(from);   return res.sendStatus(200);
      }
      if (["logi_fac_viaje","logi_fac_excel","logi_fac_sis"].includes(id)) {
        S.facturacion = id === "logi_fac_viaje" ? "viaje" : id === "logi_fac_excel" ? "excel" : "sistema";
        S.step = "logi_vol"; await btnLogiVol(from);     return res.sendStatus(200);
      }
      if (["seg_0_100","seg_100_300","seg_300"].includes(id)) {
        S.segment = id;
        S.step = "empresa"; // logística: solo empresa
        await sendText(from, COPY.lead_empresa);
        return res.sendStatus(200);
      }

      // VENDEDOR
      if (["vta_seg_0_10","vta_seg_11_30","vta_seg_30p"].includes(id)) {
        S.segment = id; S.step = "vta_mejora"; await listVtaMejora(from); return res.sendStatus(200);
      }
      if (["vta_costos","vta_tiempos","vta_devol","vta_seguimiento"].includes(id)) {
        S.mejora_vta = id.replace("vta_","");
        S.step = "empresa"; await sendText(from, COPY.lead_empresa); return res.sendStatus(200);
      }

      // SERVICIOS
      if (["srv_bot","srv_auto","srv_stock","srv_dash","srv_web","srv_fisica"].includes(id)) {
        S.servicio = id.replace("srv_","");
        S.step = "empresa"; await sendText(from, COPY.lead_empresa); return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    // TEXTO
    if (type === "text") {
      const raw = (msg.text?.body || "").trim();
      const lower = raw.toLowerCase();

      if (["hola","menu","menú","inicio","start","ayuda"].includes(lower)) {
        reset(from); await sendWelcome(from); return res.sendStatus(200);
      }

      if (S.step === "empresa") {
        S.data.empresa = raw;
        if (S.rol === "logistica") {
          await recordLead({
            wa_id: from, rol: S.rol, segment: S.segment,
            mejora_logi: S.mejora_logi, choferes: S.choferes, facturacion: S.facturacion,
            empresa: S.data.empresa
          });
          await sendText(from, COPY.gracias);
          await sendText(from, COPY.asesor_btn);
          reset(from);
        } else {
          S.step = "email";
          await sendText(from, COPY.lead_email);
        }
        return res.sendStatus(200);
      }

      if (S.step === "email") {
        const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
        if (!ok) { await sendText(from, COPY.email_inval); return res.sendStatus(200); }
        S.data.email = raw;

        await recordLead({
          wa_id: from, rol: S.rol, segment: S.segment,
          mejora_vta: S.mejora_vta, servicio: S.servicio,
          empresa: S.data.empresa, email: S.data.email
        });
        await sendText(from, COPY.gracias);
        await sendText(from, COPY.asesor_btn);
        reset(from);
        return res.sendStatus(200);
      }

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

/* ============== Health + Start ============== */
app.get("/health", (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`🚀 Zupply Bot en http://localhost:${PORT}`);
  console.log("📞 PHONE_NUMBER_ID:", PHONE_NUMBER_ID || "(vacío)");
  console.log("📄 GOOGLE_SHEETS_ID:", GOOGLE_SHEETS_ID || "(vacío)");
  console.log("🗂️ Sheet tab:", SHEET_TAB);
});
