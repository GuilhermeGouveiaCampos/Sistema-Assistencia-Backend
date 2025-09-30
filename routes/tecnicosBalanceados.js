// routes/tecnicosBalanceados.js
const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/tecnicos-balanceados/menos-carregados/:tipoEquipamento
router.get('/menos-carregados/:tipoEquipamento', async (req, res) => {
  const tipoEquipamento = decodeURIComponent(req.params.tipoEquipamento || '').trim();

  try {
    // 1) Tenta mapear a especialização a partir do tipo (exato e SOUNDEX)
    let especializacao = null;

    const [[exata]] = await db.query(
      `SELECT especializacao
         FROM especializacao_equipamento
        WHERE LOWER(tipo_equipamento) = LOWER(?)
        LIMIT 1`,
      [tipoEquipamento]
    );
    if (exata?.especializacao) {
      especializacao = exata.especializacao;
    } else {
      const [[aprox]] = await db.query(
        `SELECT especializacao
           FROM especializacao_equipamento
          WHERE SOUNDEX(tipo_equipamento) = SOUNDEX(?)
          ORDER BY CASE WHEN LOWER(tipo_equipamento) = LOWER(?) THEN 0 ELSE 1 END
          LIMIT 1`,
        [tipoEquipamento, tipoEquipamento]
      );
      if (aprox?.especializacao) especializacao = aprox.especializacao;
    }

    // 2) Descobrir IDs de status encerrados (ajuste as descrições se forem diferentes)
    const [closedRows] = await db.query(
      `SELECT id_status FROM status_os WHERE descricao IN ('Finalizado','Cancelado')`
    );
    const closedIds = closedRows.map(r => r.id_status);
    const closedPH = closedIds.length ? closedIds.map(() => '?').join(',') : null;

    // 3) WHERE de especialização (se houver) + sempre permitir "eletroport%"
    const whereParts = [];
    const paramsWhere = [];

    if (especializacao) {
      whereParts.push(`t.especializacao = ?`);
      paramsWhere.push(especializacao);
    }
    whereParts.push(`LOWER(t.especializacao) LIKE ?`);
    paramsWhere.push('%eletroport%');

    const whereEspecializacao = whereParts.length
      ? `AND (${whereParts.join(' OR ')})`
      : '';

    // 4) Base da contagem de OS em aberto
    const cargaCol = `
      COALESCE(SUM(
        CASE WHEN o.id_os IS NOT NULL THEN
          CASE
            WHEN o.status = 'ativo' ${closedPH ? `AND o.id_status_os NOT IN (${closedPH})` : ``}
            THEN 1 ELSE 0
          END
        ELSE 0 END
      ), 0)
    `;

    // 5) Primeira tentativa: respeitando especialização
    const sqlPreferencial = `
      SELECT
        t.id_tecnico,
        t.nome,
        t.especializacao,
        ${cargaCol} AS total_ordens
      FROM tecnico t
      LEFT JOIN ordenservico o ON o.id_tecnico = t.id_tecnico
      WHERE t.status = 'ativo'
        ${whereEspecializacao}
      GROUP BY t.id_tecnico, t.nome, t.especializacao
      ORDER BY total_ordens ASC, t.id_tecnico ASC
      LIMIT 1
    `;
    const paramsPreferencial = closedPH
      ? [...closedIds, ...paramsWhere]
      : [...paramsWhere];

    let [tecnicos] = await db.query(sqlPreferencial, paramsPreferencial);

    // 6) Fallback: sem filtro de especialização, priorizando "geral"
    //    (geral, generalista, multi, multidisciplinar)
    let mensagem = null;
    let usada_especializacao = especializacao || '(sem mapeamento; eletroport como fallback)';

    if (!tecnicos.length) {
      const sqlFallback = `
        SELECT
          t.id_tecnico,
          t.nome,
          t.especializacao,
          ${cargaCol} AS total_ordens
        FROM tecnico t
        LEFT JOIN ordenservico o ON o.id_tecnico = t.id_tecnico
        WHERE t.status = 'ativo'
        GROUP BY t.id_tecnico, t.nome, t.especializacao
        ORDER BY
          CASE
            WHEN LOWER(t.especializacao) IN ('geral','generalista','multi','multidisciplinar') THEN 0
            ELSE 1
          END,
          total_ordens ASC,
          t.id_tecnico ASC
        LIMIT 1
      `;
      const paramsFallback = closedPH ? [...closedIds] : [];
      const [fb] = await db.query(sqlFallback, paramsFallback);

      if (!fb.length) {
        // nada mesmo: sem técnico ativo
        return res.status(404).json({ erro: 'Nenhum técnico disponível.' });
      }

      const tec = fb[0];
      mensagem =
        `Não temos um técnico com essa especialização (` +
        `${tipoEquipamento}). ` +
        `Vinculamos ao técnico *${tec.nome}* por ser o menos carregado ` +
        `e atuar como especialista geral.`;
      usada_especializacao = '(fallback geral)';
      tecnicos = fb; // usa o técnico fallback
    }

    // 7) Resposta padronizada
    return res.json({
      ...tecnicos[0],
      usada_especializacao,
      mensagem: mensagem || null,
      origem: mensagem ? 'fallback' : 'preferencial'
    });

  } catch (error) {
    console.error('❌ Erro ao buscar técnico menos carregado:', error);
    return res.status(500).json({
      erro: 'Erro interno ao buscar técnico balanceado.',
      detalhe: error?.sqlMessage || error?.message || String(error)
    });
  }
});

module.exports = router;
