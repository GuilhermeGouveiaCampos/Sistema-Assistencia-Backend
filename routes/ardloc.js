// backend/routes/ardloc.js
const express = require('express');
const router = express.Router();
const db = require('../db');

/* =========================
   Config flexível por ENV (sem quebrar o padrão atual)
   ========================= */
const OS_TABLE      = process.env.OS_TABLE      || 'ordenservico';
const OS_PK         = process.env.OS_PK         || 'id_ordem';
const OS_LOCAL_COL  = process.env.OS_LOCAL_COL  || 'id_local';
const OS_STATUS_COL = process.env.OS_STATUS_COL || 'id_status_os';

/* =========================
   Log opcional
   ========================= */
async function logEvento({ uid, leitor_id, id_local, id_status, id_ordem, ok, erro }) {
  try {
    await db.execute(
      `INSERT INTO rfid_eventos (uid, leitor_id, id_local, id_status, id_ordem, sucesso, erro_msg)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uid, leitor_id, id_local || null, id_status || null, id_ordem || null, ok ? 1 : 0, erro || null]
    );
  } catch (e) {
    console.error('Falha ao registrar log RFID:', e.message);
  }
}

/* =========================
   Mapeamento leitor → local/status
   ========================= */
const MAPA_LEITOR_PARA_LOCAL = {
  'PC-MESA01_COM5': { id_local: 'LOC_MESA_REPARO', id_status: 5 },
  'RECEPCAO1_USB':  { id_local: 'LOC_RECEPCAO',    id_status: 1 },
};

/* =========================
   Auth simples via API Key
   ========================= */
function authByApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!key || key !== process.env.API_KEY_RFID) {
    return res.status(401).json({ erro: 'Não autorizado' });
  }
  next();
}

/**
 * POST /api/ardloc/event
 * Body: { "uid": "03A1E52C", "leitor_id": "PC-MESA01_COM5", "id_ordem": 123 } (id_ordem opcional)
 */
router.post('/event', authByApiKey, async (req, res) => {
  let { uid, leitor_id, id_ordem } = req.body || {};
  uid = String(uid || '').trim().toUpperCase();

  if (!uid || !leitor_id) {
    await logEvento({ uid, leitor_id, ok: 0, erro: 'uid/leitor_id ausente' });
    return res.status(400).json({ erro: 'uid e leitor_id são obrigatórios' });
  }

  const padrao = MAPA_LEITOR_PARA_LOCAL[leitor_id];
  if (!padrao) {
    await logEvento({ uid, leitor_id, ok: 0, erro: 'Leitor não mapeado' });
    return res.status(400).json({ erro: 'Leitor não mapeado' });
  }

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    // 1) Descobrir OS se não foi enviada
    let idOrdemFinal = id_ordem;
    if (!idOrdemFinal) {
      const [rows] = await conn.execute(
        'SELECT id_ordem FROM tag_os WHERE uid = ? AND ativo = 1 LIMIT 1',
        [uid]
      );
      if (!rows.length) {
        await logEvento({ uid, leitor_id, ok: 0, erro: 'Tag não vinculada a OS' });
        await conn.rollback(); conn.release();
        return res.status(404).json({ erro: 'Tag não vinculada a OS' });
      }
      idOrdemFinal = rows[0].id_ordem;
    }

    // 2) Atualiza OS (id_local + status) e timestamp
    const [upd] = await conn.execute(
      `UPDATE ${OS_TABLE}
         SET ${OS_LOCAL_COL} = ?, ${OS_STATUS_COL} = ?, atualizado_em = NOW()
       WHERE ${OS_PK} = ?`,
      [padrao.id_local, padrao.id_status, idOrdemFinal]
    );

    if (!upd.affectedRows) {
      throw new Error(`OS não encontrada para ${OS_PK}=${idOrdemFinal}`);
    }

    // 3) Log do evento
    await conn.execute(
      `INSERT INTO rfid_eventos (uid, leitor_id, id_local, id_status, id_ordem, sucesso, erro_msg)
       VALUES (?, ?, ?, ?, ?, 1, NULL)`,
      [uid, leitor_id, padrao.id_local, padrao.id_status, idOrdemFinal]
    );

    await conn.commit(); conn.release();

    return res.json({
      ok: true,
      mensagem: 'OS atualizada a partir do RFID',
      id_ordem: idOrdemFinal,
      id_local: padrao.id_local,
      id_status: padrao.id_status
    });
  } catch (err) {
    try { if (conn) await conn.rollback(); } catch {}
    try { if (conn) conn.release(); } catch {}
    console.error('Erro ao processar evento RFID:', err);
    await logEvento({ uid, leitor_id, ok: 0, erro: err.message });
    return res.status(500).json({ erro: 'Falha ao processar evento RFID' });
  }
});

module.exports = router;
