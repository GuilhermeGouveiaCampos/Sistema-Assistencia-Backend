// backend/utils/whats-bot.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const qrcodeTerminal = require("qrcode-terminal");
const qrcodeImage = require("qrcode");
const mysql = require("mysql2/promise");
const { Client, LocalAuth } = require("whatsapp-web.js");

/* ========= SCHEMA / TABELAS ========= */
const SCHEMA = "assistencia_tecnica";
const OS_TABLE = `${SCHEMA}.ordenservico`;
const CLIENTE_TABLE = `${SCHEMA}.cliente`;

/* ========= COLUNAS ========= */
const OS_PK = "id_os";
const OS_ID_CLIENTE = "id_cliente";
const OS_ID_LOCAL = "id_local";
const OS_DESC_PROB = "descricao_problema";
const OS_DATA_CR = "data_criacao";
const OS_DATA_AT = "data_atualizacao";
const OS_ID_TEC = "id_tecnico";

const CLIENTE_ID1 = "id_cliente";
const CLIENTE_FONE = "telefone";

/* ========= ENV ========= */
const {
  DB_HOST,
  DB_PORT = 3306,
  DB_USER,
  DB_PASS,
  DB_NAME,

  WPP_SESSION_NAME = "sat-assistencia",
  POLL_INTERVAL_MS = 5000,

  // >>> unificado com o que usamos na Railway/Server
  WPP_DATA_PATH = process.env.WPP_DATA_PATH || "/data/.wwebjs_auth",
  UPLOAD_DIR = process.env.UPLOAD_DIR || "/data/uploads/os",

  // força sessão nova no boot (apaga pasta session-<nome>)
  WPP_FORCE_NEW_SESSION = "0",

  WHATS_NOTIFY_URL, // opcional: URL de notify SSE
  PUPPETEER_EXECUTABLE_PATH, // opcional se chromium do sistema

  // modo sem DB (para testes locais/diagnóstico)
  WHATS_DISABLE_DB = "0",
} = process.env;

const DISABLE_DB = WHATS_DISABLE_DB === "1";

/* ========= PREPARE DIRETÓRIOS ========= */
for (const d of [WPP_DATA_PATH, UPLOAD_DIR, path.dirname(UPLOAD_DIR)]) {
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch (e) {
    console.error("[WPP] ERRO criando diretório", d, ":", e.message);
  }
}

console.log(
  "[WPP] DATA PATH =",
  WPP_DATA_PATH,
  "| SESSION =",
  WPP_SESSION_NAME,
  "| DISABLE_DB =",
  DISABLE_DB ? "ON" : "OFF",
);

// força sessão nova opcionalmente (útil para “QR muito antigo” na nuvem)
if (WPP_FORCE_NEW_SESSION === "1") {
  try {
    const sessionDir = path.join(WPP_DATA_PATH, `session-${WPP_SESSION_NAME}`);
    fs.rmSync(sessionDir, { recursive: true, force: true });
    console.log("[WPP] Sessão antiga removida (WPP_FORCE_NEW_SESSION=1):", sessionDir);
  } catch (e) {
    console.warn("[WPP] Falha ao remover sessão antiga:", e.message);
  }
}

try {
  console.log(
    "[WPP] Conteúdo inicial de",
    WPP_DATA_PATH,
    ":",
    fs.readdirSync(WPP_DATA_PATH),
  );
} catch (e) {
  console.error("[WPP] ERRO verificando diretório:", e.message);
}

