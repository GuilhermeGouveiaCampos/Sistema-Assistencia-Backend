// backend/routes/status.js
const express = require('express');
const router = express.Router();
const db = require('../db');

// 🔍 Buscar todos os status de ordem de serviço
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM status_os');
    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar status:", err);
    res.status(500).json({ erro: "Erro ao buscar status." });
  }
});

module.exports = router;
