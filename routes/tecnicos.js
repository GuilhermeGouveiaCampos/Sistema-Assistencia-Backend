const express = require('express');
const router = express.Router();
const db = require('../db');

// 🔍 Listar técnicos ativos
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT t.id_tecnico, t.nome, t.especializacao, t.telefone, t.status, u.id_usuario
      FROM tecnico t
      JOIN usuario u ON t.id_usuario = u.id_usuario
      WHERE t.status = 'ativo'
    `);
    res.json(rows);
  } catch (err) {
    console.error('❌ Erro ao listar técnicos:', err);
    res.status(500).json({ erro: 'Erro ao listar técnicos.' });
  }
});

// 🔍 Listar técnicos inativos
router.get('/inativos', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT t.id_tecnico, t.nome, t.especializacao, t.telefone, t.status, u.id_usuario
      FROM tecnico t
      JOIN usuario u ON t.id_usuario = u.id_usuario
      WHERE t.status = 'inativo'
    `);
    res.json(rows);
  } catch (err) {
    console.error('❌ Erro ao listar técnicos inativos:', err);
    res.status(500).json({ erro: 'Erro ao listar técnicos inativos.' });
  }
});

// GET /api/tecnicos/atribuicoes
// Lista TODAS as OS atribuídas a cada técnico + minutos acumulados
router.get('/atribuicoes', async (_req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        t.id_tecnico,
        t.nome                    AS nome_tecnico,
        t.telefone,
        o.id_os,
        c.nome                    AS nome_cliente,
        e.tipo,
        e.marca,
        e.modelo,
        e.numero_serie,
        s.descricao               AS status_os,
        o.data_criacao,
        o.data_inicio_reparo,
        o.data_fim_reparo,
        COALESCE(o.tempo_servico, 0) AS tempo_servico,
        -- minutos corridos: acumulado + (se estiver em ciclo aberto)
        (COALESCE(o.tempo_servico,0) +
         IF(o.data_inicio_reparo IS NULL, 0,
            TIMESTAMPDIFF(MINUTE, o.data_inicio_reparo, NOW())
         )
        ) AS minutos_total
      FROM ordenservico o
      JOIN tecnico     t ON o.id_tecnico     = t.id_tecnico
      JOIN cliente     c ON o.id_cliente     = c.id_cliente
      JOIN equipamento e ON o.id_equipamento = e.id_equipamento
      JOIN status_os   s ON o.id_status_os   = s.id_status
      WHERE o.status = 'ativo'
      ORDER BY t.nome, o.id_os DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error('❌ Erro em /api/tecnicos/atribuicoes:', err);
    res.status(500).json({ erro: 'Erro ao buscar atribuições dos técnicos.' });
  }
});


// ➕ Cadastrar técnico
router.post('/', async (req, res) => {
  const { nome, especializacao, telefone, id_usuario } = req.body;

  if (!nome || !especializacao || !telefone || !id_usuario) {
    return res.status(400).json({ erro: 'Todos os campos são obrigatórios.' });
  }

  try {
    const [result] = await db.query(
      `INSERT INTO tecnico (nome, especializacao, telefone, status, id_usuario) 
       VALUES (?, ?, ?, 'ativo', ?)`,
      [nome, especializacao, telefone, id_usuario]
    );

    res.status(201).json({ mensagem: 'Técnico cadastrado com sucesso.', id_tecnico: result.insertId });
  } catch (err) {
    console.error('❌ Erro ao cadastrar técnico:', err);
    res.status(500).json({ erro: 'Erro ao cadastrar técnico.' });
  }
});

// 📝 Atualizar técnico
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, especializacao, telefone } = req.body;

  if (!nome || !especializacao || !telefone) {
    return res.status(400).json({ erro: 'Todos os campos são obrigatórios.' });
  }

  try {
    const [result] = await db.query(
      `UPDATE tecnico SET nome = ?, especializacao = ?, telefone = ? WHERE id_tecnico = ?`,
      [nome, especializacao, telefone, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Técnico não encontrado.' });
    }

    res.json({ mensagem: 'Técnico atualizado com sucesso.' });
  } catch (err) {
    console.error('❌ Erro ao atualizar técnico:', err);
    res.status(500).json({ erro: 'Erro ao atualizar técnico.' });
  }
});

// ❌ Inativar técnico (exclusão lógica)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.query(
      `UPDATE tecnico SET status = 'inativo' WHERE id_tecnico = ?`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Técnico não encontrado.' });
    }

    res.json({ mensagem: 'Técnico marcado como inativo.' });
  } catch (err) {
    console.error('❌ Erro ao inativar técnico:', err);
    res.status(500).json({ erro: 'Erro ao inativar técnico.' });
  }
});

// ✅ Ativar técnico
router.put('/ativar/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.query(
      'UPDATE tecnico SET status = "ativo" WHERE id_tecnico = ?',
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Técnico não encontrado.' });
    }

    res.status(200).json({ mensagem: 'Técnico ativado com sucesso.' });
  } catch (err) {
    console.error('❌ Erro ao ativar técnico:', err);
    res.status(500).json({ erro: 'Erro ao ativar técnico.' });
  }
});


module.exports = router;
