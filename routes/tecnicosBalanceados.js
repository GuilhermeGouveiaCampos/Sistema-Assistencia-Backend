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

    // 3) Filtro de especialização:
    //    - Se mapeou 'especializacao', permite exatamente ela
    //    - SEMPRE permite qualquer especialização que contenha "eletroport" (com ou sem acento)
    const parts = [];
    const paramsWhere = [];

    if (especializacao) {
      parts.push(`t.especializacao = ?`);
      paramsWhere.push(especializacao);
    }
    parts.push(`LOWER(t.especializacao) LIKE ?`);
    paramsWhere.push('%eletroport%'); // cobre “eletroportáteis”, “eletroportateis” etc.

    const whereEspecializacao = `AND (${parts.join(' OR ')})`;

    // 4) SQL: técnico ativo com MENOS OS em aberto
    const sql = `
      SELECT
        t.id_tecnico,
        t.nome,
        t.especializacao,
        COALESCE(SUM(
          CASE
            WHEN o.id_os IS NOT NULL THEN
              CASE
                WHEN o.status = 'ativo' ${closedPH ? `AND o.id_status_os NOT IN (${closedPH})` : ''}
                THEN 1 ELSE 0
              END
            ELSE 0
          END
        ), 0) AS total_ordens
      FROM tecnico t
      LEFT JOIN ordenservico o
             ON o.id_tecnico = t.id_tecnico
      WHERE t.status = 'ativo'
        ${whereEspecializacao}
      GROUP BY t.id_tecnico, t.nome, t.especializacao
      ORDER BY total_ordens ASC, t.id_tecnico ASC
      LIMIT 1
    `;

    const paramsSQL = closedPH ? [...closedIds, ...paramsWhere] : [...paramsWhere];
    const [tecnicos] = await db.query(sql, paramsSQL);

    if (!tecnicos.length) {
      return res.status(404).json({ erro: 'Nenhum técnico disponível.' });
    }

    const usada_especializacao = especializacao || '(qualquer eletroportáteis)';
    return res.json({ ...tecnicos[0], usada_especializacao });
  } catch (error) {
    console.error('❌ Erro ao buscar técnico menos carregado:', error);
    return res.status(500).json({
      erro: 'Erro interno ao buscar técnico balanceado.',
      detalhe: error?.sqlMessage || error?.message || String(error)
    });
  }
});

module.exports = router;
