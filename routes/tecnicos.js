// routes/tecnicos.js
const express = require('express');
const router = express.Router();

/* Helper para pegar o pool que o server.js colocou em app */
function getPool(req) {
  const db = req.app.get('db');
  if (!db) throw new Error('Pool MySQL não disponível em app.get("db")');
  return db;
}

// 🔍 Listar técnicos ativos
router.get('/', async (req, res) => {
  const db = getPool(req);
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
  const db = getPool(req);
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

// 🔎 Atribuições por técnico (OS ativas)
router.get('/atribuicoes', async (req, res) => {
  const db = getPool(req);
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
  const db = getPool(req);
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
  const db = getPool(req);
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
    if (!result.affectedRows) return res.status(404).json({ erro: 'Técnico não encontrado.' });
    res.json({ mensagem: 'Técnico atualizado com sucesso.' });
  } catch (err) {
    console.error('❌ Erro ao atualizar técnico:', err);
    res.status(500).json({ erro: 'Erro ao atualizar técnico.' });
  }
});

// ❌ Inativar técnico
router.delete('/:id', async (req, res) => {
  const db = getPool(req);
  const { id } = req.params;
  try {
    const [result] = await db.query(`UPDATE tecnico SET status='inativo' WHERE id_tecnico=?`, [id]);
    if (!result.affectedRows) return res.status(404).json({ erro: 'Técnico não encontrado.' });
    res.json({ mensagem: 'Técnico marcado como inativo.' });
  } catch (err) {
    console.error('❌ Erro ao inativar técnico:', err);
    res.status(500).json({ erro: 'Erro ao inativar técnico.' });
  }
});

// ✅ Ativar técnico
router.put('/ativar/:id', async (req, res) => {
  const db = getPool(req);
  const { id } = req.params;
  try {
    const [r] = await db.query('UPDATE tecnico SET status="ativo" WHERE id_tecnico=?', [id]);
    if (!r.affectedRows) return res.status(404).json({ erro: 'Técnico não encontrado.' });
    res.json({ mensagem: 'Técnico ativado com sucesso.' });
  } catch (err) {
    console.error('❌ Erro ao ativar técnico:', err);
    res.status(500).json({ erro: 'Erro ao ativar técnico.' });
  }
});

// 👇 Técnico menos carregado por tipo de equipamento
router.get('/menos-carregados/:tipoEquipamento', async (req, res) => {
  const db = getPool(req);
  const tipoEquipamento = decodeURIComponent(req.params.tipoEquipamento);

  try {
    // mapeia especializações para o tipo
    const [especializacoes] = await db.query(
      `SELECT especializacao 
         FROM especializacao_equipamento 
        WHERE tipo_equipamento = ?`,
      [tipoEquipamento]
    );

    let listaEspecializacoes =
      especializacoes.length === 0
        ? ['Manutenção de Eletroportáteis'] // fallback
        : especializacoes.map(e => e.especializacao);

    const placeholders = listaEspecializacoes.map(() => '?').join(',');

    const [tecnicos] = await db.query(
      `
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
      `,
      listaEspecializacoes
    );

    if (!tecnicos.length) {
      return res.status(404).json({ erro: 'Nenhum técnico disponível com especialização compatível.' });
    }

    res.json(tecnicos[0]);
  } catch (error) {
    console.error('❌ Erro ao buscar técnico menos carregado:', error);
    res.status(500).json({ erro: 'Erro interno ao buscar técnico balanceado.' });
  }
});

module.exports = router;
