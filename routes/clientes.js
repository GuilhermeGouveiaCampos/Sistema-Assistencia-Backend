// backend/routes/clientes.js
const express = require('express');
const router = express.Router();
const db = require('../db'); // espere que ../db exporte um pool/connection com suporte a Promise (mysql2/promise)

// 🔍 Buscar clientes ativos com filtros opcionais
router.get('/', async (req, res) => {
  try {
    const nome = (req.query.nome || '').trim();
    const cpfFiltro = (req.query.cpf || '').replace(/\D/g, '');

    let sql = `SELECT id_cliente, nome, cpf, telefone, data_nascimento, status, criado_em
               FROM cliente
               WHERE status = 'ativo'`;
    const params = [];

    if (nome) {
      sql += ' AND nome LIKE ?';
      params.push(`%${nome}%`);
    }
    if (cpfFiltro) {
      sql += ' AND REPLACE(REPLACE(REPLACE(cpf, ".", ""), "-", ""), " ", "") LIKE ?';
      params.push(`%${cpfFiltro}%`);
    }

    sql += ' ORDER BY criado_em DESC';

    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('❌ Erro ao buscar clientes ativos:', err);
    res.status(500).json({ erro: 'Erro ao buscar clientes.' });
  }
});

// 🔍 Buscar clientes inativos
router.get('/inativos', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id_cliente, nome, cpf, telefone, data_nascimento, status, criado_em
       FROM cliente
       WHERE status = 'inativo'
       ORDER BY criado_em DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ Erro ao buscar clientes inativos:', err);
    res.status(500).json({ erro: 'Erro ao buscar clientes inativos.' });
  }
});

// ✅ Ativar cliente
router.put('/ativar/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await db.query(
      'UPDATE cliente SET status = "ativo" WHERE id_cliente = ?',
      [id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Cliente não encontrado.' });
    }
    res.json({ mensagem: 'Cliente ativado com sucesso.' });
  } catch (err) {
    console.error('❌ Erro ao ativar cliente:', err);
    res.status(500).json({ erro: 'Erro ao ativar cliente.' });
  }
});

// 🚫 Inativar cliente (soft delete) com verificação de vínculos
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ erro: 'ID do cliente não informado.' });

  try {
    // Verifica se há equipamentos vinculados
    const [equipamentos] = await db.query(
      'SELECT id_equipamento FROM equipamento WHERE id_cliente = ?',
      [id]
    );

    if (equipamentos.length > 0) {
      // Se houver equipamentos, verifica ordens vinculadas a esses equipamentos
      const idsEquip = equipamentos.map(eq => eq.id_equipamento);
      const [ordens] = await db.query(
        'SELECT id_orden_servico FROM ordenservico WHERE id_equipamento IN (?)',
        [idsEquip]
      );

      if (ordens.length > 0) {
        return res.status(400).json({ erro: 'Cliente possui ordens de serviço vinculadas.' });
      }
    }

    // Se não há ordens vinculadas, pode inativar
    const [result] = await db.query(
      'UPDATE cliente SET status = "inativo" WHERE id_cliente = ?',
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Cliente não encontrado.' });
    }

    res.json({ mensagem: 'Cliente inativado com sucesso.' });
  } catch (err) {
    console.error('💥 Erro ao inativar cliente:', err);
    res.status(500).json({ erro: 'Erro interno ao inativar cliente.' });
  }
});

// 📝 Atualizar cliente
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  let { nome, cpf, telefone, data_nascimento } = req.body;

  if (!nome || !cpf || !telefone || !data_nascimento) {
    return res.status(400).json({ erro: 'Todos os campos são obrigatórios.' });
  }

  const cpfClean = String(cpf).replace(/\D/g, '');

  try {
    // Impede CPF duplicado em outro cliente
    const [dup] = await db.query(
      'SELECT 1 FROM cliente WHERE cpf = ? AND id_cliente <> ? LIMIT 1',
      [cpfClean, id]
    );
    if (dup.length) {
      return res.status(409).json({ erro: 'CPF já cadastrado para outro cliente.' });
    }

    const [result] = await db.query(
      'UPDATE cliente SET nome = ?, cpf = ?, telefone = ?, data_nascimento = ? WHERE id_cliente = ?',
      [nome, cpfClean, telefone, data_nascimento, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Cliente não encontrado.' });
    }

    res.json({ mensagem: 'Cliente atualizado com sucesso.' });
  } catch (err) {
    console.error('❌ Erro ao atualizar cliente:', err);
    res.status(500).json({ erro: 'Erro ao atualizar cliente.' });
  }
});

// 🔍 Buscar cliente por ID (deixe SEMPRE depois das rotas específicas)
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await db.query(
      'SELECT id_cliente, nome, cpf, telefone, data_nascimento, status, criado_em FROM cliente WHERE id_cliente = ?',
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ erro: 'Cliente não encontrado.' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ Erro ao buscar cliente por ID:', err);
    res.status(500).json({ erro: 'Erro ao buscar cliente.' });
  }
});

// ➕ Cadastrar novo cliente
router.post('/', async (req, res) => {
  let { nome, cpf, telefone, data_nascimento } = req.body;

  if (!nome || !cpf || !telefone || !data_nascimento) {
    return res.status(400).json({ erro: 'Todos os campos são obrigatórios.' });
  }

  const cpfClean = String(cpf).replace(/\D/g, '');

  try {
    // CPF único
    const [dup] = await db.query(
      'SELECT 1 FROM cliente WHERE cpf = ? LIMIT 1',
      [cpfClean]
    );
    if (dup.length) {
      return res.status(409).json({ erro: 'CPF já cadastrado.' });
    }

    const [result] = await db.query(
      'INSERT INTO cliente (nome, cpf, telefone, data_nascimento, status, criado_em) VALUES (?, ?, ?, ?, "ativo", NOW())',
      [nome, cpfClean, telefone, data_nascimento]
    );

    res.status(201).json({ mensagem: 'Cliente cadastrado com sucesso.', id_cliente: result.insertId });
  } catch (err) {
    console.error('❌ Erro ao cadastrar cliente:', err);
    res.status(500).json({ erro: 'Erro ao cadastrar cliente.' });
  }
});

module.exports = router;
