// backend/utils/whats-bot.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const qrcodeTerminal = require('qrcode-terminal');
const qrcodeImage = require('qrcode');
const mysql = require('mysql2/promise');
const { Client, LocalAuth } = require('whatsapp-web.js');

/* ========= SCHEMA / TABELAS ========= */
const SCHEMA = 'assistencia_tecnica';
const OS_TABLE = `${SCHEMA}.ordenservico`;
const CLIENTE_TABLE = `${SCHEMA}.cliente`;

/* ========= COLUNAS ========= */
const OS_PK = 'id_os';
const OS_ID_CLIENTE = 'id_cliente';
const OS_ID_LOCAL = 'id_local';
const OS_DESC_PROB = 'descricao_problema';
const OS_DATA_CR = 'data_criacao';
const OS_DATA_AT = 'data_atualizacao';
const OS_ID_TEC = 'id_tecnico';

const CLIENTE_ID1 = 'id_cliente';
const CLIENTE_FONE = 'telefone';

/* ========= ENV ========= */
const {
  DB_HOST, DB_PORT = 3306, DB_USER, DB_PASS, DB_NAME,
  WPP_SESSION_NAME = 'sat-assistencia',
  POLL_INTERVAL_MS = 5000,
  WPP_DATA_PATH = './.wwebjs_auth',
} = process.env;

/* ========= Mensagens por LOCAL ========= */
const MESSAGES_BY_LOCAL = new Map([
  ['LOC001', '✅ Bem-vindo à *Eletrotek*! Demos entrada em seu equipamento. Em breve você receberá seu orçamento.'],
  ['LOC002', '🔧 Seu equipamento já está na mesa do técnico para diagnóstico.'],
  ['LOC003', '📩 Seu orçamento foi enviado. Assim que você autorizar, daremos sequência ao reparo.'],
  ['LOC004', '📦 Estamos aguardando a chegada das peças.'],
  ['LOC005', '🛠️ Seu equipamento está em *reparo* neste momento.'],
  ['LOC006', '🧪 Estamos *testando* seu equipamento para garantir que ficou 100%.'],
  ['LOC007', '📦 Seu equipamento está *pronto para retirada*.'],
  ['LOC008', '✅ Sua OS foi *finalizada e entregue*. Obrigado por escolher a Eletrotek!'],
]);

/* ========= Mensagens extras por STATUS ========= */
const MESSAGES_BY_STATUS = new Map([
  ['Com Cliente', '📦 Seu equipamento foi entregue/retirado. Obrigado por escolher a Eletrotek!'],
]);

/* ========= Rotas extras via .env ========= */
const envList = (k) => (process.env[k] || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const EXTRA_ROUTES = new Map([
  ['LOC001', envList('ROUTE_LOC001_NUMBERS')],
  ['LOC002', envList('ROUTE_LOC002_NUMBERS')],
  ['LOC003', envList('ROUTE_LOC003_NUMBERS')],
  ['LOC004', envList('ROUTE_LOC004_NUMBERS')],
  ['LOC005', envList('ROUTE_LOC005_NUMBERS')],
  ['LOC006', envList('ROUTE_LOC006_NUMBERS')],
  ['LOC007', envList('ROUTE_LOC007_NUMBERS')],
  ['LOC008', envList('ROUTE_LOC008_NUMBERS')],
]);

/* ========= MYSQL ========= */
let pool;
async function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: DB_HOST,
      port: Number(DB_PORT),
      user: DB_USER,
      password: DB_PASS,
      database: DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      dateStrings: true,
      charset: 'utf8mb4',
    });
  }
  return pool;
}

/* ========= WHATSAPP ========= */
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: WPP_SESSION_NAME,
    dataPath: WPP_DATA_PATH,
  }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  },
  webVersion: '2.2412.54',
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
  },
  takeoverOnConflict: true,
  takeoverTimeoutMs: 0,
  restartOnAuthFail: true,
  qrMaxRetries: 0,
});

const QR_PNG_PATH = path.join(__dirname, '..', 'uploads', 'whatsapp-qr.png');

client.on('qr', async (qr) => {
  console.clear();
  console.log('📲 Escaneie o QR abaixo para conectar ao WhatsApp:');
  qrcodeTerminal.generate(qr, { small: true });
  try {
    const dir = path.dirname(QR_PNG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await qrcodeImage.toFile(QR_PNG_PATH, qr, { width: 320, margin: 2 });
    console.log(`QR salvo em: ${QR_PNG_PATH}`);
  } catch (e) {
    console.error('Falha ao salvar QR:', e?.message || e);
  }
});

client.on('ready', async () => {
  console.log('✅ WhatsApp pronto');
  await bootstrap();
  loop();
});

client.on('auth_failure', (m) => console.error('[whats] auth_failure', m));
client.on('disconnected', (r) => {
  console.warn('[whats] disconnected', r);
  client.initialize();
});

client.initialize();

/* ========= STATE ========= */
const STATE_FILE = path.join(__dirname, '..', '.bot_state.json');
const loadState = () => {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastSeen: {}, lastStatus: {}, bootstrapped: false }; }
};
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
let state = loadState();

/* ========= HELPERS ========= */
const fmt = (d) => d ? new Date(d).toLocaleString('pt-BR') : '-';

function normalizeBR(phoneRaw) {
  if (!phoneRaw) return null;
  let d = String(phoneRaw).replace(/\D/g, ''); // só números
  d = d.replace(/^0+/, '');
  if (d.startsWith('55')) {
    if (d.length >= 12 && d.length <= 13) return d;
    return d.slice(0, 13);
  }
  if (d.length === 10 || d.length === 11) return '55' + d;
  return null;
}

