// backend/routes/ardloc.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { authLeitor } = require('../middleware/authLeitor');

/* ============= Utils ============= */
async function ensureLastUidTable() {
  await db.query(
    `CREATE TABLE IF NOT EXISTS rfid_last_uid (
      id_last INT AUTO_INCREMENT PRIMARY KEY,
      leitor_codigo VARCHAR(100) NOT NULL UNIQUE,
      uid VARCHAR(64) NOT NULL,
      lido_em DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

async function mapStatusByLocal(idScanner) {
  const [[loc]] = await db.query(
    `SELECT status_interno FROM local WHERE id_scanner = ? LIMIT 1`,
    [idScanner]
  );
  if (!loc?.status_interno) return null;
  const [[st]] = await db.query(
    `SELECT id_status FROM status_os WHERE descricao = ? LIMIT 1`,
    [loc.status_interno]
  );
  return st?.id_status ? Number(st.id_status) : null;
}

/* ============= Health ============= */
router.get('/__ping', (_req, res) => res.json({ ok: true, where: 'ardloc' }));

/* ============= Lista leitores (para o front) ============= */
router.get('/leitores', async (_req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT codigo, nome, id_local, id_scanner, status
         FROM rfid_leitor
        ORDER BY codigo ASC`
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /ardloc/leitores erro:', e);
    res.status(500).json({ erro: 'Falha ao listar leitores' });
  }
});

/* ============= Bridge → push-uid (autofill do front) ============= */
router.post('/push-uid', authLeitor, async (req, res) => {
  try {
    const { uid } = req.body || {};
    if (!uid) return res.status(400).json({ erro: 'uid obrigatório' });

    await ensureLastUidTable();
    await db.query(
      `INSERT INTO rfid_last_uid (leitor_codigo, uid, lido_em)
       VALUES (?, UPPER(?), NOW())
       ON DUPLICATE KEY UPDATE uid = VALUES(uid), lido_em = VALUES(lido_em)`,
      [req.leitor.codigo, uid]
    );

    res.json({ ok: true, uid: String(uid).toUpperCase() });
  } catch (e) {
    console.error('POST /ardloc/push-uid erro:', e);
    res.status(500).json({ erro: 'Falha ao registrar último UID' });
  }
});

/* ============= Front → last-uid (pegar último UID recente) ============= */
router.get('/last-uid', async (req, res) => {
  try {
    const leitor = req.query.leitor;
    const maxAgeSec = Number(req.query.maxAgeSec || 10);
    if (!leitor) return res.status(400).json({ erro: 'parâmetro ?leitor é obrigatório' });

    await ensureLastUidTable();
    const [rows] = await db.query(
      `SELECT uid, lido_em FROM rfid_last_uid WHERE leitor_codigo = ? LIMIT 1`,
      [leitor]
    );
    if (!rows.length) return res.json({ uid: null, lido_em: null, recente: false });

    const { uid, lido_em } = rows[0];
    const diffSec = (Date.now() - new Date(lido_em).getTime()) / 1000;
    const recente = diffSec <= maxAgeSec;

    res.json({ uid, lido_em, recente });
  } catch (e) {
    console.error('GET /ardloc/last-uid erro:', e);
    res.status(500).json({ erro: 'Falha ao consultar último UID' });
  }
});

/* ============= Bridge → event (mover OS pelo UID) ============= */
/**
 * Body: { uid: "03A1E52C", leitor_id: "PC-MESA01_COM5" }
 * Headers: x-leitor-key (ou x-api-key) + x-leitor-codigo (igual leitor_id)
 */
router.post('/event', authLeitor, async (req, res) => {
  const { uid, leitor_id } = req.body || {};
  if (!uid || !leitor_id) {
    return res.status(400).json({ erro: 'uid e leitor_id são obrigatórios' });
  }

  try {
    const leitorScanner = req.leitor.id_scanner;
    if (!leitorScanner) {
      return res.status(400).json({ erro: 'Leitor não possui id_scanner definido.' });
    }
    const [loc] = await db.query(
      `SELECT 1 FROM local WHERE id_scanner = ? LIMIT 1`, [leitorScanner]
    );
    if (!loc.length) return res.status(400).json({ erro: `id_scanner '${leitorScanner}' não existe em local.` });

    // encontra OS vinculada (rastreamentorfid bind ativo ou tag_os)
    let idOS = null;
    const [v1] = await db.query(
      `SELECT id_os
         FROM rastreamentorfid
        WHERE UPPER(uid) = UPPER(?) AND tipo='bind' AND desvinculado_em IS NULL
        ORDER BY COALESCE(vinculado_em, evento_em) DESC
        LIMIT 1`,
      [uid]
    );
    if (v1.length) {
      idOS = v1[0].id_os;
    } else {
      const [v2] = await db.query(
        `SELECT id_ordem AS id_os
           FROM tag_os
          WHERE UPPER(uid) = UPPER(?) AND ativo = 1
          LIMIT 1`,
        [uid]
      );
      if (v2.length) idOS = v2[0].id_os;
    }
    if (!idOS) return res.status(404).json({ erro: 'Tag não vinculada a nenhuma OS ativa.' });

    // mapeia status pelo local
    const statusId = await mapStatusByLocal(leitorScanner);

    // atualiza OS
    const params = [leitorScanner];
    let sql = `UPDATE ordenservico SET id_local = ?`;
    if (statusId) sql += `, id_status_os = ${statusId}`;
    sql += `, atualizado_em = NOW() WHERE id_os = ? LIMIT 1`;
    params.push(idOS);
    await db.query(sql, params);

    // log move
    await db.query(
      `INSERT INTO rastreamentorfid (uid, id_os, id_local, tipo, evento_em)
       VALUES (UPPER(?), ?, ?, 'move', NOW())`,
      [uid, idOS, req.leitor.id_local || null]
    );

    res.json({
      ok: true,
      mensagem: 'OS atualizada com o local do leitor',
      data: { uid: String(uid).toUpperCase(), id_os: idOS, novo_local: leitorScanner, id_status_aplicado: statusId || null }
    });
  } catch (e) {
    console.error('POST /ardloc/event erro:', e);
    res.status(500).json({ erro: 'Falha ao processar evento RFID' });
  }
});

module.exports = router;
