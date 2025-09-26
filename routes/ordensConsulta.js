// routes/ordens-consulta.js
const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  const { nome_cliente, status } = req.query;

  // Monta os filtros primeiro
  const where = ['o.status = "ativo"'];
  const params = [];

  if (nome_cliente && nome_cliente.trim() !== '') {
    where.push('c.nome LIKE ?');
    params.push(`%${nome_cliente}%`);
  }

  if (status && status.trim() !== '') {
    // filtra pelo texto do status (tabela status_os)
    where.push('s.descricao LIKE ?');
    params.push(`%${status}%`);
  }

  // Só no final coloca o ORDER BY
  const sql = `
    SELECT
      o.id_os AS id_ordem,
      c.nome AS nome_cliente,
      e.tipo AS tipo_equipamento,
      e.marca,
      e.modelo,
      e.numero_serie,
      o.data_criacao AS data_entrada,
      o.descricao_problema,
      o.id_status_os,
      o.id_local,
      s.descricao AS status
    FROM ordenservico o
    JOIN cliente     c ON o.id_cliente     = c.id_cliente
    JOIN status_os   s ON o.id_status_os   = s.id_status
    LEFT JOIN equipamento e ON o.id_equipamento = e.id_equipamento
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY o.id_os DESC
  `;

  try {
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (error) {
    console.error('❌ ERRO COMPLETO NO BACKEND:', error?.sqlMessage || error);
    res.status(500).json({ erro: 'Erro ao buscar ordens de serviço' });
  }
});

module.exports = router;
