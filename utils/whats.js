// utils/whats.js
const axios = require("axios");

// Variáveis de ambiente esperadas (Railway/Vercel):
// EVO_BASE      -> ex: "https://evolution.whatsapi.com"
// EVO_INSTANCE  -> ex: "my-instance-01"
// EVO_TOKEN     -> token da Evolution (Authorization: Bearer <token>)
const EVO_BASE = process.env.EVO_BASE || "";
const EVO_INSTANCE = process.env.EVO_INSTANCE || "";
const EVO_TOKEN = process.env.EVO_TOKEN || "";

// ---- Helpers ----
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Normaliza número para E.164 BR (best effort).
// Aceita: "11 98888-7777", "(11)98888-7777", "5511988887777", "+55 11 98888-7777"
function normalizePhoneBR(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D+/g, "");
  if (!digits) return null;

  // já vem com 55?
  if (digits.startsWith("55")) {
    // 55 + 10/11 dígitos
    if (digits.length >= 12 && digits.length <= 13) return `+${digits}`;
    // se vier muito longo/curto, tenta truncar/best effort:
    return `+${digits}`; 
  }

  // Sem DDI: assume Brasil (55). Se tiver 10/11 dígitos, ok
  if (digits.length === 10 || digits.length === 11) {
    return `+55${digits}`;
  }

  // Se vier só 8/9 dígitos, sem DDD, NÃO dá pra garantir → null
  if (digits.length <= 9) return null;

  // Se vier outro DDI (ex.: 351...), usa com +
  return `+${digits}`;
}

function evoClient() {
  if (!EVO_BASE || !EVO_INSTANCE || !EVO_TOKEN) {
    console.warn("[whats] EVO_* envs ausentes. EVO_BASE/EVO_INSTANCE/EVO_TOKEN são obrigatórios.");
  }
  const http = axios.create({
    baseURL: `${EVO_BASE}/v1/instances/${EVO_INSTANCE}`,
    headers: {
      Authorization: `Bearer ${EVO_TOKEN}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
    validateStatus: () => true,
  });
  return http;
}

// Checa status da sessão
async function getSessionState() {
  try {
    const http = evoClient();
    const r = await http.get(`/status`);
    if (r.status >= 400) {
      console.warn("[whats] status fail:", r.status, r.data);
      return { ok: false, state: "unknown", raw: r.data };
    }
    // evolução costuma retornar { instance: {...}, state: "CONNECTED" | "DISCONNECTED" ... }
    const state = r.data?.state || r.data?.instance?.state || "unknown";
    return { ok: true, state, raw: r.data };
  } catch (e) {
    console.error("[whats] getSessionState error:", e.message);
    return { ok: false, state: "error" };
  }
}

// Envia texto simples
async function sendText({ to, text }) {
  const phone = normalizePhoneBR(to);
  if (!phone) {
    throw new Error(`Número inválido: "${to}"`);
  }

  const { ok, state } = await getSessionState();
  if (!ok || state !== "CONNECTED") {
    throw new Error(`Instância não conectada (state=${state}). Escaneie o QR novamente.`);
  }

  const http = evoClient();
  const payload = {
    to: phone,
    text,
    // Algumas instâncias aceitam "delay" e "typingTime". Ajuste se necessário.
  };

  const r = await http.post(`/messages/text`, payload);
  if (r.status >= 400 || r.data?.error) {
    // log detalhado
    console.error("[whats] sendText ERRO", {
      status: r.status,
      data: r.data,
      payload,
    });
    throw new Error(r.data?.message || r.data?.error || `Falha no envio (${r.status})`);
  }

  return r.data;
}

// Mensagem padrão ao mudar LOCAL da OS
async function notifyLocalChange({ osId, localNome, idScanner, clienteNome, phone }) {
  const dest = phone || null;
  if (!dest) {
    console.warn(`[whats] OS #${osId}: cliente sem celular/telefone. Mensagem não enviada.`);
    return { skipped: true, reason: "no-phone" };
  }

  const msg =
    `Olá ${clienteNome || ""}! 👋\n` +
    `Sua OS #${osId} foi atualizada.\n` +
    `Novo local: *${localNome || "-"}* (ID: ${idScanner || "-"})\n` +
    `Qualquer novidade a gente te avisa.`;

  try {
    const resp = await sendText({ to: dest, text: msg });
    console.log(`[whats] OS #${osId}: mensagem enviada para ${dest}`, resp?.id || "");
    return { ok: true };
  } catch (e) {
    console.error(`[whats] OS #${osId}: falha ao enviar para ${dest} ->`, e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  normalizePhoneBR,
  getSessionState,
  sendText,
  notifyLocalChange,
};
