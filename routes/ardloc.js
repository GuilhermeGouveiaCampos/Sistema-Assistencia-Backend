// backend/routes/ardloc.js
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../db');

// audit opcional (se existir)
let logAudit = async () => {};
try { ({ logAudit } = require('../utils/audit')); } catch { /* segue sem auditoria */ }

/* =========================================================
   Sanidade
   ========================================================= */
router.get('/__ping', (_req, res) => {
  res.json({ ok: true, where: 'ardloc' });
});

/* =========================================================
   Helpers de meta-esquema
   ========================================================= */
async function tableExists(conn, name) {
  const [rows] = await conn.query(
    `SELECT 1
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      LIMIT 1`, [name]
  );
  return rows.length > 0;
}
async function pickTable(conn, candidates) {
  for (const t of candidates) if (await tableExists(conn, t)) return t;
  return null;
}
async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT 1
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`, [table, column]
  );
  return rows.length > 0;
}
async function getPrimaryKey(conn, table) {
  const [rows] = await conn.query(
    `SELECT k.COLUMN_NAME
       FROM information_schema.TABLE_CONSTRAINTS t
       JOIN information_schema.KEY_COLUMN_USAGE k
         ON t.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        AND t.TABLE_SCHEMA   = k.TABLE_SCHEMA
        AND t.TABLE_NAME     = k.TABLE_NAME
      WHERE t.TABLE_SCHEMA = DATABASE()
        AND t.TABLE_NAME   = ?
        AND t.CONSTRAINT_TYPE = 'PRIMARY KEY'
      LIMIT 1`, [table]
  );
  return rows[0]?.COLUMN_NAME || null;
}

/* =========================================================
   AUTH do leitor via headers (x-leitor-codigo / x-leitor-key)
   ========================================================= */
async function getLeitorByCodigo(codigo) {
  const [rows] = await db.query(
    `SELECT id_leitor, codigo, nome, id_local, id_scanner, api_key_hash, status, criado_em
       FROM rfid_leitor
      WHERE codigo = ?
      LIMIT 1`, [codigo]
  );
  return rows[0] || null;
}
async function authLeitorHeader(req, res, next) {
  try {
    const codigo = req.header('x-leitor-codigo') || req.header('x-leitor-id') || null;
    const key    = req.header('x-leitor-key')    || req.header('x-api-key')   || null;
    if (!codigo || !key) return res.status(401).json({ erro: 'Cabeçalhos do leitor ausentes' });

    const leitor = await getLeitorByCodigo(codigo);
    if (!leitor) return res.status(401).json({ erro: 'Leitor não cadastrado' });
    if (leitor.status && String(leitor.status).toLowerCase() !== 'ativo') {
      return res.status(403).json({ erro: 'Leitor inativo' });
    }
    if (!leitor.api_key_hash) return res.status(401).json({ erro: 'Leitor sem chave definida' });

    const ok = await bcrypt.compare(key, leitor.api_key_hash);
    if (!ok) return res.status(401).json({ erro: 'Chave inválida' });

    req.leitor = leitor; // { codigo, id_scanner, id_local, ... }
    next();
  } catch (e) {
    console.error('authLeitorHeader erro:', e);
    res.status(500).json({ erro: 'Falha ao autenticar leitor' });
  }
}

/* =========================================================
   LEITORES (UPSERT / RESET-KEY / LIST)
   ========================================================= */

// POST /api/ardloc/leitores
router.post('/leitores', async (req, res) => {
  try {
    const { codigo, nome, id_local, id_scanner, api_key_plain, status = 'ativo' } = req.body || {};
    if (!codigo || !api_key_plain) {
      return res.status(400).json({ erro: 'codigo e api_key_plain são obrigatórios' });
    }

    // valida id_scanner contra tabela local
    if (id_scanner) {
      const [loc] = await db.query(`SELECT 1 FROM local WHERE id_scanner = ? LIMIT 1`, [id_scanner]);
      if (!loc.length) return res.status(400).json({ erro: `id_scanner '${id_scanner}' não existe na tabela local` });
    }

    const hash = await bcrypt.hash(api_key_plain, 10);

    const [r] = await db.query(
      `INSERT INTO rfid_leitor (codigo, nome, id_local, id_scanner, api_key_hash, status)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         nome = VALUES(nome),
         id_local = VALUES(id_local),
         id_scanner = VALUES(id_scanner),
         api_key_hash = VALUES(api_key_hash),
         status = VALUES(status)`,
      [codigo, nome || null, id_local || null, id_scanner || null, hash, status]
    );

    const created = r.affectedRows === 1 && r.insertId;
    res.json({ ok: true, mensagem: `Leitor ${created ? 'cadastrado' : 'atualizado'}`, data: { codigo, id_scanner, status } });
  } catch (err) {
    console.error('POST /leitores error:', err);
    res.status(500).json({ erro: 'Falha ao cadastrar/atualizar leitor' });
  }
});

// PUT /api/ardloc/leitores/:codigo/key
router.put('/leitores/:codigo/key', async (req, res) => {
  try {
    const { codigo } = req.params;
    const { api_key_plain } = req.body || {};
    if (!api_key_plain) return res.status(400).json({ erro: 'api_key_plain é obrigatório' });

    const hash = await bcrypt.hash(api_key_plain, 10);
    const [r] = await db.query(
      `UPDATE rfid_leitor
          SET api_key_hash = ?, status = 'ativo'
        WHERE codigo = ?
        LIMIT 1`,
      [hash, codigo]
    );
    if (!r.affectedRows) return res.status(404).json({ erro: 'Leitor não encontrado' });
    res.json({ ok: true, mensagem: 'Chave atualizada', data: { codigo } });
  } catch (e) {
    console.error('PUT /leitores/:codigo/key error:', e);
    res.status(500).json({ erro: 'Falha ao atualizar chave' });
  }
});

// GET /api/ardloc/leitores
router.get('/leitores', async (_req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id_leitor, codigo, nome, id_local, id_scanner, status, criado_em FROM rfid_leitor ORDER BY id_leitor DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Falha ao listar leitores' });
  }
});

/* =========================================================
   Push / Last UID (para auto-preencher no front)
   ========================================================= */
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

// POST /api/ardloc/push-uid   (bridge → backend)
router.post('/push-uid', authLeitorHeader, async (req, res) => {
  try {
    const { uid } = req.body || {};
    if (!uid) return res.status(400).json({ erro: 'uid obrigatório' });

    const leitorCodigo = req.leitor.codigo;
    await ensureLastUidTable();

    await db.query(
      `INSERT INTO rfid_last_uid (leitor_codigo, uid, lido_em)
       VALUES (?, UPPER(?), NOW())
       ON DUPLICATE KEY UPDATE uid = VALUES(uid), lido_em = VALUES(lido_em)`,
      [leitorCodigo, uid]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('push-uid error:', e);
    res.status(500).json({ erro: 'Falha ao registrar último UID' });
  }
});

// GET /api/ardloc/last-uid?leitor=CODIGO&maxAgeSec=10  (front → backend)
router.get('/last-uid', async (req, res) => {
  try {
    const leitor = req.query.leitor;
    const maxAgeSec = Number(req.query.maxAgeSec || 10);

    if (!leitor) return res.status(400).json({ erro: 'parâmetro ?leitor é obrigatório' });

    await ensureLastUidTable();

    const [rows] = await db.query(
      `SELECT uid, lido_em
         FROM rfid_last_uid
        WHERE leitor_codigo = ?
        LIMIT 1`,
      [leitor]
    );
    if (!rows.length) return res.json({ uid: null, lido_em: null, recente: false });

    const { uid, lido_em } = rows[0];
    const diffSec = (Date.now() - new Date(lido_em).getTime()) / 1000;
    const recente = diffSec <= maxAgeSec;

    res.json({ uid, lido_em, recente });
  } catch (e) {
    console.error('last-uid error:', e);
    res.status(500).json({ erro: 'Falha ao consultar último UID' });
  }
});

/* =========================================================
   EVENT: leitor RFID → atualiza OS
   Suporta 2 caminhos:
   A) rastreamentorfid (bind TAG→OS)
   B) rfid_tag (uid/uid_hex→id_equipamento) → OS ativa mais recente
   ========================================================= */
router.post('/event', authLeitorHeader, async (req, res) => {
  const rawUid = (req.body?.uid || '').toString().trim();
  if (!rawUid) return res.status(400).json({ erro: 'uid obrigatório' });

  // normaliza UID (HEX contínuo)
  const uid = rawUid.toUpperCase().replace(/[^0-9A-F]/g, '');
  const { id_local: leitorLocal, id_scanner: leitorScanner, codigo: leitorCodigo } = req.leitor;

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    // Tabelas potenciais e colunas
    const osTable = await pickTable(conn, ['ordenservico', 'ordemservico', 'ordensservico']);
    if (!osTable) throw new Error('Tabela de ordens de serviço não encontrada.');

    const pkCol = await getPrimaryKey(conn, osTable);
    if (!pkCol) throw new Error(`Não foi possível detectar a chave primária de ${osTable}.`);

    const hasIdLocal   = await columnExists(conn, osTable, 'id_local');
    const hasIdScanner = await columnExists(conn, osTable, 'id_scanner');
    const localCol = hasIdLocal ? 'id_local' : (hasIdScanner ? 'id_scanner' : null);
    if (!localCol) throw new Error(`Coluna de local não encontrada em ${osTable} (id_local ou id_scanner).`);

    if (!leitorScanner) {
      throw new Error('Leitor não possui id_scanner definido. Atualize o leitor com o id_scanner do setor (ex.: LOC005).');
    }

    // valida id_scanner na tabela local
    const [loc] = await conn.query(`SELECT local_instalado, status_interno FROM local WHERE id_scanner = ? LIMIT 1`, [leitorScanner]);
    if (!loc.length) throw new Error(`id_scanner '${leitorScanner}' não existe em local. Cadastre/ajuste o leitor.`);
    const local_instalado = loc[0].local_instalado;
    const status_interno  = loc[0].status_interno;

    const valorLocalNaOS = leitorScanner;

    // --------- Caminho A: rastreamentorfid (bind TAG→OS) ---------
    let idOS = null;
    const hasRastreamento = await tableExists(conn, 'rastreamentorfid');
    if (hasRastreamento) {
      const [vincRows] = await conn.query(
        `SELECT id_os
           FROM rastreamentorfid
          WHERE UPPER(uid) = UPPER(?) AND tipo='bind' AND desvinculado_em IS NULL
          ORDER BY COALESCE(vinculado_em, evento_em) DESC
          LIMIT 1`,
        [uid]
      );
      if (vincRows.length) {
        idOS = vincRows[0].id_os;
      }
    }

    // --------- Caminho B: rfid_tag → id_equipamento → OS ativa ---------
    if (!idOS) {
      const hasRfidTag = await tableExists(conn, 'rfid_tag');
      if (!hasRfidTag) {
        throw new Error('Tag não vinculada (tabela rastreamentorfid sem bind e tabela rfid_tag ausente).');
      }

      // tenta achar id_equipamento via uid_hex OU uid
      const [tagRows] = await conn.query(
        `SELECT id_equipamento
           FROM rfid_tag
          WHERE UPPER(uid_hex) = UPPER(?) OR UPPER(uid) = UPPER(?)
          LIMIT 1`,
        [uid, uid]
      );
      if (!tagRows.length) {
        throw new Error('Tag não cadastrada em rfid_tag.');
      }
      const id_equip = tagRows[0].id_equipamento;

      // pega OS ativa mais recente desse equipamento
      // tenta colunas usuais (id_status_os/status) sem depender delas em WHERE além do 'status = ativo'
      const [osRows] = await conn.query(
        `SELECT ${pkCol} AS id_os, ${localCol} AS prev_local, id_status_os
           FROM ${osTable}
          WHERE id_equipamento = ? AND status = 'ativo'
          ORDER BY data_atualizacao DESC, data_criacao DESC
          LIMIT 1`,
        [id_equip]
      );
      if (!osRows.length) {
        throw new Error('Nenhuma OS ativa para esse equipamento.');
      }
      idOS = osRows[0].id_os;
    }

    // ---------- Mapeia status pelo local (se status_interno existir) ----------
    let novoStatusId = null;
    const hasStatusOS = await columnExists(conn, osTable, 'id_status_os');
    if (hasStatusOS && status_interno) {
      const [[st]] = await conn.query(
        `SELECT id_status FROM status_os WHERE descricao = ? LIMIT 1`,
        [status_interno]
      );
      if (st?.id_status) {
        novoStatusId = Number(st.id_status);
      }
    }

    // carrega dados anteriores da OS (para auditoria)
    const [[prevRow]] = await conn.query(
      `SELECT ${localCol} AS prev_local, ${hasStatusOS ? 'id_status_os' : 'NULL'} AS prev_status
         FROM ${osTable}
        WHERE ${pkCol} = ?
        LIMIT 1`,
      [idOS]
    );
    const prevLocal  = prevRow?.prev_local ?? null;
    const prevStatus = prevRow?.prev_status ?? null;

    // ---------- Atualiza OS: local + (status, se existir coluna) + timestamp ----------
    const hasAtualizadoEm    = await columnExists(conn, osTable, 'atualizado_em');
    const hasDataAtualizacao = await columnExists(conn, osTable, 'data_atualizacao');

    let sql = `UPDATE ${osTable} SET ${localCol} = ?`;
    const params = [valorLocalNaOS];

    if (hasStatusOS && novoStatusId !== null) {
      sql += `, id_status_os = ?`;
      params.push(novoStatusId);
    }
    if (hasAtualizadoEm) {
      sql += `, atualizado_em = NOW()`;
    } else if (hasDataAtualizacao) {
      sql += `, data_atualizacao = NOW()`;
    }
    sql += ` WHERE ${pkCol} = ? LIMIT 1`;
    params.push(idOS);

    await conn.query(sql, params);

    // ---------- Log de rastreamento (se tabela existir) ----------
    if (hasRastreamento) {
      await conn.query(
        `INSERT INTO rastreamentorfid (uid, id_os, id_local, tipo, evento_em)
         VALUES (UPPER(?), ?, ?, 'move', NOW())`,
        [uid, idOS, leitorLocal || null]
      );
    }

    // ---------- Auditoria (se helper existir) ----------
    try {
      if (String(prevLocal) !== String(valorLocalNaOS)) {
        await logAudit(conn, {
          entityType: 'ordem',
          entityId: Number(idOS),
          action: 'local',
          field: localCol,
          oldValue: String(prevLocal),
          newValue: String(valorLocalNaOS),
          note: `RFID ${uid} → ${local_instalado} (${leitorScanner})`,
          userId: null
        });
      }
      if (hasStatusOS && novoStatusId !== null && Number(prevStatus) !== Number(novoStatusId)) {
        const [[oldS]] = await conn.query('SELECT descricao FROM status_os WHERE id_status = ?', [prevStatus]);
        const [[newS]] = await conn.query('SELECT descricao FROM status_os WHERE id_status = ?', [novoStatusId]);
        await logAudit(conn, {
          entityType: 'ordem',
          entityId: Number(idOS),
          action: 'status',
          field: 'id_status_os',
          oldValue: String(prevStatus),
          newValue: String(novoStatusId),
          note: `${oldS?.descricao || prevStatus} → ${newS?.descricao || novoStatusId} (RFID)`,
          userId: null
        });
      }
    } catch {}

    await conn.commit(); conn.release();

    return res.json({
      ok: true,
      mensagem: 'OS atualizada a partir do RFID',
      data: {
        uid,
        leitor: leitorCodigo,
        id_os: idOS,
        novo_local: valorLocalNaOS,
        novo_status: novoStatusId
      }
    });
  } catch (err) {
    try { if (conn) await conn.rollback(); } catch {}
    try { if (conn) conn.release(); } catch {}
    console.error('Erro no /api/ardloc/event:', err);
    return res.status(400).json({ erro: err.message || 'Falha ao processar evento RFID' });
  }
});

module.exports = router;
