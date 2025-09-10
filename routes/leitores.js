// routes/rfid.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { logAudit } = require('../utils/audit');

const normHex = (s='') => String(s).trim().toUpperCase();
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

async function validateReader(reader_id, reader_key) {
  const [[row]] = await db.query(
    `SELECT reader_id FROM rfid_reader
      WHERE reader_id = ? AND (reader_key IS NULL OR reader_key = ?)
      LIMIT 1`,
    [reader_id, reader_key || null]
  );
  return !!row;
}

// POST /api/rfid/event  { uid, reader_id }
router.post('/event', async (req, res) => {
  try {
    const { uid, reader_id } = req.body || {};
    const readerKey = req.header('x-reader-key') || null;
    if (!uid || !reader_id) return res.status(400).json({ erro: 'uid e reader_id são obrigatórios' });

    if (!(await validateReader(reader_id, readerKey))) {
      return res.status(401).json({ erro: 'leitor inválido' });
    }

    // 1) local destino
    const [[reader]] = await db.query(
      `SELECT id_local FROM rfid_reader WHERE reader_id = ? LIMIT 1`,
      [reader_id]
    );
    if (!reader) return res.status(404).json({ erro: 'Leitor não cadastrado' });
    const idLocalDestino = String(reader.id_local);

    // 2) equipamento por tag
    const [[tag]] = await db.query(
      `SELECT id_equipamento FROM rfid_tag WHERE uid_hex = ? LIMIT 1`,
      [normHex(uid)]
    );
    if (!tag) return res.status(404).json({ erro: 'Tag não cadastrada' });

    // 3) OS ativa mais recente
    const [osRows] = await db.query(
      `SELECT id_os, id_local, id_status_os
         FROM ordenservico
        WHERE id_equipamento = ? AND status = 'ativo'
        ORDER BY data_atualizacao DESC, data_criacao DESC
        LIMIT 1`,
      [tag.id_equipamento]
    );
    if (!osRows.length) return res.status(404).json({ erro: 'Nenhuma OS ativa para esse equipamento' });
    const os = osRows[0];

    // 4) mapeia status pelo local
    const [[locRow]] = await db.query(
      `SELECT status_interno, local_instalado FROM local WHERE id_scanner = ? LIMIT 1`,
      [idLocalDestino]
    );
    let novoStatusId = os.id_status_os;
    if (locRow?.status_interno) {
      const [[st]] = await db.query(
        `SELECT id_status FROM status_os WHERE descricao = ? LIMIT 1`,
        [locRow.status_interno]
      );
      if (st?.id_status) novoStatusId = Number(st.id_status);
    }

    // 5) update OS (local + status)
    await db.query(
      `UPDATE ordenservico
          SET id_local = ?, id_status_os = ?, data_atualizacao = NOW()
        WHERE id_os = ?`,
      [idLocalDestino, novoStatusId, os.id_os]
    );

    // 6) auditoria
    await logAudit(db, {
      entityType: 'ordem',
      entityId: Number(os.id_os),
      action: 'local',
      field: 'id_local',
      oldValue: String(os.id_local),
      newValue: String(idLocalDestino),
      note: `RFID ${normHex(uid)} → ${locRow?.local_instalado || idLocalDestino}`,
      userId: null
    });
    if (Number(novoStatusId) !== Number(os.id_status_os)) {
      const [[oldS]] = await db.query('SELECT descricao FROM status_os WHERE id_status = ?', [os.id_status_os]);
      const [[newS]] = await db.query('SELECT descricao FROM status_os WHERE id_status = ?', [novoStatusId]);
      await logAudit(db, {
        entityType: 'ordem',
        entityId: Number(os.id_os),
        action: 'status',
        field: 'id_status_os',
        oldValue: String(os.id_status_os),
        newValue: String(novoStatusId),
        note: `${oldS?.descricao || os.id_status_os} → ${newS?.descricao || novoStatusId} (RFID)`,
        userId: null
      });
    }

    // 7) timer (entrou/saiu da bancada)
    const [[prevLocLabel]] = await db.query(`SELECT local_instalado FROM local WHERE id_scanner = ?`, [os.id_local]);
    const prevOnBench = (() => {
      const n = norm(prevLocLabel?.local_instalado);
      return (n.includes('bancada') && (n.includes('orcamento') || n.includes('diagnostico')))
          || n.includes('mesa de reparo') || n.includes('area de diagnostico') || n === 'diagnostico';
    })();
    const newOnBench = (() => {
      const n = norm(locRow?.local_instalado);
      return (n.includes('bancada') && (n.includes('orcamento') || n.includes('diagnostico')))
          || n.includes('mesa de reparo') || n.includes('area de diagnostico') || n === 'diagnostico';
    })();

    if (!prevOnBench && newOnBench) {
      await db.query(
        `UPDATE ordenservico
            SET data_inicio_reparo = IFNULL(data_inicio_reparo, NOW()),
                data_fim_reparo    = NULL
          WHERE id_os = ?`,
        [os.id_os]
      );
      await logAudit(db, { entityType: 'ordem', entityId: Number(os.id_os), action: 'timer_start', note: 'RFID start', userId: null });
    } else if (prevOnBench && !newOnBench) {
      const [[minsRow]] = await db.query(
        `SELECT IF(data_inicio_reparo IS NULL, 0, TIMESTAMPDIFF(MINUTE, data_inicio_reparo, NOW())) AS minutos
           FROM ordenservico WHERE id_os = ?`,
        [os.id_os]
      );
      await db.query(
        `UPDATE ordenservico
            SET data_fim_reparo = NOW(),
                tempo_servico   = COALESCE(tempo_servico,0) +
                                  IF(data_inicio_reparo IS NULL, 0,
                                     GREATEST(0, TIMESTAMPDIFF(MINUTE, data_inicio_reparo, NOW()))),
                data_inicio_reparo = NULL
          WHERE id_os = ?`,
        [os.id_os]
      );
      await logAudit(db, { entityType: 'ordem', entityId: Number(os.id_os), action: 'timer_stop', note: `RFID stop +${Number(minsRow?.minutos||0)} min`, userId: null });
    }

    return res.json({ ok: true, id_os: os.id_os, novo_local: idLocalDestino, novo_status: novoStatusId });
  } catch (err) {
    console.error('RFID /event erro:', err);
    return res.status(500).json({ erro: 'Falha interna', detalhe: err?.message });
  }
});

