// index.js – Zupply Bot (Logística, Vendedor y Otros servicios) – v5
// - Botones ≤20 chars (máx 3 por mensaje)
// - Listas para preguntas con 4 opciones
// - Menú: "Soy Logística" / "Soy Vendedor" / "+ Servicios"
// - LOGÍSTICA: Choferes (2–10 / 11–20 / +20) → Facturación (Viaje / Excel / Sistema) → Volumen (0–100 / 100–300 / 300+) → Empresa (SIN email) → guarda
// - VENDEDOR: Volumen (0–10 / 11–30 / +30) → Mejora (lista) → Empresa + Email → guarda
// - SERVICIOS: Lista para elegir servicio → Empresa + Email → guarda
// - Asesor con botón-URL vía TEMPLATE (sin pegar link); fallback discreto
// - Guardado en Google Sheets (ID de tu archivo y pestaña "Hoja 1")

import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { google } from "googleapis";
// import { fetch } from "undici"; // descomentá si usás Node < 18

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

// Template con botón-URL (crealo/aprobalo en Meta)
const ADVISOR_TEMPLATE_NAME = (process.env.ADVISOR_TEMPLATE_NAME || "asesor_zupply").trim();
// Si tu template es dinámico (https://wa.me/{{1}}) se usa este parámetro:
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

/* ========= Sesiones (TTL) ========= */
/**
 * sessions[wa_id] = {
 *   rol: "logistica"|"vendedor"|"servicios"|null,
 *   step: string|null,
 *   // volúmenes
 *   segment: string|null, // ej logi: seg_0_100 / vta: vta_0_10 / servicios: srv_xxx
 *   // logística
 *   mejora_logi: "orden"|"choferes"|"rendiciones"|"facturacion"|null,
 *   choferes: "2_10"|"11_20"|"20_plus"|null,
 *   facturacion: "viaje"|"excel"|"sistema"|null,
 *   // vendedor
 *   mejora_vta: "costos"|"tiempos"|"devol"|"seguimiento"|null,
 *   // servicios (selección)
 *   servicio: "bot"|"auto"|"stock"|"dash"|"web"|"fisica"|null,
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
  // WhatsApp: 1–3 botones, título máx 20 chars
  const norm = buttons.slice(0, 3).map(b => {
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
// Lista interactiva (hasta 10 items)
function sendList(to, headerText, bodyText, rows) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: headerText },
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
// Template con botón URL (soporta URL dinámica {{1}})
async function sendAdvisorTemplate(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: ADVISOR_TEMPLATE_NAME,
      language: { code: "es" },
      components: [
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: ADVISOR_WA_PARAM }]
        }
      ]
    },
  });
}

/* ========= Copy (con *negrita* y _cursiva_) ========= */
const COPY = {
  bienvenida:
    "👋 ¡Hola! Soy el asistente de *Zupply*.\n" +
    "Te ayudamos a ordenar tu operación logística: *datos claros*, *control de flota* y *visibilidad* en tiempo real.\n\n" +
    "_Primero, contame qué buscás:_",
  cta_principal: "Elegí una opción:",
  otros_servicios_texto:
    "🧰 *Otros servicios Zupply*\n" +
    "• 🤖 *Bot de WhatsApp*\n" +
    "• ⚙️ *Automatización de procesos*\n" +
    "• 📦 *Gestión de Inventario*\n" +
    "• 📊 *Analytics & Reportes*\n" +
    "• 🛍️ *Tienda Web*\n" +
    "• 🏬 *Digitalización de tienda física*",
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
    { id: "rol_vta",  title: "🧑‍💼 Soy Vendedor" },
    { id: "rol_srv",  title: "🧰 + Servicios" },
  ]);
}

/* LOGÍSTICA — preguntas con icono y negrita */
function btnLogiMejora(to) {
  return sendList(
    to,
    "🧰 *¿Qué querés mejorar?*",
    "Elegí una opción:",
    [
      { id: "logi_mej_orden",       title: "🟩 Orden flota" },
      { id: "logi_mej_choferes",    title: "🟩 Control chofer" },
      { id: "logi_mej_rendiciones", title: "🟩 Rendiciones" },
      { id: "logi_mej_fact",        title: "🟩 Facturación" }
    ]
  );
}
function btnLogiChoferes(to) {
  // 2–10 / 11–20 / +20
  return sendButtons(to, "🧑‍✈️ *¿Cuántos choferes?*", [
    { id: "logi_ch_2_10",  title: "2–10" },
    { id: "logi_ch_11_20", title: "11–20" },
    { id: "logi_ch_20p",   title: "+20" },
  ]);
}
function btnLogiFacturacion(to) {
  // Por viaje / Excel / Sistema Gestión
  return sendButtons(to, "🧾 *¿Cómo facturás?*", [
    { id: "logi_fac_viaje",  title: "Por viaje" },
    { id: "logi_fac_excel",  title: "Excel" },
    { id: "logi_fac_sis",    title: "Sistema Gestión" },
  ]);
}
function btnVolumenLogi(to) {
  return sendButtons(to, "📦 *¿Volumen diario?*", [
    { id: "seg_0_100",   title: "0–100" },
    { id: "seg_100_300", title: "100–300" },
    { id: "seg_300",     title: "300+" },
  ]);
}

