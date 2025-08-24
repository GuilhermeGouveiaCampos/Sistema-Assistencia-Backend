// Carrega variáveis locais (somente em dev)
// No Railway você define as "Variables" no painel
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const mysql = require('mysql2'); // mysql2 (callback) compatível com suas rotas

const app = express();

/* ===========================
   Middlewares base de produção
   =========================== */
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' } // permite servir /uploads
}));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));

// CORS: libere seu domínio da Vercel e localhost do Vite
const allowedOrigins = [
  process.env.FRONTEND_URL,   // ex.: https://seu-frontend.vercel.app
  'http://localhost:5173'     // dev local
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // permite curl/server-to-server
    const ok =
      allowedOrigins.some(o => origin === o) ||
      (origin && origin.endsWith('.vercel.app')); // aceita previews da Vercel
    return ok ? cb(null, true) : cb(new Error('CORS bloqueado: ' + origin));
  },
  credentials: true
}));

// Necessário atrás de proxy (Railway/Render/Heroku)
app.set('trust proxy', 1);

// Rate limit básico para /api
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000
});
app.use('/api', apiLimiter);

/* ===========================
   Arquivos estáticos (uploads)
   =========================== */
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/* ===========================
   Conexão com MySQL via env
   =========================== */
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'assistencia_tecnica',
  multipleStatements: false
});

db.connect(err => {
  if (err) {
    console.error('❌ Erro ao conectar no MySQL:', err.message);
  } else {
    console.log('✅ Conectado ao MySQL!');
  }
});

app.set('db', db);

/* ===========================
   Rotas utilitárias
   =========================== */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || 'dev' });
});

app.get('/api/teste', (req, res) => {
  res.json({ mensagem: 'API funcionando!' });
});

/* ===========================
   Suas rotas
   =========================== */
const ordensInativasRouter = require('./routes/ordensInativas');
app.use('/api/ordens/inativas', ordensInativasRouter);

const ordensRouter = require('./routes/ordens');
app.use('/api/ordens', ordensRouter);
app.use('/api/ordemservico', ordensRouter); // alias, se usa no front

const usuariosRoutes = require('./routes/usuarios');
app.use('/api/usuarios', usuariosRoutes);

const loginRoutes = require('./routes/login');
app.use('/api/login', loginRoutes);

const clientesRouter = require('./routes/clientes');
app.use('/api/clientes', clientesRouter);

const equipamentosRouter = require('./routes/equipamentos');
app.use('/api/equipamentos', equipamentosRouter);

const rfidRoutes = require('./routes/rfid');
app.use('/api/locais', rfidRoutes);

const rotaTecnicos = require('./routes/tecnicos');
app.use('/api/tecnicos', rotaTecnicos);

const tecnicosBalanceadosRoutes = require('./routes/tecnicosBalanceados');
app.use('/api/tecnicos', tecnicosBalanceadosRoutes);

const statusRoutes = require('./routes/status');
app.use('/api/status', statusRoutes);

const ordensConsultaRoutes = require('./routes/ordensConsulta');
app.use('/api/ordens-consulta', ordensConsultaRoutes);

/* ===========================
   Sobe servidor
   =========================== */
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor ouvindo em 0.0.0.0:${PORT}`);
});