/* ===== CRUD TAGS ===== */
router.post('/tags', async (req, res) => {
  try {
    const { uid_hex, id_equipamento, observacao, tag_code } = req.body || {};
    if (!uid_hex || !id_equipamento) return res.status(400).json({ erro: 'uid_hex e id_equipamento são obrigatórios' });

    const [[equip]] = await db.query(`SELECT id_equipamento FROM equipamento WHERE id_equipamento = ? LIMIT 1`, [id_equipamento]);
    if (!equip) return res.status(404).json({ erro: 'Equipamento não encontrado' });

    await db.query(
      `INSERT INTO rfid_tag (uid_hex, id_equipamento, tag_code, observacao)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id_equipamento=VALUES(id_equipamento), tag_code=VALUES(tag_code), observacao=VALUES(observacao)`,
      [normHex(uid_hex), id_equipamento, tag_code || null, observacao || null]
    );
    return res.status(201).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ erro: 'Falha ao salvar tag', detalhe: e?.message });
  }
});

router.get('/tags/:uid_hex', async (req, res) => {
  try {
    const [[row]] = await db.query(
      `SELECT uid_hex, id_equipamento, tag_code, observacao, created_at FROM rfid_tag WHERE uid_hex = ? LIMIT 1`,
      [normHex(req.params.uid_hex)]
    );
    if (!row) return res.status(404).json({ erro: 'Tag não encontrada' });
    return res.json(row);
  } catch (e) {
    return res.status(500).json({ erro: 'Falha ao consultar tag' });
  }
});

router.delete('/tags/:uid_hex', async (req, res) => {
  try {
    const [del] = await db.query(`DELETE FROM rfid_tag WHERE uid_hex = ?`, [normHex(req.params.uid_hex)]);
    if (!del.affectedRows) return res.status(404).json({ erro: 'Tag não encontrada' });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ erro: 'Falha ao excluir tag' });
  }
});

// “Gerar”/reservar um tag_code lógico (para imprimir/QR) — linkaremos ao UID depois
const crypto = require('crypto');
router.post('/tags/reservar-code', async (_req, res) => {
  try {
    const code = crypto.randomBytes(8).toString('hex').toUpperCase(); // 16 hex
    // Apenas testa unicidade sem poluir tabela com 'RESERVA'; se quiser persistir a reserva, adapte
    const [[exists]] = await db.query(`SELECT tag_code FROM rfid_tag WHERE tag_code = ?`, [code]);
    if (exists) return res.status(409).json({ erro: 'Gerar novamente' });
    return res.status(201).json({ tag_code: code });
  } catch (e) {
    return res.status(500).json({ erro: 'Falha ao reservar code', detalhe: e?.message });
  }
});

/* ===== CRUD LEITORES ===== */
router.post('/readers', async (req, res) => {
  try {
    const { reader_id, id_local, reader_key } = req.body || {};
    if (!reader_id || !id_local) return res.status(400).json({ erro: 'reader_id e id_local são obrigatórios' });
    await db.query(
      `INSERT INTO rfid_reader (reader_id, id_local, reader_key)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE id_local=VALUES(id_local), reader_key=VALUES(reader_key)`,
      [reader_id, String(id_local), reader_key || null]
    );
    return res.status(201).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ erro: 'Falha ao salvar leitor', detalhe: e?.message });
  }
});

router.get('/readers', async (_req, res) => {
  try {
    const [rows] = await db.query(`SELECT reader_id, id_local, created_at FROM rfid_reader ORDER BY created_at DESC`);
    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ erro: 'Falha ao listar leitores' });
  }
});

module.exports = router;
