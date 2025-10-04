// server.js

require("dotenv").config();

const path = require("path");
const fs = require("fs");
const { EventEmitter } = require("events");

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
const mysql = require("mysql2");

const app = express();

/* ===========================
   🔔 Event Bus (SSE p/ WhatsApp)
   =========================== */
// no topo
const eventBus = new EventEmitter();
app.set("eventBus", eventBus);

/* ===========================
   Versão / commit
   =========================== */
const COMMIT =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  "local";
app.get("/version", (_req, res) =>
  res.json({ commit: COMMIT, time: new Date().toISOString() }),
);

/* ===========================
   Segurança / performance
   =========================== */
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
app.use(compression());
app.use(express.json({ limit: "2mb" }));
app.use(
  morgan(":method :url :status :res[content-length] - :response-time ms"),
);

app.set("trust proxy", 1);

/* ===========================
   CORS (único e global)
   =========================== */
const allowedExact = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  // pode deixar fixo se quiser só esse domínio em prod:
  "https://sistema-assistencia-frontend-dhb7ls4bl.vercel.app",
]);

function isAllowedOrigin(origin) {
  if (!origin) return true; // curl/Postman/health-checks
  try {
    const url = new URL(origin);
    if (url.hostname.endsWith(".vercel.app")) return true; // previews Vercel
    if (allowedExact.has(origin)) return true;
  } catch (_) {}
  return false;
}

app.use((_, res, next) => {
  res.header("Vary", "Origin");
  next();
});

app.use(
  cors({
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-user-id",
      "x-leitor-codigo",
      "x-api-key",
      "x-leitor-key",
    ],
    optionsSuccessStatus: 204,
  }),
);
app.options("*", cors());

/* ===========================
   Uploads / arquivos estáticos
   =========================== */
const uploadsRoot = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR) // ex: /data/uploads/os
  : path.join(__dirname, "uploads", "os");
const uploadsBase = path.dirname(uploadsRoot); // ex: /data/uploads  (ou /app/uploads)

try {
  fs.mkdirSync(uploadsRoot, { recursive: true });
  fs.mkdirSync(uploadsBase, { recursive: true });
} catch (e) {
  console.warn("Não foi possível criar pastas de upload:", e?.message || e);
}

// /uploads/os -> pasta de OS
app.use("/uploads/os", express.static(uploadsRoot, { maxAge: "7d" }));
// /uploads -> base (onde ficará o whatsapp-qr.png)
app.use("/uploads", express.static(uploadsBase, { maxAge: "7d" }));

app.get("/whatsapp-qr", (_req, res) => {
  const fp = path.join(uploadsBase, "whatsapp-qr.png"); // <— ajustado
  if (fs.existsSync(fp)) return res.sendFile(fp);
  return res.status(404).json({ erro: "QR ainda não foi gerado." });
});

app.get("/whatsapp-qr-live", (_req, res) => {
  const v = Date.now();
  res.type("html").send(`<!doctype html>
<meta charset="utf-8" />
<title>WhatsApp QR</title>
<style>
  body{display:grid;place-items:center;height:100vh;font-family:sans-serif}
  img{max-width:90vmin}
</style>
<h1>Escaneie o QR do WhatsApp</h1>
<img id="qr" src="/uploads/whatsapp-qr.png?v=${v}" alt="QR Code do WhatsApp" />
<script src="/qr-refresh.js"></script>
`);
});

// JS externo para atualizar a imagem sem inline script/handlers
app.get("/qr-refresh.js", (_req, res) => {
  res.type("application/javascript").send(`
    (function(){
      var img = document.getElementById('qr');
      function refresh(){ img.src = '/uploads/whatsapp-qr.png?v=' + Date.now(); }
      setInterval(refresh, 15000);
      // primeira tentativa de recarregar depois de 2s para cobrir o caso 404 inicial
      setTimeout(refresh, 2000);
    })();
  `);
});


/* ===========================
   MySQL (envs no Railway)
   =========================== */