/* ========= Mensagens por LOCAL ========= */
const MESSAGES_BY_LOCAL = new Map([
  [
    "LOC001",
    "👋 *Olá!* Aqui é a *Eletrotek*!\n\nRecebemos o seu equipamento e ele já está em nossa central técnica. 🔍 Assim que o orçamento estiver pronto, entraremos em contato com você!"
  ],
  [
    "LOC002",
    "🧰 *Atualização Eletrotek:*\nSeu equipamento já está na *bancada do técnico* e o diagnóstico está em andamento. Em breve teremos novidades para você!"
  ],
  [
    "LOC003",
    "💬 *Orçamento disponível!*\nO diagnóstico foi concluído e o orçamento está pronto. 💰 Entre em contato conosco quando puder para avaliarmos juntos as opções de reparo."
  ],
  [
    "LOC004",
    "🚚 *Status Eletrotek: Aguardando Peças*\nSeu equipamento já foi avaliado e as peças necessárias estão a caminho. Assim que chegarem as peças, daremos sequência ao reparo. 🔧"
  ],
  [
    "LOC005",
    "⚙️ *Seu equipamento está em reparo!*\nNosso técnico está realizando o serviço com todo o cuidado. 🛠️ Logo mais traremos boas notícias!"
  ],
  [
    "LOC006",
    "🧪 *Etapa de testes concluída!*\nEstamos testando o equipamento para garantir que tudo funcione perfeitamente antes da entrega. ✅"
  ],
  [
    "LOC007",
    "📦 *Equipamento pronto!*\nSeu equipamento já está *finalizado e pronto para retirada* na *Eletrotek*. Venha buscá-lo quando quiser! 😊"
  ],
  [
    "LOC008",
    "🎉 *Concluímos o serviço!*\nSua *Ordem de Serviço foi finalizada e o equipamento entregue.*\n\nAgradecemos por confiar na *Eletrotek*! 💙 Esperamos vê-lo em breve!"
  ],
]);


/* ========= Mensagens extras por STATUS ========= */
const MESSAGES_BY_STATUS = new Map([
  ["Com Cliente", "📦 Seu equipamento foi entregue/retirado. Obrigado por escolher a Eletrotek!"],
]);

/* ========= Rotas extras via .env ========= */
const envList = (k) =>
  (process.env[k] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const EXTRA_ROUTES = new Map([
  ["LOC001", envList("ROUTE_LOC001_NUMBERS")],
  ["LOC002", envList("ROUTE_LOC002_NUMBERS")],
  ["LOC003", envList("ROUTE_LOC003_NUMBERS")],
  ["LOC004", envList("ROUTE_LOC004_NUMBERS")],
  ["LOC005", envList("ROUTE_LOC005_NUMBERS")],
  ["LOC006", envList("ROUTE_LOC006_NUMBERS")],
  ["LOC007", envList("ROUTE_LOC007_NUMBERS")],
  ["LOC008", envList("ROUTE_LOC008_NUMBERS")],
]);

/* ========= MYSQL ========= */
let pool;
async function getPool() {
  if (DISABLE_DB) {
    throw new Error("DB desabilitado por WHATS_DISABLE_DB=1");
  }
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
      charset: "utf8mb4",
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
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
    executablePath: PUPPETEER_EXECUTABLE_PATH || undefined, // se setado no ENV
  },
  // Corrige "versão do WhatsApp Web" incompatível
  webVersionCache: {
    type: "remote",
    remotePath:
      "https://raw.githubusercontent.com/pedroslopez/whatsapp-web.js/main/web-version.json",
  },
  takeoverOnConflict: true,
  takeoverTimeoutMs: 0,
  restartOnAuthFail: true,
  qrMaxRetries: 0,
});

// Colocamos o QR PNG na BASE do uploads para servir em /uploads/whatsapp-qr.png
const uploadsRoot = path.resolve(UPLOAD_DIR);
const uploadsBase = path.dirname(uploadsRoot); // UPLOAD_DIR=/data/uploads/os → uploadsBase=/data/uploads
const QR_PNG_PATH = path.join(uploadsBase, "whatsapp-qr.png");

/* ========= LOGS ÚTEIS ========= */
client.on("change_state", (s) => console.log("[whats] state =", s));
client.on("loading_screen", (pct, msg) => console.log("[whats] loading", pct, msg || ""));

