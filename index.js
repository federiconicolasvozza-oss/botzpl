// index.js - Zupply Q&A Bot + WAME web button
// Reutiliza el formato de tus otros bots (Express + WhatsApp + Sheets)

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
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim(); // ID del nro de WhatsApp Business
const API_VERSION = "v23.0";

const GOOGLE_SHEETS_ID = (process.env.GOOGLE_SHEETS_ID || "").trim();
const LEADS_TAB = (process.env.LEADS_TAB || "ZupplyLeads").trim();

const BRAND = (process.env.BRAND || "Zupply").trim();
const WEBSITE_URL = (process.env.WEBSITE_URL || "https://zupply.tech").trim();
const PRICING_URL = (process.env.PRICING_URL || `${WEBSITE_URL}/#pricing`).trim();
const BOOKING_URL = (process.env.BOOKING_URL || "").trim(); // ej. Calendly/Meet
const SALES_EMAIL = (process.env.SALES_EMAIL || "hola@zupply.tech").trim();

// Para el botón web “wa.me”
const WAME_PHONE = (process.env.WAME_PHONE || "").trim(); // en formato internacional sin + ni 00 (ej. 5491122334455)
const WAME_DEFAULT_TEXT = (process.env.WAME_DEFAULT_TEXT || "¡Hola! Quiero información de Zupply.").trim();
const WAME_COLOR = (process.env.WAME_COLOR || "#25D366").trim();

/* ===================== Google OAuth (igual a tus otros bots) ===================== */
function chooseCredPath(filename) {
  const fromSecrets = path.join("/etc/secrets", filename); // Render Secret Files
  const fromRepo = path.join(process.cwd(), "credentials", filename); // En repo
  try { fs.accessSync(fromSecrets); return fromSecrets; } catch {}
  return fromRepo;
}
const CLIENT_PATH = chooseCredPath("oauth_client.json");
const TOKEN_PATH  = chooseCredPath("oauth_token.json");

function getOAuthClient() {
  const missing = [];
  try { fs.accessSync(CLIENT_PATH); } catch { missing.push(CLIENT_PATH); }
  try { fs.accessSync(TOKEN_PATH); }  catch { missing.push(TOKEN_PATH); }
  if (missing.length) {
    console.warn("⚠️ No se encuentran credenciales Google:", missing);
    throw new Error("Faltan credenciales de Google");
  }
  const { installed } = JSON.parse(fs.readFileSync(CLIENT_PATH, "utf-8"));
  const { client_id, client_secret, redirect_uris } = installed;
  const oauth2 = new google.auth.OAuth2(
    client_id, client_secret, redirect_uris?.[0] || "http://127.0.0.1"
  );
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  oauth2.setCredentials(tokens);
  return oauth2;
}
function hasGoogle() {
  try { fs.accessSync(CLIENT_PATH); fs.accessSync(TOKEN_PATH); return Boolean(GOOGLE_SHEETS_ID); }
  catch { return false; }
}
async function appendToSheetRange(a1, values) {
  if (!hasGoogle()) { console.warn("⚠️ Google deshabilitado (faltan credenciales o SHEET ID)"); return; }
  try {
    const auth = getOAuthClient();
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: a1,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [values] },
    });
  } catch (err) {
    console.error("❌ Error al escribir en Sheets:", err?.response?.data || err);
  }
}

/* ===================== Estado por usuario ===================== */
const sessions = new Map();
function getSession(wa_id) {
  if (!sessions.has(wa_id)) sessions.set(wa_id, { step: null, data: {} });
  return sessions.get(wa_id);
}

/* ===================== WhatsApp helpers ===================== */
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
  return sendMessage({ messaging_product: "whatsapp", to, type: "text", text: { body } });
}

