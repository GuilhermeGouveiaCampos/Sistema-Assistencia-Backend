// server.js

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
const mysql = require("mysql2"); // callback API (compatível com suas rotas)

const app = express();

/* ===========================
   Segurança / performance
   =========================== */
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }, // permite servir /uploads
  })
);
app.use(compression());
app.use(express.json({ limit: "2mb" }));
app.use(morgan(":method :url :status :res[content-length] - :response-time ms"));

// Confiar em proxy (Railway/Render/Heroku/NGINX)
app.set("trust proxy", 1);

/* ===========================
   CORS robusto (antes de rotas e limiters!)
   =========================== */
const allowedExact = new Set([
  "http://localhost:5173", // Vite dev
  "https://sistema-assistencia-frontend.vercel.app", // seu domínio "prod"
]);

function isAllowedOrigin(origin) {
  if (!origin) return true; // server-to-server, curl, health checks
  try {
    const url = new URL(origin);
    // Libera qualquer preview do projeto na Vercel (.vercel.app)
    if (url.hostname.endsWith(".vercel.app")) return true;
    if (allowedExact.has(origin)) return true;
  } catch (_) {}
  return false;
}

// Ajuda caches/CDN a variar por Origin
app.use((_, res, next) => {
  res.header("Vary", "Origin");
  next();
});

app.use(
  cors({
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true);
      // Não lance erro aqui — negar silenciosamente evita 500 "Network Error"
      return cb(null, false);
    },
    credentials: false, // use true apenas se for trabalhar com cookies/sessões
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-user-id"],
    optionsSuccessStatus: 204,
  })
);

// Responde preflight em todas as rotas
app.options("*", cors());

/* ===========================
   Rate limit (não conte OPTIONS)
   =========================== */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  skip: (req) => req.method === "OPTIONS",
});
app.use("/api", apiLimiter);

/* ===========================
   Arquivos estáticos (uploads)
   =========================== */
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* ===========================
   MySQL (envs no Railway)
   =========================== */
const db = mysql.createConnection({
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
  database: process.env.DB_NAME || "assistencia_tecnica",
  multipleStatements: false,
});

db.connect((err) => {
  if (err) {
    console.error("❌ Erro ao conectar no MySQL:", err.message);
  } else {
    console.log("✅ Conectado ao MySQL!");
  }
});
app.set("db", db);

/* ===========================
   Health checks / teste
   =========================== */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || "dev" });
});
app.get("/api/teste", (req, res) => {
  res.json({ mensagem: "API funcionando!" });
});

/* ===========================
   Rotas da aplicação
   =========================== */
app.use("/api/ordens/inativas", require("./routes/ordensInativas"));

const ordensRouter = require("./routes/ordens");
app.use("/api/ordens", ordensRouter);
app.use("/api/ordemservico", ordensRouter); // alias caso o front use outro path

app.use("/api/usuarios", require("./routes/usuarios"));
app.use("/api/login", require("./routes/login"));
app.use("/api/clientes", require("./routes/clientes"));
app.use("/api/equipamentos", require("./routes/equipamentos"));
app.use("/api/locais", require("./routes/rfid"));
app.use("/api/tecnicos", require("./routes/tecnicos"));
app.use("/api/tecnicos", require("./routes/tecnicosBalanceados"));
app.use("/api/status", require("./routes/status"));
app.use("/api/ordens-consulta", require("./routes/ordensConsulta"));

/* ===========================
   Tratamento de erros globais
   =========================== */
process.on("unhandledRejection", (reason) => {
  console.error("🛑 UnhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("🛑 UncaughtException:", err);
});

/* ===========================
   Sobe servidor
   =========================== */
const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor ouvindo em 0.0.0.0:${PORT}`);
});