client.on("qr", async (qr) => {
  console.clear();
  console.log("📲 Escaneie o QR abaixo para conectar ao WhatsApp:");
  qrcodeTerminal.generate(qr, { small: true });
  try {
    const dir = path.dirname(QR_PNG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await qrcodeImage.toFile(QR_PNG_PATH, qr, { width: 320, margin: 2 });
    console.log(`QR salvo em: ${QR_PNG_PATH}`);
  } catch (e) {
    console.error("Falha ao salvar QR:", e?.message || e);
  }
});

client.on("ready", async () => {
  console.log("✅ WhatsApp pronto");
  if (DISABLE_DB) {
    console.log("⚠️ WHATS_DISABLE_DB=1 → pulando bootstrap/loop (modo sem DB).");
    return;
  }
  try {
    await bootstrap();
    loop();
  } catch (e) {
    console.error("bootstrap/loop falhou, WhatsApp segue conectado:", e?.message || e);
  }
});

client.on("auth_failure", (m) => console.error("[whats] auth_failure", m));

let reconnectDelay = 2000; // backoff exponencial simples
client.on("disconnected", (r) => {
  console.warn("[whats] disconnected", r);
  setTimeout(() => {
    console.log("[whats] tentando reconectar...");
    client.initialize();
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  }, reconnectDelay);
});

client.initialize();

/* ========= STATE ========= */
const STATE_FILE = path.join(__dirname, "..", ".bot_state.json");
const loadState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastSeen: {}, lastStatus: {}, bootstrapped: false };
  }
};
const saveState = (s) =>
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
let state = loadState();

/* ========= HELPERS ========= */
const fmt = (d) => (d ? new Date(d).toLocaleString("pt-BR") : "-");

function normalizeBR(phoneRaw) {
  if (!phoneRaw) return null;
  let d = String(phoneRaw).replace(/\D/g, "");
  d = d.replace(/^0+/, "");
  if (d.startsWith("55")) {
    if (d.length >= 12 && d.length <= 13) return d;
    return d.slice(0, 13);
  }
  if (d.length === 10 || d.length === 11) return "55" + d;
  return null;
}

async function logEnvio(p, osId, idLocal, destino, mensagem) {
  if (DISABLE_DB) return; // em modo sem DB, só pula
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.whats_envios (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        id_os INT NOT NULL,
        id_local VARCHAR(50) NOT NULL,
        destino VARCHAR(64) NOT NULL,
        mensagem TEXT NOT NULL,
        data_envio DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_os (id_os),
        KEY idx_local (id_local)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await p.query(
      `INSERT INTO ${SCHEMA}.whats_envios (id_os, id_local, destino, mensagem) VALUES (?, ?, ?, ?);`,
      [osId, idLocal, destino, mensagem],
    );
  } catch (e) {
    console.warn("[whats] Falha ao logar envio:", e?.message || e);
  }
}

/* ========= 🔔 Notificação do front (SSE) ========= */
const NOTIFY_URL = WHATS_NOTIFY_URL || "http://localhost:3001/api/whats/notify";

async function notifyFront({ id_os, id_local, to, text }) {
  try {
    await fetch(NOTIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "whats:sent",
        id_os,
        id_local,
        to,
        text,
        at: new Date().toISOString(),
      }),
    }).catch(() => {}); // fire-and-forget
  } catch (_) {
    /* silencioso */
  }
}

/** Resolve números para JIDs válidos (somente usuários registrados). */
async function resolveJids(numbers) {
  const out = [];
  for (const raw of numbers) {
    const num = normalizeBR(raw);
    if (!num) continue;
    try {
      const numberId = await client.getNumberId(num);
      if (numberId) out.push({ num, jid: numberId._serialized });
      else console.log(`✗ ${num} não está no WhatsApp (ignorado).`);
    } catch (e) {
      console.log(`✗ Falha ao resolver ${num}:`, e?.message || e);
    }
  }
  // remove duplicados por JID
  const seen = new Set();
  return out.filter(({ jid }) => (seen.has(jid) ? false : seen.add(jid)));
}

async function sendToValidated(numbers, text, osId, idLocal) {
  const p = DISABLE_DB ? null : await getPool();
  const targets = await resolveJids(numbers);
  for (const t of targets) {
    try {
      await client.sendMessage(t.jid, text);
      console.log(
        `[whats] → enviado p/ ${t.num} (jid=${t.jid}) | OS ${osId} | ${idLocal}`,
      );
      if (!DISABLE_DB) await logEnvio(p, osId, idLocal, t.jid, text);
      notifyFront({ id_os: osId, id_local: idLocal, to: t.num, text });
    } catch (e) {
      console.error(
        `[whats] Falha ao enviar p/ ${t.num} (jid=${t.jid}):`,
        e?.message || e,
      );
    }
  }
}

