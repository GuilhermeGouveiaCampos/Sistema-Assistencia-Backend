const express = require('express');
const router = express.Router();
const db = require('../db');         // mysql2/promise connection
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'chave_super_secreta';

router.post('/', async (req, res) => {
  const { cpf, senha } = req.body || {};

  if (!cpf || !senha) {
    return res.status(400).json({ mensagem: 'CPF e senha são obrigatórios.' });
  }

  const cpfLimpo = String(cpf).replace(/\D/g, '').trim();

  try {
    const [rows] = await db.query(
      `SELECT id_usuario, nome, cpf, senha_hash, id_nivel, genero, status
         FROM usuario
        WHERE cpf = ?
        LIMIT 1`,
      [cpfLimpo]
    );

    const usuario = rows && rows[0];
    if (!usuario) {
      return res.status(401).json({ mensagem: 'Usuário não encontrado.' });
    }

    if (usuario.status !== 'ativo') {
      return res.status(403).json({ mensagem: 'Usuário inativo.' });
    }

    const senhaOk = await bcrypt.compare(String(senha), usuario.senha_hash || '');
    if (!senhaOk) {
      return res.status(401).json({ mensagem: 'Senha incorreta.' });
    }

    const token = jwt.sign(
      { id: usuario.id_usuario, cpf: usuario.cpf },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    // ✅ Resposta padronizada para o frontend salvar no localStorage
    return res.json({
      mensagem: 'Login realizado com sucesso!',
      token,
      id_usuario: usuario.id_usuario,
      nome: usuario.nome,
      genero: usuario.genero,     // M/F ou masculino/feminino
      cpf: usuario.cpf,
      id_nivel: usuario.id_nivel
    });
  } catch (err) {
    console.error('❌ Erro durante o login:', err);
    return res.status(500).json({ mensagem: 'Erro interno no servidor.' });
  }
});

module.exports = router;
