const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/__ping', (_req, res) =>
  res.json({ ok: true, where: '/api/ordens/inativas' })
);

// GET /api/ordens/inativas
router.get('/', async (_req, res) => {
  try {
    const sql = `
      SELECT
        o.id_os            AS id_ordem,
        c.nome             AS nome_cliente,
        e.tipo             AS tipo_equipamento,
        e.marca,
        e.modelo,
        e.numero_serie,
        o.data_criacao     AS data_entrada,
        o.descricao_problema
      FROM ordenservico o
      LEFT JOIN equipamento e ON o.id_equipamento = e.id_equipamento
      LEFT JOIN cliente    c ON o.id_cliente     = c.id_cliente
      WHERE o.status = 'inativo'
      ORDER BY o.id_os DESC
    `;
    const [rows] = await db.query(sql);
    res.json(rows);
  } catch (err) {
    console.error('💥 Erro ao buscar inativas:', err);
    res.status(500).json({ erro: 'Erro interno ao buscar ordens inativas' });
  }
});

module.exports = router;
