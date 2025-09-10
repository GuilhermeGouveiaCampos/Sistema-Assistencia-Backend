const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/tecnicos/menos-carregados/:tipoEquipamento
router.get('/menos-carregados/:tipoEquipamento', async (req, res) => {
  const tipoEquipamento = decodeURIComponent(req.params.tipoEquipamento || '').trim();

  try {
    // 1) Especialização a partir do tipo (case-insensitive; tenta exato e SOUNDEX)
    let especializacao = null;

    // exato (LOWER)
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
      // aproximação por som de pronúncia (corrige casos tipo "Abarjur" vs "Abajur")
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

    // 2) Fallback quando não houver mapeamento
    const listaEspecializacoes = [especializacao || 'Manutenção de Eletroportáteis'];
    const placeholders = listaEspecializacoes.map(() => '?').join(',');

    // 3) Descobrir IDs de status encerrados (ajuste os nomes se forem diferentes)
    const [closedRows] = await db.query(
      `SELECT id_status FROM status_os WHERE descricao IN ('Finalizado','Cancelado')`
    );
    const closedIds = closedRows.map(r => r.id_status);
    const closedPH = closedIds.length ? closedIds.map(() => '?').join(',') : null;

    // 4) Técnico ativo com menos OS em aberto naquela(s) especialização(ões)
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
        AND t.especializacao IN (${placeholders})
      GROUP BY t.id_tecnico, t.nome, t.especializacao   -- ✅ evita ONLY_FULL_GROUP_BY
      ORDER BY total_ordens ASC, t.id_tecnico ASC
      LIMIT 1
    `;

    const params = (closedPH ? [...closedIds, ...listaEspecializacoes] : [...listaEspecializacoes]);
    const [tecnicos] = await db.query(sql, params);

    // 5) Se não achou nessa especialização, tenta fallback explícito (caso ainda não seja)
    if (!tecnicos.length && listaEspecializacoes[0] !== 'Manutenção de Eletroportáteis') {
      const [t2] = await db.query(
        `
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
        LEFT JOIN ordenservico o ON o.id_tecnico = t.id_tecnico
        WHERE t.status = 'ativo'
          AND t.especializacao = 'Manutenção de Eletroportáteis'
        GROUP BY t.id_tecnico, t.nome, t.especializacao
        ORDER BY total_ordens ASC, t.id_tecnico ASC
        LIMIT 1
        `,
        closedPH ? [...closedIds] : []
      );
      if (!t2.length) return res.status(404).json({ erro: 'Nenhum técnico disponível.' });
      return res.json({ ...t2[0], usada_especializacao: 'Manutenção de Eletroportáteis' });
    }

    if (!tecnicos.length) {
      return res.status(404).json({ erro: 'Nenhum técnico disponível.' });
    }

    return res.json({ ...tecnicos[0], usada_especializacao: listaEspecializacoes[0] });
  } catch (error) {
    console.error('❌ Erro ao buscar técnico menos carregado:', error);
    return res.status(500).json({
      erro: 'Erro interno ao buscar técnico balanceado.',
      detalhe: error?.sqlMessage || error?.message || String(error)
    });
  }
});

module.exports = router;