/* ===================== UI (botones/listas) ===================== */
function sendMainMenu(to) {
  // Usamos "list" para más de 3 opciones
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: `Asistente ${BRAND}` },
      body: { text:
        `¡Hola! Soy el asistente de ${BRAND}.\n` +
        `¿Sobre qué te gustaría saber?`
      },
      action: {
        button: "Ver opciones",
        sections: [
          {
            title: "Información",
            rows: [
              { id: "q_quees", title: "¿Qué es Zupply?" },
              { id: "q_como", title: "¿Cómo funciona?" },
              { id: "q_casos", title: "Casos de uso" },
              { id: "q_integraciones", title: "Integraciones" },
              { id: "q_seguridad", title: "Seguridad & Datos" },
              { id: "q_faq", title: "Preguntas frecuentes" },
            ]
          },
          {
            title: "Acción",
            rows: [
              { id: "a_precios", title: "Ver precios / planes" },
              { id: "a_empezar", title: "Empezar ahora" },
              { id: "a_demo", title: "Hablar con un asesor" },
            ]
          }
        ]
      }
    }
  });
}

function sendAskLead(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Para contactarte, ¿nos dejás tu *nombre*, *empresa* y *email*?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "lead_si", title: "Sí, dejar datos" } },
          { type: "reply", reply: { id: "lead_no", title: "No por ahora" } },
        ],
      },
    },
  });
}

function sendQuickCTA(to) {
  const txt =
    `📌 Opciones rápidas:\n` +
    `• Precios: ${PRICING_URL}\n` +
    (BOOKING_URL ? `• Agenda demo: ${BOOKING_URL}\n` : "") +
    `• Web: ${WEBSITE_URL}\n` +
    `• Email: ${SALES_EMAIL}`;
  return sendText(to, txt);
}

/* ===================== Copy (editable) ===================== */
const COPY = {
  que_es:
`${BRAND} es una plataforma para digitalizar y automatizar procesos de compras/provisión con foco en simplicidad y velocidad.
Centraliza solicitudes, cotizaciones, aprobaciones y órdenes en un solo lugar, con visibilidad en tiempo real.`,

  como_funciona:
`1) Creás solicitudes/catálogo.\n2) Cotizás a proveedores o conectás integraciones.\n3) Aprobación por reglas.\n4) Generás órdenes y seguimiento.\n5) Reportes y control de gasto.`,

  casos:
`• Operaciones con alto volumen de compras\n• Equipos que necesitan trazabilidad y aprobaciones\n• Empresas que quieren reducir tiempos y costos en compras\n• Distribuidores / e-commerce B2B`,

  integraciones:
`APIs abiertas + conectores (ERP, contabilidad, e-commerce, BI). Podemos evaluar integraciones a medida según tu stack.`,

  seguridad:
`• Roles y permisos granulados\n• Logs y auditorías\n• Cifrado en tránsito y reposo\n• Mejores prácticas de protección de datos\n• Entornos separados por cliente`,

  faq:
`• ¿Tienen prueba? Sí: plan de inicio sin costo.\n• ¿Implementación? Guiada y simple.\n• ¿Soporte? Email y WhatsApp.\n• ¿Tiempo típico? Días/semanas según alcance.`,

  precios:
`Ofrecemos planes por niveles (Starter/Pro/Enterprise). Consultá precios y límites aquí:\n${PRICING_URL}`,

  empezar:
`Excelente 🙌 Podés comenzar ahora mismo desde la web:\n${WEBSITE_URL}\nSi querés, también coordinamos un onboarding con nuestro equipo.`,
};

/* ===================== Leads a Google Sheets ===================== */
async function recordLead({ wa_id, nombre, empresa, email, origen, motivo, nota }) {
  await appendToSheetRange(`${LEADS_TAB}!A1`, [
    new Date().toISOString(),
    wa_id || "",
    nombre || "",
    empresa || "",
    email || "",
    origen || "whatsapp",
    motivo || "",
    nota || "",
  ]);
}

/* ===================== Webhook VERIFY (GET) ===================== */
app.get("/webhook", (req, res) => {
  const mode = String(req.query["hub.mode"] || "");
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ WEBHOOK VERIFICADO");
    return res.status(200).send(challenge);
  }
  console.log("❌ Verificación rechazada");
  return res.sendStatus(403);
});

