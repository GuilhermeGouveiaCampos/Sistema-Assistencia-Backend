// backend/middleware/authLeitor.js
const db = require('../db');
const bcrypt = require('bcryptjs');

async function authLeitor(req, res, next) {
  const codigo = req.header('x-leitor-codigo');
  const apiKey = req.header('x-api-key');
  if (!codigo || !apiKey) {
    return res.status(401).json({ erro: 'Credenciais do leitor ausentes' });
  }

  const [rows] = await db.query(
    'SELECT codigo, id_local, id_scanner, api_key_hash, status FROM rfid_leitor WHERE codigo = ? LIMIT 1',
    [codigo]
  );
  const leitor = rows[0];
  if (!leitor || leitor.status !== 'ativo') {
    return res.status(401).json({ erro: 'Leitor inválido ou inativo' });
  }

  const ok = await bcrypt.compare(apiKey, leitor.api_key_hash);
  if (!ok) {
    return res.status(401).json({ erro: 'API key inválida' });
  }

  req.leitor = leitor; // deixa os dados do leitor disponíveis para a rota
  next();
}

module.exports = { authLeitor };
