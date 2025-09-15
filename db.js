// backend/db.js
require('dotenv').config();
const mysql = require('mysql2/promise');

let pool;

function buildPool() {
  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 15000
  });
}
buildPool();

// teste inicial (não encerra o processo se falhar)
(async function warmup() {
  try {
    const c = await pool.getConnection();
    await c.ping();
    c.release();
    console.log('✅ Pool MySQL pronto e acessível');
  } catch (e) {
    console.error('⚠️ Não conectou no MySQL ainda:', e.message);
  }
})();

// retry a cada 20s em background (log mínimo)
setInterval(async () => {
  try {
    const c = await pool.getConnection();
    await c.ping();
    c.release();
  } catch (e) {
    console.error('⚠️ Ping MySQL falhou:', e.message);
  }
}, 20000);

/// helper para query com auto-rebuild se pool quebrar
async function query(sql, params) {
  try {
    return await pool.query(sql, params);
  } catch (e) {
    if (e && /Server has gone away|closed/i.test(e.message || '')) {
      console.warn('♻️ Recriando pool MySQL…');
      buildPool();
    }
    throw e;
  }
}

// ✅ >>> ADIÇÃO MINIMAL: expor getConnection, mantendo o que já havia
async function getConnection() {
  return pool.getConnection();
}

module.exports = {
  query,
  getConnection,        // <- agora usuarios.js pode usar db.getConnection()
  getPool: () => pool,  // mantém compatibilidade com quem usa getPool()
};
