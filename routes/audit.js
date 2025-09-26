// backend/routes/audit.js
const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/:entity/:id', async (req, res) => {
  const { entity, id } = req.params;
  const limit  = Number(req.query.limit ?? 200);
  const offset = Number(req.query.offset ?? 0);

  const allowed = ['ordem','cliente','equipamento','local','usuario','tecnico'];
  if (!allowed.includes(entity)) {
    return res.status(400).json({ erro: 'entity inválida' });
  }
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ erro: 'ID inválido' });
  }

  try {
    const [rows] = await db.query(
      `SELECT id_log, action, field, old_value, new_value, note, user_id, created_at
         FROM audit_log
        WHERE entity_type = ? AND entity_id = ?
        ORDER BY id_log DESC
        LIMIT ? OFFSET ?`,
      [entity, Number(id), limit, offset]
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ Erro ao buscar audit_log:', err);
    res.status(500).json({ erro: 'Erro ao buscar histórico.' });
  }
});

module.exports = router;
