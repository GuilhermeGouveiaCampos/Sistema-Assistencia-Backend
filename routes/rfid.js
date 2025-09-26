// routes/rfid.js (ou routes/locais.js)
const express = require('express');
const router = express.Router();
const db = require('../db');

// 🔍 Buscar locais ativos (com id_status numérico)
router.get('/', async (req, res) => {
  const { local } = req.query;

  let query = `
    SELECT
      l.id_scanner,
      l.local_instalado,
      l.status_interno,         -- "Recebido", "Em Diagnóstico", etc.
      s.id_status,              -- ID numérico da tabela status_os
      l.status AS status_exibido
    FROM local l
    LEFT JOIN status_os s
      ON s.descricao = l.status_interno
    WHERE l.status <> 'inativo'
  `;
  const params = [];

  if (local) {
    query += ' AND l.local_instalado LIKE ?';
    params.push(`%${local}%`); // ✅ sem barra invertida
  }

  query += ' ORDER BY l.local_instalado';

  try {
    console.log('🔎 [GET] /api/locais q=', req.query);
    console.log('🟡 SQL =>\n', query, '\n🟡 params =>', params);

    const [rows] = await db.query(query, params);

    console.log('📦 locais recebidos do DB:', rows.length);
    if (rows.length) {
      console.log('👀 exemplo do primeiro local:', rows[0]);
      const nulos = rows.filter(r => r.id_status == null).length;
      if (nulos) console.warn(`⚠️ ${nulos} locais vieram SEM id_status (JOIN não bateu com status_interno).`);
    }

    res.json(rows);
  } catch (err) {
    console.error('❌ Erro ao buscar locais:', err);
    res.status(500).json({ erro: 'Erro ao buscar locais.' });
  }
});

// 🔍 Buscar locais inativos
router.get('/inativos', async (_req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM local WHERE status = "inativo"');
    res.json(rows);
  } catch (err) {
    console.error('❌ Erro ao buscar locais inativos:', err);
    res.status(500).json({ erro: 'Erro ao buscar locais inativos.' });
  }
});

// ➕ Cadastrar novo local
router.post('/', async (req, res) => {
  const { id_scanner, local_instalado, status, status_interno } = req.body;

  if (!id_scanner || !local_instalado || !status) {
    return res.status(400).json({ erro: 'Campos obrigatórios ausentes.' });
  }

  try {
    await db.query(
      'INSERT INTO local (id_scanner, local_instalado, status, status_interno) VALUES (?, ?, ?, ?)',
      [id_scanner, local_instalado, status, status_interno || null]
    );
    res.status(201).json({ mensagem: 'Local cadastrado com sucesso.' });
  } catch (err) {
    console.error('❌ Erro ao cadastrar local:', err);
    res.status(500).json({ erro: 'Erro ao cadastrar local.' });
  }
});

// 📝 Inativar local (com motivo) — garanta que a coluna existe
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { status, motivo_inativacao } = req.body;

  if (typeof status !== 'string' || typeof motivo_inativacao !== 'string' || !status.trim() || !motivo_inativacao.trim()) {
    return res.status(400).json({ error: 'Dados incompletos para inativação.' });
  }

  try {
    await db.query(
      'UPDATE local SET status = ?, motivo_inativacao = ? WHERE id_scanner = ?',
      [status.trim(), motivo_inativacao.trim(), id]
    );
    res.status(200).json({ message: 'Local inativado com sucesso.' });
  } catch (err) {
    console.error('❌ Erro ao inativar local:', err);
    res.status(500).json({ error: 'Erro ao atualizar local.' });
  }
});

// ♻️ Exclusão lógica
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.query(
      'UPDATE local SET status = "inativo" WHERE id_scanner = ?',
      [id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Local não encontrado.' });
    }
    res.status(200).json({ mensagem: 'Local marcado como inativo com sucesso.' });
  } catch (err) {
    console.error('❌ Erro ao inativar local:', err);
    res.status(500).json({ erro: 'Erro ao inativar local.' });
  }
});

// ✅ Reativar local (ativa + define fluxo interno)
router.put('/ativar/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.query(
      'UPDATE local SET status = "ativo", status_interno = "Recebido" WHERE id_scanner = ?',
      [id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Local não encontrado.' });
    }
    res.status(200).json({ mensagem: 'Local reativado com sucesso.' });
  } catch (err) {
    console.error('❌ Erro ao reativar local:', err);
    res.status(500).json({ erro: 'Erro ao reativar local.' });
  }
});

module.exports = router;