/* ========= BOOTSTRAP ========= */
async function bootstrap() {
  if (DISABLE_DB) return;
  const p = await getPool();
  if (state.bootstrapped) return;
  const [rows] = await p.query(
    `SELECT ${OS_PK} AS id_os, ${OS_ID_LOCAL} AS id_local, id_status_os FROM ${OS_TABLE}`,
  );
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
      `Problema: ${os.descricao_problema || "-"}\n` +
      `Criada: ${fmt(os.data_criacao)} | Atualizada: ${fmt(os.data_atualizacao)}`
  );
}

async function checkOnce() {
  if (DISABLE_DB) return;
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
      c.${CLIENTE_FONE} AS telefone_cliente
    FROM ${OS_TABLE} os
    LEFT JOIN ${CLIENTE_TABLE} c ON c.${CLIENTE_ID1} = os.${OS_ID_CLIENTE}
    LEFT JOIN ${SCHEMA}.status_os s ON s.id_status = os.id_status_os
    WHERE os.${OS_DATA_AT} >= NOW() - INTERVAL 2 DAY
    ORDER BY os.${OS_DATA_AT} DESC, os.${OS_PK} DESC
  `);

  for (const os of rows) {
    const prevLocal = state.lastSeen[os.id_os];
    const prevStatus = state.lastStatus[os.id_os];

    // Monte lista de destinos: cliente + extras por local
    const to = [];
    const telCliente = normalizeBR(os.telefone_cliente);
    if (telCliente) to.push(telCliente);
    const extras = EXTRA_ROUTES.get(os.id_local) || [];
    for (const raw of extras) {
      const e = normalizeBR(raw);
      if (e) to.push(e);
    }

    // Atualiza baseline se não houver destino
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
      const texto =
        MESSAGES_BY_LOCAL.get("LOC001") || messageForLocal(os.id_local, os);
      await sendToValidated(to, texto, os.id_os, os.id_local);
      continue;
    }

    // Mudança de LOCAL
    if (prevLocal !== os.id_local) {
      state.lastSeen[os.id_os] = os.id_local;
      state.lastStatus[os.id_os] = os.id_status_os;
      saveState(state);
      const texto = messageForLocal(os.id_local, os);
      await sendToValidated(to, texto, os.id_os, os.id_local);
      continue;
    }

    // Mudança de STATUS
    if (prevStatus !== os.id_status_os) {
      state.lastStatus[os.id_os] = os.id_status_os;
      saveState(state);
      if (os.status_desc && MESSAGES_BY_STATUS.has(os.status_desc)) {
        const texto = MESSAGES_BY_STATUS.get(os.status_desc);
        await sendToValidated(to, texto, os.id_os, os.id_local);
      }
    }
  }
}

function loop() {
  if (DISABLE_DB) return;
  checkOnce().catch((e) => console.error("[whats] Loop error:", e));
  setInterval(
    () => checkOnce().catch((e) => console.error("[whats] Loop error:", e)),
    Number(POLL_INTERVAL_MS),
  );
}
// ========= ENVIO DIRETO PARA RECUPERAÇÃO DE SENHA ========= //

/**
 * Envia uma mensagem simples para um único número (sem amarrar em OS).
 * Usado, por exemplo, para envio de código de recuperação de senha.
 *
 * @param {string} phoneRaw - Telefone em qualquer formato (com ou sem DDD/55)
 * @param {string} text - Mensagem de texto a ser enviada
 */
async function sendDirectMessage(phoneRaw, text) {
  const num = normalizeBR(phoneRaw);
  if (!num) {
    throw new Error(`Telefone inválido: ${phoneRaw}`);
  }

  try {
    const numberId = await client.getNumberId(num);
    if (!numberId) {
      throw new Error(`Número ${num} não está no WhatsApp`);
    }

    const jid = numberId._serialized;
    await client.sendMessage(jid, text);

    console.log(`[whats] (direct) enviado para ${num} | jid=${jid}`);
  } catch (e) {
    console.error(
      `[whats] Falha ao enviar mensagem direta para ${phoneRaw}:`,
      e?.message || e,
    );
    throw e;
  }
}

// Exporta a função para outros arquivos poderem usar
module.exports = {
  sendDirectMessage,
};