/* VENDEDOR — sin rubro, primero volúmenes 0–10 / 11–30 / +30 */
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
    "🧯 *¿Qué querés mejorar?*",
    "Elegí una opción:",
    [
      { id: "vta_costos",      title: "💵 Costos" },
      { id: "vta_tiempos",     title: "⏱️ Tiempos" },
      { id: "vta_devol",       title: "↩️ Devoluciones" },
      { id: "vta_seguimiento", title: "📍 Seguimiento" }
    ]
  );
}

/* SERVICIOS — lista seleccionable */
function servicesList(to) {
  return sendList(
    to,
    "🧰 *Otros servicios Zupply*",
    "Elegí el que más te interese:",
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
    mejora_vta, servicio, empresa, email, origen_registro = "Zupply Ventas"
  } = row;
  await appendToSheet([
    ts, wa_id, rol || "", segment || "",
    mejora_logi || "", choferes || "", facturacion || "",
    "" /* rubro eliminado */, mejora_vta || "",
    servicio || "",
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
        if (id === "rol_vta")  { session.rol = "vendedor";  session.step = "vta_volumen"; await btnVolumenVta(from);  continue; }
        if (id === "rol_srv")  { session.rol = "servicios"; session.step = "srv_list";     await servicesList(from);  continue; }

        // LOGÍSTICA
        if (["logi_mej_orden","logi_mej_choferes","logi_mej_rendiciones","logi_mej_fact"].includes(id)) {
          session.mejora_logi = id.replace("logi_mej_","").replace("fact","facturacion");
          session.step = "logi_choferes";
          await btnLogiChoferes(from);
          continue;
        }
        if (["logi_ch_2_10","logi_ch_11_20","logi_ch_20p"].includes(id)) {
          session.choferes = id === "logi_ch_2_10" ? "2_10" : id === "logi_ch_11_20" ? "11_20" : "20_plus";
          session.step = "logi_facturacion";
          await btnLogiFacturacion(from);
          continue;
        }
        if (["logi_fac_viaje","logi_fac_excel","logi_fac_sis"].includes(id)) {
          session.facturacion = id === "logi_fac_viaje" ? "viaje" : id === "logi_fac_excel" ? "excel" : "sistema";
          session.step = "logi_volumen";
          await btnVolumenLogi(from);
          continue;
        }
        if (["seg_0_100","seg_100_300","seg_300"].includes(id)) {
          session.segment = id;
          session.step = "lead_empresa";          // LOGÍSTICA: solo empresa
          await sendText(from, COPY.lead_empresa);
          continue;
        }

        // VENDEDOR
        if (["vta_seg_0_10","vta_seg_11_30","vta_seg_30p"].includes(id)) {
          session.segment = id;
          session.step = "vta_mejora";
          await btnMejoraVta(from);
          continue;
        }
        if (["vta_costos","vta_tiempos","vta_devol","vta_seguimiento"].includes(id)) {
          session.mejora_vta = id.replace("vta_","");
          session.step = "lead_empresa";          // VENDEDOR: empresa -> email
          await sendText(from, COPY.lead_empresa);
          continue;
        }

        // SERVICIOS: selección → empresa -> email
        if (["srv_bot","srv_auto","srv_stock","srv_dash","srv_web","srv_fisica"].includes(id)) {
          session.servicio = id.replace("srv_","");
          session.step = "lead_empresa";
          await sendText(from, COPY.lead_empresa);
          continue;
        }

        // CTAs
        if (id === "cta_volver") { resetSession(from); await sendWelcome(from); continue; }
        if (id === "cta_demo")   { await sendText(from, "🗓️ Coordinemos una demo."); await btnCTAs(from); continue; }
        if (id === "cta_asesor") {
          const ok = await sendAdvisorTemplate(from);
          if (!ok) await sendText(from, "👤 *Listo.* Un asesor te va a escribir por este chat en minutos.");
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

        // Atajos por intención en texto libre
        if (body.includes("soy logistica") || body.includes("soy logística") || body.includes("tengo una logistica")) {
          session.rol = "logistica";
          session.step = "logi_mejora";
          await btnLogiMejora(from);
          continue;
        }
        if (body.includes("soy vendedor")) {
          session.rol = "vendedor";
          session.step = "vta_volumen";
          await btnVolumenVta(from);
          continue;
        }
        if (body.includes("servicio") || body.includes("+ servicios")) {
          session.rol = "servicios";
          session.step = "srv_list";
          await servicesList(from);
          continue;
        }

        // Lead → empresa (LOGÍSTICA: guarda; VENDEDOR/SERVICIOS: pide email)
        if (session.step === "lead_empresa") {
          session.data.empresa = raw;

          if (session.rol === "logistica") {
            // Guardar sin email
            try {
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
              });
            } catch {}
            await sendText(from, COPY.gracias);
            resetSession(from);
            await btnCTAs(from);
          } else {
            session.step = "lead_email";
            await sendText(from, COPY.lead_email);
          }
          continue;
        }

        // Lead → email + guardar (VENDEDOR / SERVICIOS)
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
              mejora_vta: session.mejora_vta,
              servicio: session.servicio,
              empresa: session.data.empresa,
              email,
            });
          } catch {}

          await sendText(from, COPY.gracias);
          resetSession(from);
          await btnCTAs(from);
          continue;
        }

        // Atajos comunes
        if (body.includes("asesor")) {
          const ok = await sendAdvisorTemplate(from);
          if (!ok) await sendText(from, "👤 *Listo.* Un asesor te contacta por acá.");
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
  console.log("🔗 Template asesor:", ADVISOR_TEMPLATE_NAME, "| param:", ADVISOR_WA_PARAM);
});
