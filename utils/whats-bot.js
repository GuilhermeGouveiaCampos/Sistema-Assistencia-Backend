// backend/utils/whats-bot.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const mysql = require('mysql2/promise');
const { Client, LocalAuth } = require('whatsapp-web.js');

/* ========= SCHEMA / TABELAS ========= */
const SCHEMA = 'assistencia_tecnica';
const OS_TABLE = `${SCHEMA}.ordensservico`;
const CLIENTE_TABLE = `${SCHEMA}.cliente`;

/* ========= COLUNAS ========= */
// ordensservico
const OS_PK = 'id_os';
const OS_ID_CLIENTE = 'id_cliente';
const OS_ID_LOCAL = 'id_local';
const OS_DESC_PROB = 'descricao_problema';
const OS_DATA_CR = 'data_criacao';
const OS_DATA_AT = 'data_atualizacao';
const OS_ID_TEC = 'id_tecnico';

// cliente (suporta id_cliente OU id_diente)
const CLIENTE_ID1 = 'id_cliente';
const CLIENTE_ID2 = 'id_diente'; // fallback se existir com esse nome
const CLIENTE_FONE = 'telefone';

/* ========= ENV ========= */
const {
  DB_HOST, DB_PORT = 3306, DB_USER, DB_PASS, DB_NAME,
  WPP_SESSION_NAME = 'sat-assistencia',
  POLL_INTERVAL_MS = 5000,
} = process.env;

/* ========= (opcional) cópias por id_local via .env =========
   Ex.: ROUTE_LOCO001_NUMBERS=5564999999999,5562988887777
        ROUTE_LOCO002_NUMBERS=5564888888888
*/
const envList = (k) => (process.env[k] || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const EXTRA_ROUTES = new Map([
  ['LOCO001', envList('ROUTE_LOCO001_NUMBERS')],
  ['LOCO002', envList('ROUTE_LOCO002_NUMBERS')],
]);

/* ========= MYSQL ========= */
let pool;
async function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: DB_HOST, port: Number(DB_PORT),
      user: DB_USER, password: DB_PASS, database: DB_NAME,
      waitForConnections: true, connectionLimit: 10,
    });
  }
  return pool;
}

/* ========= WHATSAPP ========= */
const client = new Client({
  authStrategy: new LocalAuth({ clientId: WPP_SESSION_NAME }),
  puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'] },
  webVersionCache: { type: 'none' },
});

client.on('qr', (qr) => { console.clear(); console.log('Escaneie o QR:'); qrcode.generate(qr, { small: true }); });
client.on('auth_failure', (m)=>console.error('auth_failure',m));
client.on('disconnected', (r)=>{ console.warn('disconnected',r); client.initialize(); });

client.on('ready', async () => {
  console.log('✅ WhatsApp pronto');
  await bootstrap();
  loop();
});

client.initialize();

/* ========= STATE ========= */
const STATE_FILE = path.join(__dirname, '..', '.bot_state.json');
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); } catch { return { lastSeen:{}, bootstrapped:false }; } };
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s,null,2));
let state = loadState();

/* ========= HELPERS ========= */
const fmt = (d)=> d ? new Date(d).toLocaleString('pt-BR') : '-';

// normaliza número BR salvo como "(64) 95814-2312" -> "5564958142312"
function normalizeBR(phoneRaw) {
  if (!phoneRaw) return null;
  let d = String(phoneRaw).replace(/\D/g,'');   // só dígitos

  // remove prefixos 0 (DDD com 0)
  d = d.replace(/^0+/, '');

  // se já vier com DDI (55...):
  if (d.startsWith('55')) {
    if (d.length === 12 || d.length === 13) return d; // 55 + 10/11
    // casos estranhos: tenta cortar excesso à direita
    if (d.length > 13) return d.slice(0, 13);
    return null;
  }

  // sem DDI: 10 dígitos (fixo) ou 11 (celular)
  if (d.length === 10 || d.length === 11) return '55' + d;

  // se vier só 9 dígitos (sem DDD), não dá pra corrigir aqui
  return null;
}

