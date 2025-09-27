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
const OS_TABLE = `${SCHEMA}.ordenservico`;        // ✅ com 1 "s"
const CLIENTE_TABLE = `${SCHEMA}.cliente`;

/* ========= COLUNAS ========= */
// ordenservico
const OS_PK = 'id_os';
const OS_ID_CLIENTE = 'id_cliente';
const OS_ID_LOCAL = 'id_local';
const OS_DESC_PROB = 'descricao_problema';
const OS_DATA_CR = 'data_criacao';
const OS_DATA_AT = 'data_atualizacao';
const OS_ID_TEC = 'id_tecnico';

// cliente (suporta id_cliente OU id_diente)
const CLIENTE_ID1 = 'id_cliente';
const CLIENTE_ID2 = 'id_diente';
const CLIENTE_FONE = 'telefone';

/* ========= ENV ========= */
const {
  DB_HOST, DB_PORT = 3306, DB_USER, DB_PASS, DB_NAME,
  WPP_SESSION_NAME = 'sat-assistencia',
  POLL_INTERVAL_MS = 5000,
  WPP_DATA_PATH = './.wwebjs_auth',
} = process.env;

/* ========= Mensagens por local =========
   Mapeadas pelo valor de id_local da tabela `local` (ex.: LOC001, LOC002, etc.)
*/
const MESSAGES_BY_LOCAL = new Map([
  ['LOC001', '✅ Bem-vindo à *Eletrotek*! Demos entrada em seu equipamento. Em breve você receberá seu orçamento.'],
  ['LOC002', '🔧 Seu equipamento já está na mesa do técnico para diagnóstico. Em breve enviaremos o orçamento.'],
  ['LOC003', '📩 Seu orçamento foi enviado. Assim que você autorizar, daremos sequência ao reparo.'],
  ['LOC004', '📦 Estamos aguardando a chegada das peças para continuar o reparo.'],
  ['LOC005', '🛠️ Seu equipamento está em *reparo* neste momento.'],
  ['LOC006', '🧪 Estamos *testando* seu equipamento para garantir que ficou 100%.'],
  ['LOC007', '📦 Seu equipamento está *pronto para retirada*.'],
  ['LOC008', '✅ Sua OS foi *finalizada e entregue*. Obrigado por escolher a Eletrotek!'],
]);

/* ========= Cópias por id_local via .env (opcional) =========
   Ex.: ROUTE_LOCO001_NUMBERS=5564999999999,5562988887777
*/
const envList = (k) => (process.env[k] || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const EXTRA_ROUTES = new Map([
  ['LOCO001', envList('ROUTE_LOCO001_NUMBERS')],
  ['LOCO002', envList('ROUTE_LOCO002_NUMBERS')],
  ['LOCO003', envList('ROUTE_LOCO003_NUMBERS')],
  ['LOCO004', envList('ROUTE_LOCO004_NUMBERS')],
  ['LOCO005', envList('ROUTE_LOCO005_NUMBERS')],
  ['LOCO006', envList('ROUTE_LOCO006_NUMBERS')],
  ['LOCO007', envList('ROUTE_LOCO007_NUMBERS')],
  ['LOCO008', envList('ROUTE_LOCO008_NUMBERS')],
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
    dataPath: WPP_DATA_PATH, // persiste sessão no Volume
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  },
  // fixa versão (reduz MUITO "não é possível conectar dispositivo")
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
  console.log('Escaneie o QR (também disponí­vel em /whatsapp-qr ou /uploads/whatsapp-qr.png):');
  qrcodeTerminal.generate(qr, { small: true });

  try {
    const dir = path.dirname(QR_PNG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await qrcodeImage.toFile(QR_PNG_PATH, qr, { width: 320, margin: 2 });
    console.log(`📷 QR salvo em: ${QR_PNG_PATH}`);
  } catch (e) {
    console.error('Falha ao salvar QR como PNG:', e?.message || e);
  }
});

client.on('auth_failure', (m) => console.error('[whats] auth_failure', m));
client.on('disconnected', (r) => {
  console.warn('[whats] disconnected', r);
  client.initialize();
});

client.on('ready', async () => {
  console.log('✅ WhatsApp pronto');
  await bootstrap();
  loop();
});

client.initialize();

/* ========= STATE (evitar duplicidade) ========= */
const STATE_FILE = path.join(__dirname, '..', '.bot_state.json');
const loadState = () => {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastSeen: {}, bootstrapped: false }; }
};
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
let state = loadState();

/* ========= HELPERS ========= */
const fmt = (d) => d ? new Date(d).toLocaleString('pt-BR') : '-';

// normaliza número BR
function normalizeBR(phoneRaw) {
  if (!phoneRaw) return null;
  let d = String(phoneRaw).replace(/\D/g, ''); // só dígitos
  d = d.replace(/^0+/, '');
  if (d.startsWith('55')) {
    if (d.length === 12 || d.length === 13) return d; // 55 + 10/11
    if (d.length > 13) return d.slice(0, 13);
    return null;
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

  // índice útil para busca recente
  try {
    await p.query(`CREATE INDEX IF NOT EXISTS idx_os_at ON ${OS_TABLE} (${OS_DATA_AT}, ${OS_PK})`);
  } catch (_) {}

  if (state.bootstrapped) return;

  // baseline: marca todas as OS existentes sem disparar mensagens
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
function messageForLocal(idLocal, os) {
  return (
    MESSAGES_BY_LOCAL.get(idLocal) ||
    `🛠️ Sua Ordem de Serviço #${os.id_os} foi movida para *${idLocal}*.\n` +
    `Problema: ${os.descricao_problema || '-'}\n` +
    `Criada: ${fmt(os.data_criacao)} | Atualizada: ${fmt(os.data_atualizacao)}`
  );
}

const WELCOME_MSG =
  '✅ Bem-vindo à *Eletrotek*! Demos entrada em seu equipamento. ' +
  'Em breve você receberá seu orçamento.';

async function checkOnce() {
  const p = await getPool();

  // Busca OS recentes (últimos 2 dias) — ajuste se quiser
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

    // NÚMERO(S) DESTINO
    const to = [];
    const telCliente = normalizeBR(os.telefone_cliente);
    if (telCliente) to.push(telCliente);

    const extras = EXTRA_ROUTES.get(os.id_local) || [];
    for (const raw of extras) {
      const e = normalizeBR(raw);
      if (e) to.push(e);
    }

    // Se não há destino válido, apenas atualiza o estado e segue
    if (to.length === 0) {
      state.lastSeen[os.id_os] = os.id_local;
      continue;
    }

    // Envio na *criação* (primeira vez que a OS aparece após o bot estar no ar)
    if (prev === undefined) {
      state.lastSeen[os.id_os] = os.id_local;
      saveState(state);
      await sendTo(to, WELCOME_MSG, os.id_os, os.id_local);
      continue;
    }

    // Mudança de local
    if (prev !== os.id_local) {
      changes++;
      state.lastSeen[os.id_os] = os.id_local;
      saveState(state);

      const texto = messageForLocal(os.id_local, os);
      await sendTo(to, texto, os.id_os, os.id_local);
    }
  }

  if (changes) console.log(`✔️ ${changes} mudança(s) processadas`);
}

function loop() {
  checkOnce().catch(e => console.error('[whats] Loop error:', e));
  setInterval(() => checkOnce().catch(e => console.error('[whats] Loop error:', e)),
              Number(POLL_INTERVAL_MS));
}