const db = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || process.env.DB_PASS || "",
  database: process.env.DB_NAME || "assistencia_tecnica",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  multipleStatements: false,
  charset: "utf8mb4",
  dateStrings: true,
});
db.getConnection((err, conn) => {
  if (err) console.error("❌ Erro ao conectar no MySQL:", err.message);
  else {
    console.log("✅ Pool MySQL pronto");
    conn.release();
  }
});
app.set("db", db);

/* ===========================
   Health checks
   =========================== */
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, env: process.env.NODE_ENV || "dev" }),
);
app.get("/api/teste", (_req, res) =>
  res.json({ mensagem: "API funcionando!" }),
);

/* ===========================
   Rate limit
   =========================== */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  skip: (req) => req.method === "OPTIONS",
});
app.use("/api", apiLimiter);

/* ===========================
   🔔 SSE: eventos de WhatsApp enviados
   =========================== */
app.get("/api/whats/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (payload) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (_) {
      // ignore write errors (client may have disconnected)
    }
  };

  const onSent = (payload) => send(payload);
  eventBus.on("whats:sent", onSent);

  req.on("close", () => {
    eventBus.off("whats:sent", onSent);
    res.end();
  });
});

/* ===========================
   Rotas da aplicação
   =========================== */
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/ordens/inativas", require("./routes/ordensInativas"));
// 🔧 CORREÇÃO prévia: removida a segunda declaração de `app` que causava o erro
const ordensRouter = require("./routes/ordens");
app.use("/api/ordens", ordensRouter);
app.use("/api/ordemservico", ordensRouter);

app.use("/api/usuarios", require("./routes/usuarios"));
app.use("/api/login", require("./routes/login"));
app.use("/api/clientes", require("./routes/clientes"));
app.use("/api/equipamentos", require("./routes/equipamentos"));
app.use("/api/locais", require("./routes/rfid"));
app.use("/api/tecnicos-balanceados", require("./routes/tecnicosBalanceados"));
app.use("/api/tecnicos", require("./routes/tecnicos"));
app.use("/api/status", require("./routes/status"));
app.use("/api/ordens-consulta", require("./routes/ordensConsulta"));
app.use("/api/rfid", require("./routes/leitores"));
app.use("/api/ardloc", require("./routes/ardloc"));
const relatorios = require("./routes/relatorios");
console.log(
  "Tipo relatorios =",
  typeof relatorios,
  "keys:",
  Object.keys(relatorios),
);
app.use(
  "/api/relatorios",
  relatorios.default || relatorios.router || relatorios,
);

/* ===========================
   Tratamento de erros
   =========================== */
process.on("unhandledRejection", (reason) => {
  console.error("🛑 UnhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("🛑 UncaughtException:", err);
});

app.use((err, req, res, next) => {
  console.error("🧯 Erro não tratado:", err?.sqlMessage || err);
  res.status(500).json({ erro: "Erro interno no servidor." });
});

app.get("/debug/wpp", (_req, res) => {
  const base = process.env.WPP_DATA_PATH || "/data/.wwebjs_auth";
  try {
    const list = fs.readdirSync(base);
    const sessions = list.filter((n) => n.startsWith("session-"));
    res.json({ base, list, sessions });
  } catch (e) {
    res.status(500).json({ base, error: e.message });
  }
});
// --- INICIAR O BOT DO WHATSAPP (precisa disso!) ---
if (process.env.ENABLE_WPP === "1") {
  console.log("🤖 Inicializando bot do WhatsApp...");
  require("./utils/whats-bot");
}
app.get("/api/wpp/qr-exists", (_req, res) => {
  const uploadsRoot = process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR) // /data/uploads
    : path.join(__dirname, "uploads", "os");
  const uploadsBase = path.dirname(uploadsRoot); // /data
  const qrPath = path.join(uploadsBase, "whatsapp-qr.png");
  const exists = fs.existsSync(qrPath);
  res.json({ uploadsRoot, uploadsBase, qrPath, exists });
});


/* ===========================
   Sobe servidor
   =========================== */
const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor ouvindo em 0.0.0.0:${PORT}`);
  console.log(
    "QR do WhatsApp (se gerado): /whatsapp-qr  ou  /uploads/whatsapp-qr.png",
  );
});
