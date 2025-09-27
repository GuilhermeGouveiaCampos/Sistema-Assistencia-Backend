// backend/routes/dashboard.js
const express = require('express');
const router = express.Router();
const db = require('../db'); // seu pool mysql2/promise (ou use app.get('db') se preferir)

const STATUS_FINALIZADO   = 6;
const STATUS_CANCELADO    = 8;
const STATUS_DIAGNOSTICO  = 2;

function buildPeriodWhere(field, period) {
  switch ((period || 'today').toLowerCase()) {
    case 'today':
    case 'day':
      return `DATE(${field}) = CURDATE()`;
    case 'yesterday':
      return `DATE(${field}) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)`;
    case '7d':
      return `${field} >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)`;
    case '15d':
      return `${field} >= DATE_SUB(CURDATE(), INTERVAL 15 DAY)`;
    case '30d':
      return `${field} >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`;
    case 'month':
      return `YEAR(${field}) = YEAR(CURDATE()) AND MONTH(${field}) = MONTH(CURDATE())`;
    default:
      return `DATE(${field}) = CURDATE()`;
  }
}

router.get('/summary', async (req, res) => {
  const period = (req.query.period || 'today').toLowerCase();
  const filtroTempoEntregues = buildPeriodWhere('os.data_atualizacao', period);
  const filtroTempoTecFinal = buildPeriodWhere('os.data_atualizacao', period);

  try {
    const conn = await db.getConnection();

    // 1) Total de clientes (ativos)
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

    // 3) Entregues (finalizadas) no período
    const [[{ entregues }]] = await conn.query(
      `SELECT COUNT(*) AS entregues
         FROM ordenservico os
        WHERE os.id_status_os = ?
          AND ${filtroTempoEntregues}`,
      [STATUS_FINALIZADO]
    );

    // 4) Em diagnóstico (snapshot atual)
    const [[{ em_diagnostico }]] = await conn.query(
      `SELECT COUNT(*) AS em_diagnostico
         FROM ordenservico
        WHERE id_status_os = ?`,
      [STATUS_DIAGNOSTICO]
    );

    // 5) Distribuição por status (snapshot atual)
    const [por_status] = await conn.query(
      `SELECT s.descricao AS status, COUNT(*) AS total
         FROM ordenservico os
         JOIN status_os s ON s.id_status = os.id_status_os
        GROUP BY s.descricao
        ORDER BY total DESC`
    );

    // 6) Técnicos (snapshot atual) — LEFT JOIN para trazer quem tem 0 OS aberta
    const [por_tecnico_abertas] = await conn.query(
      `SELECT t.nome,
              COALESCE(SUM(CASE WHEN os.id_status_os NOT IN (?, ?) THEN 1 ELSE 0 END), 0) AS abertas
         FROM tecnico t
    LEFT JOIN ordenservico os
           ON os.id_tecnico = t.id_tecnico
        GROUP BY t.nome
        ORDER BY abertas DESC, t.nome ASC`,
      [STATUS_FINALIZADO, STATUS_CANCELADO]
    );

    // 7) Técnicos finalizadas no período
    const [por_tecnico_finalizadas_periodo] = await conn.query(
      `SELECT t.nome,
              COALESCE(SUM(CASE WHEN os.id_status_os = ? AND ${filtroTempoTecFinal} THEN 1 ELSE 0 END), 0) AS finalizadas_periodo
         FROM tecnico t
    LEFT JOIN ordenservico os
           ON os.id_tecnico = t.id_tecnico
        GROUP BY t.nome
        ORDER BY finalizadas_periodo DESC, t.nome ASC`,
      [STATUS_FINALIZADO]
    );

    // funde os dados num array detalhado
    const mapaFinal = new Map();
    por_tecnico_abertas.forEach((r) => mapaFinal.set(r.nome, { nome: r.nome, abertas: Number(r.abertas) || 0, finalizadas_periodo: 0 }));
    por_tecnico_finalizadas_periodo.forEach((r) => {
      const item = mapaFinal.get(r.nome) || { nome: r.nome, abertas: 0, finalizadas_periodo: 0 };
      item.finalizadas_periodo = Number(r.finalizadas_periodo) || 0;
      mapaFinal.set(r.nome, item);
    });
    const por_tecnico = Array.from(mapaFinal.values());

    // 8) Últimas OS (feed)
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

    // 9) WhatsApp: mensagens enviadas hoje
    let msgs_hoje = 0;
    try {
      const [[row]] = await conn.query(
        `SELECT COUNT(*) AS msgs_hoje
           FROM whats_envios
          WHERE DATE(data_envio) = CURDATE()`
      );
      msgs_hoje = row.msgs_hoje || 0;
    } catch (_) {}

    conn.release();
    res.json({
      total_clientes,
      em_aberto,
      entregues,
      em_diagnostico,
      por_status,
      por_tecnico, // agora inclui abertas + finalizadas no período (com 0)
      ultimas_ordens,
      msgs_hoje,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Falha ao carregar resumo' });
  }
});

module.exports = router;
