// backend/utils/whats.js
// Integração simples com Evolution API (open-source / self-hosted)

const axios = require('axios');

const EV_URL     = (process.env.EVOLUTION_URL || '').replace(/\/+$/, '');
const EV_INSTANCE = process.env.EVOLUTION_INSTANCE || ''; // nome/ID da sessão
const EV_TOKEN    = process.env.EVOLUTION_TOKEN || '';    // apikey ou bearer
// qual header usar para o token: 'apikey' (padrão Evolution) ou 'authorization'
const EV_TOKEN_HEADER = (process.env.EVOLUTION_TOKEN_HEADER || 'apikey').toLowerCase();

/** Normaliza telefone para formato internacional (BR): 55 + 11/10 dígitos */
function normalizePhone(p) {
  if (!p) return null;
  let d = String(p).replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) return d;
  if (d.length === 11 || d.length === 10) return '55' + d;
  return d;
}

function buildHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (EV_TOKEN_HEADER === 'authorization') {
    h['Authorization'] = `Bearer ${EV_TOKEN}`;
  } else {
    h[EV_TOKEN_HEADER] = EV_TOKEN;
  }
  return h;
}

/**
 * Envia texto via Evolution API.
 * Tenta a rota padrão `/message/sendText/:instance`,
 * se 404, tenta fallback `/sendText/:instance`.
 */
async function sendTextRaw(number, text) {
  if (!EV_URL || !EV_INSTANCE || !EV_TOKEN) {
    console.warn('[whats] Variáveis de ambiente faltando (EVOLUTION_URL/INSTANCE/TOKEN). Pulado.');
    return;
  }
  const num = normalizePhone(number);
  if (!num) {
    console.warn('[whats] Número inválido. Pulado.');
    return;
  }

  const headers = buildHeaders();
  let url1 = `${EV_URL}/message/sendText/${encodeURIComponent(EV_INSTANCE)}`;
  let url2 = `${EV_URL}/sendText/${encodeURIComponent(EV_INSTANCE)}`;

  try {
    const res = await axios.post(url1, { number: num, text }, { headers, timeout: 10000 });
    console.log('[whats] OK', res.status);
    return;
  } catch (e1) {
    console.warn('[whats] rota1 falhou:', e1.response?.status, e1.response?.data || e1.message);
  }

  try {
    const res2 = await axios.post(url2, { number: num, text }, { headers, timeout: 10000 });
    console.log('[whats] OK fallback', res2.status);
  } catch (e2) {
    console.error('[whats] rota2 falhou:', e2.response?.status, e2.response?.data || e2.message);
  }
}

/** Mensagem padrão quando o LOCAL muda */
async function notifyLocalChange({ osId, localNome, idScanner, clienteNome, phone }) {
  const to = phone || process.env.WHATS_TEST_NUMBER; // fallback p/ testes
  if (!to) {
    console.log('[whats] nenhum número de destino. Defina cliente.celular/telefone ou WHATS_TEST_NUMBER.');
    return;
  }

  const texto =
    `Olá ${clienteNome || ''}!\n` +
    `Sua OS #${osId} foi movida para: ${localNome || idScanner}.\n` +
    `Qualquer dúvida, estamos à disposição.`;

  await sendTextRaw(to, texto);
}

module.exports = { sendTextRaw, notifyLocalChange, normalizePhone };
