// backend/routes/ardloc.js
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../db');

/* =========================================================
   Sanidade
   ========================================================= */
router.get('/__ping', (_req, res) => {
  res.json({ ok: true, where: 'ardloc' });
});

/* =========================================================
   Helpers
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
    const key    = req.header('x-leitor-key') || req.header('x-api-key') || null;
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
   EVENT: leitor RFID → atualiza OS (TAG ↔ OS via rastreamentorfid)
   ========================================================= */
router.post('/event', authLeitorHeader, async (req, res) => {
  const { uid } = req.body || {};
  if (!uid) return res.status(400).json({ erro: 'uid obrigatório' });

  const { id_local: leitorLocal, id_scanner: leitorScanner, codigo: leitorCodigo } = req.leitor;

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    // Tabela de OS
    const osTable = await pickTable(conn, ['ordenservico', 'ordensservico', 'ordemservico']);
    if (!osTable) throw new Error('Tabela de ordens de serviço não encontrada.');

    // PK da OS
    const pkCol = await getPrimaryKey(conn, osTable);
    if (!pkCol) throw new Error(`Não foi possível detectar a chave primária de ${osTable}.`);

    // Coluna de local
    const hasIdLocal   = await columnExists(conn, osTable, 'id_local');
    const hasIdScanner = await columnExists(conn, osTable, 'id_scanner');
    const localCol = hasIdLocal ? 'id_local' : (hasIdScanner ? 'id_scanner' : null);
    if (!localCol) throw new Error(`Coluna de local não encontrada em ${osTable} (id_local ou id_scanner).`);

    if (!leitorScanner) {
      throw new Error('Leitor não possui id_scanner definido. Atualize o leitor com o id_scanner do setor (ex.: LOC002).');
    }

    // valida id_scanner na tabela local
    const [loc] = await conn.query(`SELECT 1 FROM local WHERE id_scanner = ? LIMIT 1`, [leitorScanner]);
    if (!loc.length) throw new Error(`id_scanner '${leitorScanner}' não existe em local. Cadastre/ajuste o leitor.`);

    // valor que vai para a OS (sempre o id_scanner)
    const valorLocalNaOS = leitorScanner;

    // Vínculo ATIVO TAG → OS
    const [vincRows] = await conn.query(
      `SELECT id_os
         FROM rastreamentorfid
        WHERE UPPER(uid) = UPPER(?) AND tipo='bind' AND desvinculado_em IS NULL
        ORDER BY COALESCE(vinculado_em, evento_em) DESC
        LIMIT 1`,
      [uid]
    );
    if (!vincRows.length) throw new Error('Tag não vinculada a nenhuma OS ativa. Faça o bind na recepção.');
    const idOS = vincRows[0].id_os;

    // Tag ativa em rfid_tag
    const [tagRows] = await conn.query(
      `SELECT COALESCE(status,'ativo') AS status
         FROM rfid_tag
        WHERE UPPER(uid) = UPPER(?) OR UPPER(uid_hex) = UPPER(?)
        LIMIT 1`,
      [uid, uid]
    );
    if (!tagRows.length) {
      await conn.query(`INSERT INTO rfid_tag (uid, status) VALUES (UPPER(?), 'ativo')`, [uid]);
    } else if (tagRows[0].status !== 'ativo') {
      throw new Error('Tag inativa');
    }

    // Atualiza OS (local + timestamp)
    const hasAtualizadoEm    = await columnExists(conn, osTable, 'atualizado_em');
    const hasDataAtualizacao = await columnExists(conn, osTable, 'data_atualizacao');

    if (hasAtualizadoEm) {
      await conn.query(
        `UPDATE ${osTable}
            SET ${localCol} = ?, atualizado_em = NOW()
          WHERE ${pkCol} = ?
          LIMIT 1`,
        [valorLocalNaOS, idOS]
      );
    } else if (hasDataAtualizacao) {
      await conn.query(
        `UPDATE ${osTable}
            SET ${localCol} = ?, data_atualizacao = NOW()
          WHERE ${pkCol} = ?
          LIMIT 1`,
        [valorLocalNaOS, idOS]
      );
    } else {
      await conn.query(
        `UPDATE ${osTable}
            SET ${localCol} = ?
          WHERE ${pkCol} = ?
          LIMIT 1`,
        [valorLocalNaOS, idOS]
      );
    }

    // Loga o movimento
    await conn.query(
      `INSERT INTO rastreamentorfid (uid, id_os, id_local, tipo, evento_em)
       VALUES (UPPER(?), ?, ?, 'move', NOW())`,
      [uid, idOS, leitorLocal || null]
    );

    await conn.commit(); conn.release();

    return res.json({
      ok: true,
      mensagem: 'OS atualizada com o local do leitor (id_scanner do setor)',
      data: {
        uid,
        leitor_id: leitorCodigo,
        os_tabela: osTable,
        os_pk: pkCol,
        id_os: idOS,
        local_col: localCol,
        novo_valor: valorLocalNaOS
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
