// backend/utils/audit.js
async function logAudit(dbOrConn, {
  entityType,     // 'ordem' | 'cliente' | 'equipamento' | 'local' | 'usuario' | 'tecnico'
  entityId,
  action,         // 'criou' | 'atualizou' | 'status' | 'local' | 'inativou' | 'reativou' ...
  field = null,
  oldValue = null,
  newValue = null,
  note = null,
  userId = null
}) {
  const sql = `
    INSERT INTO audit_log
      (entity_type, entity_id, action, field, old_value, new_value, note, user_id)
    VALUES (?,?,?,?,?,?,?,?)`;
  await dbOrConn.query(sql, [
    entityType, entityId, action, field, oldValue, newValue, note, userId
  ]);
}

module.exports = { logAudit };
