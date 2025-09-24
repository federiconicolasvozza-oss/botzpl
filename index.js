// index.js — Zupply Bot con Google Sheets multi-pestaña (Logistica, Vendedor, Servicios)

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
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const API_VERSION = process.env.API_VERSION || "v23.0";

const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
const SINGLE_TAB = process.env.PRODUCT_MATRIX_TAB?.trim(); // si existe, se usa solo esa

const TAB_NAMES = {
  logistica: "Logistica",
  vendedor: "Vendedor",
  servicios: "Servicios",
};

/* ========= Credenciales Google ========= */
function chooseCredPath(filename) {
  const fromSecrets = path.join("/etc/secrets", filename);
  const fromRepo = path.join(process.cwd(), "credentials", filename);
  try { fs.accessSync(fromSecrets); return fromSecrets; } catch {}
  return fromRepo;
}
const SA_PATH     = chooseCredPath("service_account.json");
const CLIENT_PATH = chooseCredPath("oauth_client.json");
const TOKEN_PATH  = chooseCredPath("oauth_token.json");

function exists(f) { try { fs.accessSync(f); return true; } catch { return false; } }

async function getSheetsClient() {
  if (exists(SA_PATH)) {
    const sa = JSON.parse(fs.readFileSync(SA_PATH, "utf-8"));
    const jwt = new google.auth.JWT(sa.client_email, null, sa.private_key, [
      "https://www.googleapis.com/auth/spreadsheets"
    ]);
    await jwt.authorize();
    return google.sheets({ version: "v4", auth: jwt });
  }
  if (exists(CLIENT_PATH) && exists(TOKEN_PATH)) {
    const { installed } = JSON.parse(fs.readFileSync(CLIENT_PATH, "utf-8"));
    const { client_id, client_secret, redirect_uris } = installed;
    const oauth2 = new google.auth.OAuth2(
      client_id, client_secret, redirect_uris?.[0] || "http://127.0.0.1"
    );
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    oauth2.setCredentials(tokens);
    return google.sheets({ version: "v4", auth: oauth2 });
  }
  throw new Error("No hay credenciales para Google Sheets");
}

const HEADERS = [
  "Fecha ISO","WhatsApp ID","Rol","Segmento",
  "Mejora Logística","Choferes","Facturación",
  "Mejora Vendedor","Servicio","Empresa","Email","Origen"
];

async function ensureTab(sheets, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SHEETS_ID });
  const found = meta.data.sheets?.find(s => s.properties?.title === tabName);
  if (!found) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: GOOGLE_SHEETS_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${tabName}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [HEADERS] }
    });
    console.log(`🆕 Creada pestaña "${tabName}" con encabezados`);
  }
}

async function appendRow(tabName, values) {
  try {
    const sheets = await getSheetsClient();
    await ensureTab(sheets, tabName);
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${tabName}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [values] },
    });
    console.log(`✅ Guardado en "${tabName}"`);
  } catch (err) {
    console.error("❌ No se pudo guardar en Sheets:", err.message);
  }
}

/* ========= Sesiones ========= */
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
    console.error("❌ Error enviando mensaje:", res.status, await res.text());
  }
  return res.ok;
}
function sendText(to, body) {
  return sendMessage({ messaging_product: "whatsapp", to, type: "text", text: { body } });
}
function sendButtons(to, text, buttons) {
  const norm = buttons.slice(0, 3).map(({ id, title }) => ({
    type: "reply", reply: { id, title: String(title).slice(0, 20) }
  }));
  return sendMessage({
    messaging_product: "whatsapp",
    to, type: "interactive",
    interactive: { type: "button", body: { text }, action: { buttons: norm } },
  });
}

/* ========= Guardar lead ========= */
async function recordLead(data) {
  const ts = new Date().toISOString();
  const row = [
    ts, data.wa_id, data.rol || "", data.segment || "",
    data.mejora_logi || "", data.choferes || "", data.facturacion || "",
    data.mejora_vta || "", data.servicio || "",
    data.empresa || "", data.email || "", "Zupply Bot"
  ];

  if (SINGLE_TAB) {
    console.log("📝 Guardando en pestaña única:", SINGLE_TAB, row);
    return appendRow(SINGLE_TAB, row);
  }

  let tab = TAB_NAMES.logistica;
  if (data.rol === "vendedor") tab = TAB_NAMES.vendedor;
  else if (data.rol === "servicios") tab = TAB_NAMES.servicios;

  console.log("📝 Guardando en pestaña por rol:", tab, row);
  return appendRow(tab, row);
}

/* ========= Webhook endpoints ========= */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const msg = changes?.value?.messages?.[0];
  if (!msg) return res.sendStatus(200);

  const wa_id = msg.from;
  const text = msg.text?.body?.trim();
  const session = getSession(wa_id);

  // ejemplo simple: cuando finaliza, guardamos
  if (session.step === "fin") {
    await recordLead({ ...session.data, wa_id });
    resetSession(wa_id);
  }

  res.sendStatus(200);
});

/* ========= Start ========= */
app.listen(PORT, () => {
  console.log(`🚀 Zupply Bot en http://localhost:${PORT}`);
  console.log(`📞 PHONE_NUMBER_ID: ${PHONE_NUMBER_ID}`);
  console.log(`📄 GOOGLE_SHEETS_ID: ${GOOGLE_SHEETS_ID}`);
  console.log(SINGLE_TAB ? `🗂️ Sheet tab: ${SINGLE_TAB}` : "🗂️ Multi-pestaña activado");
});