async function logEnvio(p, osId, idLocal, destino, mensagem) {
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.whats_envios (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        id_os INT NOT NULL,
        id_local VARCHAR(50) NOT NULL,
        destino VARCHAR(32) NOT NULL,
        mensagem TEXT NOT NULL,
        data_envio DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_os (id_os),
        KEY idx_local (id_local)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await p.query(
      `INSERT INTO ${SCHEMA}.whats_envios (id_os, id_local, destino, mensagem) VALUES (?, ?, ?, ?)`,
      [osId, idLocal, destino, mensagem]
    );
  } catch (e) {
    console.warn('[whats] Falha ao logar envio:', e?.message || e);
  }
}

async function sendTo(numbers, text, osId, idLocal) {
  const p = await getPool();
  for (const num of numbers) {
    const jid = `${num}@c.us`;
    try {
      await client.sendMessage(jid, text);
      console.log(`[whats] → enviado p/ ${num} (OS ${osId}, ${idLocal})`);
      await logEnvio(p, osId, idLocal, num, text);
    } catch (e) {
      console.error(`[whats] Falha ao enviar p/ ${num}:`, e?.message || e);
    }
  }
}

/* ========= BOOTSTRAP ========= */
async function bootstrap() {
  const p = await getPool();
  if (state.bootstrapped) return;
  const [rows] = await p.query(`SELECT ${OS_PK} AS id_os, ${OS_ID_LOCAL} AS id_local, id_status_os FROM ${OS_TABLE}`);
  for (const r of rows) {
    state.lastSeen[r.id_os] = r.id_local;
    state.lastStatus[r.id_os] = r.id_status_os ?? null;
  }
  state.bootstrapped = true;
  saveState(state);
  console.log(`📌 Baseline: ${rows.length} OS (sem notificar).`);
}

/* ========= LOOP ========= */
function messageForLocal(idLocal, os) {
  return (
    MESSAGES_BY_LOCAL.get(idLocal) ||
    `🛠️ Sua OS #${os.id_os} foi movida para *${idLocal}*.\n` +
    `Problema: ${os.descricao_problema || '-'}\n` +
    `Criada: ${fmt(os.data_criacao)} | Atualizada: ${fmt(os.data_atualizacao)}`
  );
}

async function checkOnce() {
  const p = await getPool();
  const [rows] = await p.query(`
    SELECT
      os.${OS_PK} AS id_os,
      os.${OS_ID_CLIENTE} AS id_cliente,
      os.${OS_DESC_PROB} AS descricao_problema,
      os.${OS_DATA_CR} AS data_criacao,
      os.${OS_DATA_AT} AS data_atualizacao,
      os.${OS_ID_TEC} AS id_tecnico,
      os.${OS_ID_LOCAL} AS id_local,
      os.id_status_os AS id_status_os,
      s.descricao AS status_desc,
      COALESCE(c.${CLIENTE_FONE}, c.${CLIENTE_FONE}) AS telefone_cliente
    FROM ${OS_TABLE} os
    LEFT JOIN ${CLIENTE_TABLE} c ON c.${CLIENTE_ID1} = os.${OS_ID_CLIENTE}
    LEFT JOIN ${SCHEMA}.status_os s ON s.id_status = os.id_status_os
    WHERE os.${OS_DATA_AT} >= NOW() - INTERVAL 2 DAY
    ORDER BY os.${OS_DATA_AT} DESC, os.${OS_PK} DESC
  `);

  for (const os of rows) {
    const prevLocal = state.lastSeen[os.id_os];
    const prevStatus = state.lastStatus[os.id_os];

    const to = [];
    const telCliente = normalizeBR(os.telefone_cliente);
    if (telCliente) to.push(telCliente);
    const extras = EXTRA_ROUTES.get(os.id_local) || [];
    for (const raw of extras) {
      const e = normalizeBR(raw);
      if (e) to.push(e);
    }

    if (!to.length) {
      state.lastSeen[os.id_os] = os.id_local;
      state.lastStatus[os.id_os] = os.id_status_os;
      continue;
    }

    // Nova OS → mensagem de boas-vindas
    if (prevLocal === undefined) {
      state.lastSeen[os.id_os] = os.id_local;
      state.lastStatus[os.id_os] = os.id_status_os;
      saveState(state);
      await sendTo(to, MESSAGES_BY_LOCAL.get('LOC001'), os.id_os, os.id_local);
      continue;
    }

    // Mudança de LOCAL
    if (prevLocal !== os.id_local) {
      state.lastSeen[os.id_os] = os.id_local;
      state.lastStatus[os.id_os] = os.id_status_os;
      saveState(state);
      const texto = messageForLocal(os.id_local, os);
      await sendTo(to, texto, os.id_os, os.id_local);
      continue;
    }

    // Mudança de STATUS
    if (prevStatus !== os.id_status_os) {
      state.lastStatus[os.id_os] = os.id_status_os;
      saveState(state);
      if (os.status_desc && MESSAGES_BY_STATUS.has(os.status_desc)) {
        const texto = MESSAGES_BY_STATUS.get(os.status_desc);
        await sendTo(to, texto, os.id_os, os.id_local);
      }
    }
  }
}

function loop() {
  checkOnce().catch(e => console.error('[whats] Loop error:', e));
  setInterval(() => checkOnce().catch(e => console.error('[whats] Loop error:', e)), Number(POLL_INTERVAL_MS));
}