/* ===================== Webhook EVENTS (POST) ===================== */
app.post("/webhook", async (req, res) => {
  try {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const messages = change?.messages;
    if (!messages || messages.length === 0) return res.sendStatus(200);

    const msg = messages[0];
    const from = msg.from;
    const type = msg.type;
    const S = getSession(from);

    // Comandos globales
    if (type === "text") {
      const body = (msg.text?.body || "").trim().toLowerCase();
      if (["hola","menu","menú","inicio","start","zupply"].includes(body)) {
        sessions.delete(from);
        await sendMainMenu(from);
        return res.sendStatus(200);
      }
    }

    if (type === "interactive") {
      const btn = msg?.interactive?.button_reply?.id;
      const row = msg?.interactive?.list_reply?.id;

      const id = btn || row;

      // Menú principal
      if ([
        "q_quees","q_como","q_casos","q_integraciones","q_seguridad","q_faq",
        "a_precios","a_empezar","a_demo"
      ].includes(id)) {
        if (id === "q_quees")          await sendText(from, COPY.que_es);
        if (id === "q_como")           await sendText(from, COPY.como_funciona);
        if (id === "q_casos")          await sendText(from, COPY.casos);
        if (id === "q_integraciones")  await sendText(from, COPY.integraciones);
        if (id === "q_seguridad")      await sendText(from, COPY.seguridad);
        if (id === "q_faq")            await sendText(from, COPY.faq);
        if (id === "a_precios")        await sendText(from, COPY.precios);
        if (id === "a_empezar")        await sendText(from, COPY.empezar);

        if (id === "a_demo") {
          S.step = "lead_pre";
          await sendAskLead(from);
          return res.sendStatus(200);
        }

        // Después de responder, ofrezco menú/CTA
        await sendQuickCTA(from);
        await sendMainMenu(from);
        return res.sendStatus(200);
      }

      // Lead
      if (S.step === "lead_pre" && (id === "lead_si" || id === "lead_no")) {
        if (id === "lead_si") {
          S.step = "lead_wait";
          await sendText(from, "Perfecto. Enviame en un solo mensaje: *Nombre*, *Empresa*, *Email*.");
        } else {
          S.step = null;
          await sendText(from, `Sin problema. Si querés, escribinos a ${SALES_EMAIL} o pedí una demo cuando gustes.`);
          await sendMainMenu(from);
        }
        return res.sendStatus(200);
      }

      // Cualquier otro botón → menú
      await sendMainMenu(from);
      return res.sendStatus(200);
    }

    // TEXTO LIBRE
    if (type === "text") {
      const body = (msg.text?.body || "").trim();

      if (!S.step) {
        // Si no hay paso activo: intento responder corto y menú
        await sendText(from, `Recibido ✅\nContame si buscás: *¿Qué es?*, *Cómo funciona*, *Casos*, *Integraciones*, *Seguridad*, *Precios* o *Demo*.`);
        await sendMainMenu(from);
        return res.sendStatus(200);
      }

      if (S.step === "lead_wait") {
        // Parseo simple: nombre, empresa, email
        const emailMatch = body.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
        const email = emailMatch ? emailMatch[0] : "";
        // Heurística básica para separar nombre/empresa
        const parts = body.replace(email, "").split(/[,;|\n]/).map(s => s.trim()).filter(Boolean);
        const nombre = parts[0] || "";
        const empresa = parts[1] || "";

        try {
          await recordLead({
            wa_id: from,
            nombre,
            empresa,
            email,
            origen: "whatsapp",
            motivo: "demo/asesor",
            nota: body
          });
          await sendText(from, `¡Gracias ${nombre || ""}! Te vamos a contactar a la brevedad.\nEmail: ${email || "(no provisto)"}\nEmpresa: ${empresa || "(no provista)"}\n\nSi preferís, podés agendar directo: ${BOOKING_URL || "(pasanos tu disponibilidad)"}\nTambién podés escribirnos a: ${SALES_EMAIL}`);
        } catch (e) {
          console.error("❌ Error guardando lead:", e);
          await sendText(from, "Guardé tu mensaje, pero no pude registrar los datos en Sheets. Te contactamos igual. 🙏");
        }
        S.step = null;
        await sendMainMenu(from);
        return res.sendStatus(200);
      }

      // fallback
      await sendMainMenu(from);
      return res.sendStatus(200);
    }

    // Otros tipos no soportados
    await sendText(from, "ℹ️ Tipo de mensaje no soportado. Escribí *inicio* para ver el menú.");
    return res.sendStatus(200);
  } catch (e) {
    console.error("💥 Webhook error:", e);
    return res.sendStatus(200);
  }
});

