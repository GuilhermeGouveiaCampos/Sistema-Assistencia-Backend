// backend/routes/dashboard.js
const express = require('express');
const router = express.Router();
const db = require('../db'); // mysql2/promise pool

// Ajuste estes IDs se na sua tabela status_os forem diferentes:
const STATUS_FINALIZADO   = 6;
const STATUS_CANCELADO    = 8;
const STATUS_DIAGNOSTICO  = 2;

router.get('/summary', async (req, res) => {
  const period = (req.query.period || 'day').toLowerCase(); // 'day' | 'month'
  const filtroTempoEntregues = (period === 'month')
    ? `YEAR(os.data_atualizacao) = YEAR(CURDATE()) AND MONTH(os.data_atualizacao) = MONTH(CURDATE())`
    : `DATE(os.data_atualizacao) = CURDATE()`;

  try {
    const conn = await db.getConnection();

    // 1) Total de clientes ativos
    const [[{ total_clientes }]] = await conn.query(
      "SELECT COUNT(*) AS total_clientes FROM cliente WHERE status='ativo'"
    );

    // 2) OS em aberto (não finalizadas/canceladas)
    const [[{ em_aberto }]] = await conn.query(
      `SELECT COUNT(*) AS em_aberto
         FROM ordenservico
        WHERE id_status_os NOT IN (?, ?)`,
      [STATUS_FINALIZADO, STATUS_CANCELADO]
    );

    // 3) Entregues (finalizadas) hoje/mês
    const [[{ entregues }]] = await conn.query(
      `SELECT COUNT(*) AS entregues
         FROM ordenservico os
        WHERE os.id_status_os = ?
          AND ${filtroTempoEntregues}`,
      [STATUS_FINALIZADO]
    );

    // 4) Em diagnóstico
    const [[{ em_diagnostico }]] = await conn.query(
      `SELECT COUNT(*) AS em_diagnostico
         FROM ordenservico
        WHERE id_status_os = ?`,
      [STATUS_DIAGNOSTICO]
    );

    // 5) Distribuição por status (para lista/gráfico)
    const [por_status] = await conn.query(
      `SELECT s.descricao AS status, COUNT(*) AS total
         FROM ordenservico os
         JOIN status_os s ON s.id_status = os.id_status_os
        GROUP BY s.descricao
        ORDER BY total DESC`
    );

    // 6) OS por técnico (apenas abertas)
    const [por_tecnico] = await conn.query(
      `SELECT t.nome, COUNT(*) AS abertas
         FROM ordenservico os
         JOIN tecnico t ON t.id_tecnico = os.id_tecnico
        WHERE os.id_status_os NOT IN (?, ?)
        GROUP BY t.nome
        ORDER BY abertas DESC`,
      [STATUS_FINALIZADO, STATUS_CANCELADO]
    );

    // 7) Últimas OS (feedzinho)
    const [ultimas_ordens] = await conn.query(
      `SELECT os.id_os AS id_ordem,
              COALESCE(c.nome, CONCAT('Cliente #', e.id_cliente)) AS cliente,
              l.local_instalado AS local,
              os.data_criacao,
              os.data_atualizacao,
              s.descricao AS status
         FROM ordenservico os
    LEFT JOIN cliente c     ON c.id_cliente = os.id_cliente
    LEFT JOIN equipamento e ON e.id_equipamento = os.id_equipamento
    LEFT JOIN local l       ON l.id_scanner = os.id_local
    LEFT JOIN status_os s   ON s.id_status = os.id_status_os
        ORDER BY os.id_os DESC
        LIMIT 8`
    );

    // 8) WhatsApp: mensagens enviadas hoje (a partir de whats_envios)
    let msgs_hoje = 0;
    try {
      const [[row]] = await conn.query(
        `SELECT COUNT(*) AS msgs_hoje
           FROM whats_envios
          WHERE DATE(data_envio) = CURDATE()`
      );
      msgs_hoje = row.msgs_hoje || 0;
    } catch (_) {
      msgs_hoje = 0; // se a tabela não existir no ambiente, não quebra
    }

    conn.release();
    res.json({
      total_clientes,
      em_aberto,
      entregues,
      em_diagnostico,
      por_status,
      por_tecnico,
      ultimas_ordens,
      msgs_hoje
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Falha ao carregar resumo' });
  }
});

module.exports = router;
