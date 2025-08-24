const express = require('express');
const router = express.Router();
const db = require('../db');

// Rota GET técnico menos carregado compatível com o tipo de equipamento
router.get('/menos-carregados/:tipoEquipamento', async (req, res) => {
  const tipoEquipamento = decodeURIComponent(req.params.tipoEquipamento);

  
  try {
    // 🔍 Buscar especializações mapeadas
    const [especializacoes] = await db.query(`
      SELECT especializacao 
      FROM especializacao_equipamento 
      WHERE tipo_equipamento = ?
    `, [tipoEquipamento]);

    let listaEspecializacoes;

    if (especializacoes.length === 0) {
      // ✅ Fallback: usar especialização genérica
      listaEspecializacoes = ['Manutenção de Eletroportáteis'];
      console.warn(`⚠️ Tipo ${tipoEquipamento} não encontrado, usando fallback.`);
    } else {
      listaEspecializacoes = especializacoes.map(e => e.especializacao);
    }

    // 🔄 Construir placeholders dinâmicos para IN (?,?,?)
    const placeholders = listaEspecializacoes.map(() => '?').join(',');

    // 🔧 Buscar técnico com menos ordens em aberto com base na(s) especialização(ões)
    const [tecnicos] = await db.query(`
      SELECT 
        t.id_tecnico,
        t.nome,
        t.especializacao,
        COUNT(CASE 
                WHEN o.id_status_os IN (
                    SELECT id_status 
                    FROM status_os 
                    WHERE descricao IN ('Recebido', 'Em Reparo')
                ) THEN o.id_os 
              END) AS total_ordens
      FROM tecnico t
      LEFT JOIN ordenservico o ON o.id_tecnico = t.id_tecnico
      WHERE t.status = 'ativo'
        AND t.especializacao IN (${placeholders})
      GROUP BY t.id_tecnico
      ORDER BY total_ordens ASC
      LIMIT 1
    `, listaEspecializacoes);

    if (tecnicos.length === 0) {
      return res.status(404).json({ erro: "Nenhum técnico disponível com especialização compatível." });
    }

    res.json(tecnicos[0]);
  } catch (error) {
    console.error("❌ Erro ao buscar técnico menos carregado:", error);
    res.status(500).json({ erro: "Erro interno ao buscar técnico balanceado." });
  }
});

module.exports = router;