/* ===================== Botón web “wa.me” (embebible) ===================== */
// Snippet: <script src="https://TU_DOMINIO/wame.js" data-text="Quiero una demo 👋"></script>
app.get("/wame.js", (req, res) => {
  const textParam = (req.query.text || "").toString().trim();
  const msg = encodeURIComponent(textParam || WAME_DEFAULT_TEXT);
  const phone = encodeURIComponent(WAME_PHONE);
  const color = WAME_COLOR;
  const link = `https://wa.me/${phone}?text=${msg}`;

  const js = `
(function(){
  if (!"${phone}") { console.warn("WAME_PHONE no configurado"); return; }
  var btn = document.createElement('a');
  btn.href = '${link}';
  btn.target = '_blank';
  btn.rel = 'noopener';
  btn.style.position = 'fixed';
  btn.style.right = '20px';
  btn.style.bottom = '20px';
  btn.style.width = '56px';
  btn.style.height = '56px';
  btn.style.borderRadius = '50%';
  btn.style.background = '${color}';
  btn.style.boxShadow = '0 6px 18px rgba(0,0,0,.2)';
  btn.style.display = 'flex';
  btn.style.alignItems = 'center';
  btn.style.justifyContent = 'center';
  btn.style.color = '#fff';
  btn.style.fontSize = '28px';
  btn.style.textDecoration = 'none';
  btn.style.zIndex = 999999;
  btn.setAttribute('aria-label','WhatsApp');

  btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="28" height="28" fill="#fff"><path d="M19.11 17.44c-.26-.13-1.53-.75-1.77-.84-.24-.09-.42-.13-.6.13-.18.26-.69.84-.84 1.02-.15.18-.31.2-.57.07-.26-.13-1.09-.4-2.07-1.28-.77-.69-1.29-1.53-1.45-1.79-.15-.26-.02-.4.11-.53.11-.11.26-.29.4-.44.13-.15.18-.26.26-.44.09-.18.04-.33-.02-.46-.07-.13-.6-1.44-.82-1.96-.22-.53-.44-.46-.6-.46-.15 0-.33-.02-.51-.02-.18 0-.46.07-.71.33-.24.26-.93.91-.93 2.22 0 1.31.95 2.58 1.09 2.76.13.18 1.86 2.84 4.5 3.98.63.27 1.12.43 1.51.55.63.2 1.2.17 1.65.1.5-.07 1.53-.62 1.74-1.22.22-.6.22-1.11.15-1.22-.07-.11-.24-.18-.51-.31z"/><path d="M16.02 3C9.81 3 4.82 7.99 4.82 14.21c0 2.18.58 4.21 1.6 5.96L5 29l8.99-1.41c1.68.92 3.62 1.45 5.68 1.45 6.21 0 11.21-4.99 11.21-11.21S22.23 3 16.02 3zm0 20.04c-1.86 0-3.59-.55-5.04-1.49l-.36-.24-5.34.83.88-5.2-.26-.4a9.15 9.15 0 0 1-1.41-4.95c0-5.1 4.15-9.25 9.25-9.25s9.25 4.15 9.25 9.25-4.15 9.25-9.25 9.25z"/></svg>';

  document.body.appendChild(btn);
})();`;
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.send(js);
});

/* ===================== Misc ===================== */
app.get("/", (_req, res) => res.send(`Zupply Q&A Bot activo. Web: ${WEBSITE_URL}`));
app.get("/health", (_req, res) => res.json({ ok: true, brand: BRAND }));

/* ===================== Start ===================== */
app.listen(PORT, () => {
  console.log(`🚀 Zupply Q&A Bot escuchando en http://localhost:${PORT}`);
  console.log("📞 PHONE_NUMBER_ID:", PHONE_NUMBER_ID || "(vacío)");
  console.log("📄 Credenciales usadas:", { CLIENT_PATH, TOKEN_PATH });
});