async function sendTo(numbers, text) {
  for (const num of numbers) {
    const jid = `${num}@c.us`;
    try {
      await client.sendMessage(jid, text);
      console.log(`→ enviado p/ ${num}`);
    } catch (e) {
      console.error(`Falha ao enviar p/ ${num}:`, e?.message || e);
    }
  }
}

/* ========= BOOTSTRAP ========= */
async function bootstrap() {
  const p = await getPool();
  try {
    await p.query(`CREATE INDEX IF NOT EXISTS idx_os_at ON ${OS_TABLE} (${OS_DATA_AT}, ${OS_PK})`);
  } catch (_) {}

  if (state.bootstrapped) return;

  const [rows] = await p.query(`
    SELECT ${OS_PK} AS id_os, ${OS_ID_LOCAL} AS id_local
    FROM ${OS_TABLE}
  `);
  for (const r of rows) state.lastSeen[r.id_os] = r.id_local;
  state.bootstrapped = true;
  saveState(state);
  console.log(`📌 Baseline: ${rows.length} OS (sem notificar).`);
}

/* ========= LOOP ========= */
async function checkOnce() {
  const p = await getPool();

  // JOIN aceitando cliente.id_cliente OU cliente.id_diente
  const [rows] = await p.query(`
    SELECT
      os.${OS_PK}          AS id_os,
      os.${OS_ID_CLIENTE}  AS id_cliente,
      os.${OS_DESC_PROB}   AS descricao_problema,
      os.${OS_DATA_CR}     AS data_criacao,
      os.${OS_DATA_AT}     AS data_atualizacao,
      os.${OS_ID_TEC}      AS id_tecnico,
      os.${OS_ID_LOCAL}    AS id_local,
      c.${CLIENTE_FONE}    AS telefone_cliente
    FROM ${OS_TABLE} os
    LEFT JOIN ${CLIENTE_TABLE} c
      ON (c.${CLIENTE_ID1} = os.${OS_ID_CLIENTE} OR c.${CLIENTE_ID2} = os.${OS_ID_CLIENTE})
    WHERE os.${OS_DATA_AT} >= NOW() - INTERVAL 2 DAY
    ORDER BY os.${OS_DATA_AT} DESC, os.${OS_PK} DESC
  `);

  let changes = 0;

  for (const os of rows) {
    const prev = state.lastSeen[os.id_os];
    if (prev === undefined) { state.lastSeen[os.id_os] = os.id_local; continue; }

    if (prev !== os.id_local) {
      changes++;
      state.lastSeen[os.id_os] = os.id_local;
      saveState(state);

      const texto =
        `🛠️ Sua Ordem de Serviço #${os.id_os} foi movida para *${os.id_local}*.\n` +
        `Problema: ${os.descricao_problema || '-'}\n` +
        `Criada: ${fmt(os.data_criacao)} | Atualizada: ${fmt(os.data_atualizacao)}`;

      // 1) cliente (automático)
      const to = [];
      const telCliente = normalizeBR(os.telefone_cliente);
      if (telCliente) to.push(telCliente);

      // 2) extras por id_local (opcional)
      const extras = EXTRA_ROUTES.get(os.id_local) || [];
      for (const raw of extras) {
        const e = normalizeBR(raw);
        if (e) to.push(e);
      }

      if (to.length === 0) {
        console.warn(`⚠️ OS ${os.id_os}: sem número válido (cliente/extra)`);
        continue;
      }

      console.log(`OS ${os.id_os}: ${prev} -> ${os.id_local} | enviando p/ ${to.join(',')}`);
      await sendTo(to, texto);
    }
  }

  if (changes) console.log(`✔️ ${changes} mudança(s) processadas`);
}

function loop() {
  checkOnce().catch(e => console.error('Loop error:', e));
  setInterval(() => checkOnce().catch(e => console.error('Loop error:', e)),
              Number(POLL_INTERVAL_MS));
}
