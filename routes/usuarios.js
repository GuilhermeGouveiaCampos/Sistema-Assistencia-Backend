const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs'); // ✅ faltava

// 🔍 Buscar usuários ativos com filtros opcionais + genero + nome_nivel
router.get('/', async (req, res) => {
  const { nome, cpf } = req.query;
  let query = `
    SELECT u.id_usuario, u.nome, u.cpf, u.email, u.id_nivel, u.genero, n.nome_nivel, u.status
    FROM usuario u
    JOIN nivel n ON u.id_nivel = n.id_nivel
    WHERE u.status = 'ativo'
  `;
  const params = [];

  if (nome) {
    query += ' AND u.nome LIKE ?';
    params.push(`%${nome}%`);
  }

  if (cpf) {
    query += ' AND u.cpf LIKE ?';
    params.push(`%${cpf}%`);
  }

  try {
    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('❌ Erro ao buscar usuários ativos:', err);
    res.status(500).json({ erro: 'Erro ao buscar usuários', detalhe: err.message });
  }
});

// 🔍 Buscar usuários inativos com genero
router.get('/inativos', async (_req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT u.id_usuario, u.nome, u.cpf, u.email, u.id_nivel, u.genero, n.nome_nivel, u.status
      FROM usuario u
      JOIN nivel n ON u.id_nivel = n.id_nivel
      WHERE u.status = "inativo"
    `);
    res.json(rows);
  } catch (err) {
    console.error('❌ Erro ao buscar usuários inativos:', err);
    res.status(500).json({ erro: 'Erro ao buscar usuários inativos.', detalhe: err.message });
  }
});

// ✅ Ativar usuário
router.put('/:id/ativar', async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.query(
      'UPDATE usuario SET status = "ativo" WHERE id_usuario = ?',
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado.' });
    }

    res.status(200).json({ mensagem: 'Usuário ativado com sucesso.' });
  } catch (err) {
    console.error('❌ Erro ao ativar usuário:', err);
    res.status(500).json({ erro: 'Erro ao ativar usuário.', detalhe: err.message });
  }
});

// ❌ Inativar usuário (exclusão lógica)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.query(
      'UPDATE usuario SET status = "inativo" WHERE id_usuario = ?',
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado.' });
    }

    res.status(200).json({ mensagem: 'Usuário marcado como inativo com sucesso.' });
  } catch (err) {
    console.error('❌ Erro ao inativar usuário:', err);
    res.status(500).json({ erro: 'Erro ao marcar usuário como inativo.', detalhe: err.message });
  }
});

// 📝 Atualizar usuário (inclui genero de forma opcional)
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, cpf, email, id_nivel, genero } = req.body;

  if (!nome || !cpf || !email || !id_nivel) {
    return res.status(400).json({ erro: 'Todos os campos são obrigatórios.' });
  }

  try {
    const [result] = await db.query(
      'UPDATE usuario SET nome = ?, cpf = ?, email = ?, id_nivel = ?, genero = COALESCE(?, genero) WHERE id_usuario = ?',
      [nome, cpf, email, id_nivel, genero ?? null, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado.' });
    }

    res.status(200).json({ mensagem: 'Usuário atualizado com sucesso.' });
  } catch (err) {
    console.error('❌ Erro ao atualizar usuário:', err);
    res.status(500).json({ erro: 'Erro ao atualizar usuário.', detalhe: err.message });
  }
});

// 🔍 Buscar usuário por ID com genero
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db.query(`
      SELECT u.id_usuario, u.nome, u.cpf, u.email, u.id_nivel, u.genero, n.nome_nivel, u.status
      FROM usuario u
      JOIN nivel n ON u.id_nivel = n.id_nivel
      WHERE u.id_usuario = ?
    `, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado.' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('❌ Erro ao buscar usuário por ID:', err);
    res.status(500).json({ erro: 'Erro ao buscar usuário.', detalhe: err.message });
  }
});

// ➕ Cadastrar novo usuário e, se for técnico (id_nivel === 3), também na tabela tecnico
router.post('/', async (req, res) => {
  let { nome, cpf, email, senha, id_nivel, especializacao, telefone, genero } = req.body;

  // normalizações
  cpf = (cpf || '').replace(/\D/g, '');
  id_nivel = Number(id_nivel);

  const faltando = [];
  if (!nome?.trim()) faltando.push('nome');
  if (!cpf) faltando.push('cpf');
  if (!email?.trim()) faltando.push('email');
  if (!senha?.trim()) faltando.push('senha');
  if (Number.isNaN(id_nivel)) faltando.push('id_nivel');
  if (!genero?.trim()) faltando.push('genero');

  if (faltando.length) {
    return res.status(400).json({ erro: `Campos faltando: ${faltando.join(', ')}` });
  }

  // se for técnico, exigir campos específicos
  if (id_nivel === 3) {
    const faltandoTec = [];
    if (!especializacao?.trim()) faltandoTec.push('especializacao');
    if (!telefone?.trim()) faltandoTec.push('telefone');
    if (faltandoTec.length) {
      return res.status(400).json({ erro: `Campos de técnico faltando: ${faltandoTec.join(', ')}` });
    }
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // hash da senha no backend (frontend envia texto puro)
    const senhaHash = await bcrypt.hash(senha, 10);

    const [usuarioResult] = await conn.query(
      `INSERT INTO usuario (nome, cpf, email, senha_hash, id_nivel, genero, status)
       VALUES (?, ?, ?, ?, ?, ?, "ativo")`,
      [nome.trim(), cpf, email.trim(), senhaHash, id_nivel, genero]
    );

    const id_usuario = usuarioResult.insertId;

    // técnico quando id_nivel === 3
    if (id_nivel === 3) {
      await conn.query(
        'INSERT INTO tecnico (nome, especializacao, telefone, status, id_usuario) VALUES (?, ?, ?, "ativo", ?)',
        [nome.trim(), especializacao.trim(), telefone.trim(), id_usuario]
      );
    }

    await conn.commit();
    return res.status(201).json({ mensagem: 'Usuário cadastrado com sucesso.', id_usuario });
  } catch (err) {
    await conn.rollback();
    console.error('❌ Erro ao cadastrar usuário/técnico:', err);
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ erro: 'CPF ou e-mail já cadastrado.' });
    }
    return res.status(500).json({ erro: 'Erro ao cadastrar usuário.', detalhe: err.message });
  } finally {
    conn.release();
  }
});
router.post('/reset-senha', async (req, res) => {
  try {
    let { cpf, nova_senha } = req.body || {};
    cpf = String(cpf || '').replace(/\D/g, '').trim();

    if (!cpf || !nova_senha?.trim()) {
      return res.status(400).json({ erro: 'CPF e nova_senha são obrigatórios.' });
    }

    // opcional: valida força mínima da senha
    if (nova_senha.length < 6) {
      return res.status(400).json({ erro: 'A nova senha deve ter pelo menos 6 caracteres.' });
    }

    // procura usuário ativo
    const [usuarios] = await db.query(
      `SELECT id_usuario, status FROM usuario WHERE cpf = ? LIMIT 1`,
      [cpf]
    );

    if (!usuarios || !usuarios[0]) {
      return res.status(404).json({ erro: 'Usuário não encontrado.' });
    }
    if (usuarios[0].status !== 'ativo') {
      return res.status(403).json({ erro: 'Usuário inativo.' });
    }

    const senhaHash = await bcrypt.hash(String(nova_senha), 10);

    await db.query(
      `UPDATE usuario SET senha_hash = ? WHERE id_usuario = ?`,
      [senhaHash, usuarios[0].id_usuario]
    );

    return res.json({ mensagem: 'Senha atualizada com sucesso.' });
  } catch (err) {
    console.error('❌ Erro no reset de senha:', err);
    return res.status(500).json({ erro: 'Erro interno ao redefinir a senha.' });
  }
});

module.exports = router;
