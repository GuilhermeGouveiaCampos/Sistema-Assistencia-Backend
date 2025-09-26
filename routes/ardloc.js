// backend/routes/ardloc.js
const express = require('express');
const bcrypt  = require('bcryptjs');
const router  = express.Router();
const db      = require('../db');
const { notifyLocalChange } = require('../utils/whats');


// audit opcional (se existir)
let logAudit = async () => {};
try { ({ logAudit } = require('../utils/audit')); } catch { /* segue sem auditoria */ }

/* =========================================================
   Sanidade
   ========================================================= */
router.get('/__ping', (_req, res) => {
  console.log('[DEBUG][__ping] ardloc ok');
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
   Helpers de conexão (suporta db sem getConnection)
   ========================================================= */
async function getConnFlexible(dbObj) {
  if (dbObj && typeof dbObj.getConnection === 'function') {
    return await dbObj.getConnection();
  }
  if (dbObj && dbObj.pool && typeof dbObj.pool.getConnection === 'function') {
    return await dbObj.pool.getConnection();
  }
  if (dbObj && typeof dbObj.query === 'function') {
    // usa o próprio db como "conn"
    return dbObj;
  }
  throw new Error('Pool/DB inválido: não há getConnection() nem query()');
}
async function safeBegin(conn)    { if (conn && typeof conn.beginTransaction === 'function') await conn.beginTransaction(); }
async function safeCommit(conn)   { if (conn && typeof conn.commit           === 'function') await conn.commit(); }
async function safeRollback(conn) { if (conn && typeof conn.rollback         === 'function') await conn.rollback(); }
async function safeRelease(conn)  { if (conn && typeof conn.release          === 'function') await conn.release(); }

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

    console.log('[DEBUG][authLeitorHeader] headers =', {
      'x-leitor-codigo': req.header('x-leitor-codigo'),
      'x-leitor-id': req.header('x-leitor-id'),
      'x-leitor-key': key ? '(recebida)' : '(vazia)'
    });

    if (!codigo || !key) return res.status(401).json({ erro: 'Cabeçalhos do leitor ausentes' });

    const leitor = await getLeitorByCodigo(codigo);
    console.log('[DEBUG][authLeitorHeader] leitor encontrado =', leitor && { codigo: leitor.codigo, id_scanner: leitor.id_scanner, status: leitor.status });

    if (!leitor) return res.status(401).json({ erro: 'Leitor não cadastrado' });
    if (leitor.status && String(leitor.status).toLowerCase() !== 'ativo') {
      return res.status(403).json({ erro: 'Leitor inativo' });
    }
    if (!leitor.api_key_hash) return res.status(401).json({ erro: 'Leitor sem chave definida' });

    const ok = await bcrypt.compare(key, leitor.api_key_hash);
    console.log('[DEBUG][authLeitorHeader] bcrypt.compare =', ok);
    if (!ok) return res.status(401).json({ erro: 'Chave inválida' });

    req.leitor = leitor;
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
    console.log('[DEBUG][/leitores] upsert', { codigo, id_scanner, status, created });
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
    console.log('[DEBUG][/leitores/:codigo/key] updated', { codigo, affected: r.affectedRows });
    if (!r.affectedRows) return res.status(404).json({ erro: 'Leitor não encontrado' });
    res.json({ ok: true, mensagem: 'Chave atualizada', data: { codigo } });
  } catch (e) {
    console.error('PUT /leitores/:codigo/key error:', e);
    res.status(500).json({ erro: 'Falha ao atualizar chave' });
  }
});

// GET /api/ardloc/leitores  (para o select do front)
router.get('/leitores', async (_req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT codigo, COALESCE(NULLIF(nome,''), codigo) AS nome
         FROM rfid_leitor
        WHERE status IS NULL OR status = 'ativo'
        ORDER BY nome, codigo`
    );
    if (rows.length) {
      console.log('[DEBUG][/leitores] retornando rfid_leitor', rows.length);
      return res.json(rows.map(r => ({ codigo: String(r.codigo), nome: String(r.nome) })));
    }

    const [locais] = await db.query(
      `SELECT id_scanner AS codigo, local_instalado AS nome
         FROM local
        WHERE status = 'ativo'
          AND id_scanner IS NOT NULL
          AND id_scanner <> ''
        ORDER BY local_instalado`
    );
    console.log('[DEBUG][/leitores] fallback local (count)=', locais.length);
    return res.json(locais.map(r => ({ codigo: String(r.codigo), nome: String(r.nome) })));
  } catch (err) {
    console.error('GET /ardloc/leitores error:', err);
    res.status(500).json({ erro: 'Falha ao listar leitores' });
  }
});

/* =========================================================
   Push / Last UID (auto-preencher no front)
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

router.post('/push-uid', authLeitorHeader, async (req, res) => {
  try {
    const { uid } = req.body || {};
    if (!uid) return res.status(400).json({ erro: 'uid obrigatório' });

    const leitorCodigo = req.leitor.codigo;
    await ensureLastUidTable();

    console.log('[DEBUG][push-uid] salvar', { leitorCodigo, uid });

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
    const leitor    = req.query.leitor;
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
    if (!rows.length) {
      console.log('[DEBUG][last-uid] não encontrado para', leitor);
      return res.json({ uid: null, lido_em: null, recente: false });
    }

    const { uid, lido_em } = rows[0];
    const diffSec = (Date.now() - new Date(lido_em).getTime()) / 1000;
    const recente = diffSec <= maxAgeSec;

    console.log('[DEBUG][last-uid] retorno', { leitor, uid, lido_em, diffSec: Math.round(diffSec), recente });

    res.json({ uid, lido_em, recente });
  } catch (e) {
    console.error('last-uid error:', e);
    res.status(500).json({ erro: 'Falha ao consultar último UID' });
  }
});


/* =========================================================
   BIND/UNBIND de TAG ↔ OS  (sem usar routes/rfid.js)
   Tabela usada: rastreamentorfid  (cria se não existir)
   ========================================================= */
async function ensureRastreamentoTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rastreamentorfid (
      id_log INT AUTO_INCREMENT PRIMARY KEY,
      uid VARCHAR(64) NOT NULL,
      id_os INT NOT NULL,
      id_local INT NULL,
      tipo ENUM('bind','move') NOT NULL DEFAULT 'bind',
      evento_em DATETIME NULL,
      vinculado_em DATETIME NULL,
      desvinculado_em DATETIME NULL,
      KEY idx_uid (uid),
      KEY idx_os (id_os),
      KEY idx_tipo (tipo),
      KEY idx_vinc (vinculado_em),
      KEY idx_desv (desvinculado_em)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

// GET /api/ardloc/bind/list?id_os=123
router.get('/bind/list', async (req, res) => {
  const id_os = Number(req.query.id_os);
  if (!Number.isFinite(id_os)) return res.status(400).json({ erro: 'id_os inválido' });

  await ensureRastreamentoTable();
  const [rows] = await db.query(
    `SELECT UPPER(uid) AS uid, COALESCE(vinculado_em, evento_em) AS desde
       FROM rastreamentorfid
      WHERE id_os = ? AND tipo='bind' AND desvinculado_em IS NULL
      ORDER BY COALESCE(vinculado_em, evento_em) DESC`,
    [id_os]
  );
  res.json(rows);
});

// GET /api/ardloc/bind/current?id_os=123
router.get('/bind/current', async (req, res) => {
  const id_os = Number(req.query.id_os);
  if (!Number.isFinite(id_os)) return res.status(400).json({ erro: 'id_os inválido' });

  await ensureRastreamentoTable();
  const [rows] = await db.query(
    `SELECT UPPER(uid) AS uid
       FROM rastreamentorfid
      WHERE id_os = ? AND tipo='bind' AND desvinculado_em IS NULL
      ORDER BY COALESCE(vinculado_em, evento_em) DESC
      LIMIT 1`,
    [id_os]
  );
  res.json(rows[0] || { uid: '' });
});

// POST /api/ardloc/bind  { uid, id_os }
router.post('/bind', async (req, res) => {
  let uid = (req.body?.uid || '').toString().toUpperCase().replace(/[^0-9A-F]/g, '');
  const id_os = Number(req.body?.id_os);
  if (!uid || !/^[0-9A-F]{8,}$/.test(uid)) return res.status(400).json({ erro: 'uid inválido' });
  if (!Number.isFinite(id_os)) return res.status(400).json({ erro: 'id_os inválido' });

  await ensureRastreamentoTable();
  let conn;
  try {
    conn = await getConnFlexible(db);
    await safeBegin(conn);

    await conn.query(
      `UPDATE rastreamentorfid
          SET desvinculado_em = NOW()
        WHERE UPPER(uid) = ? AND desvinculado_em IS NULL AND tipo='bind'`,
      [uid]
    );

    await conn.query(
      `INSERT INTO rastreamentorfid (uid, id_os, tipo, vinculado_em)
       VALUES (UPPER(?), ?, 'bind', NOW())`,
      [uid, id_os]
    );

    await safeCommit(conn);
    await safeRelease(conn);

    
    console.log('[DEBUG][/bind] vinculado', { uid, id_os });
    res.json({ ok: true, mensagem: 'TAG vinculada', uid, id_os });
  } catch (e) {
    await safeRollback(conn); await safeRelease(conn);
    console.error('bind error:', e);
    res.status(500).json({ erro: 'Falha ao vincular TAG' });
  }
});

// POST /api/ardloc/unbind  { uid }
router.post('/unbind', async (req, res) => {
  let uid = (req.body?.uid || '').toString().toUpperCase().replace(/[^0-9A-F]/g, '');
  if (!uid || !/^[0-9A-F]{8,}$/.test(uid)) return res.status(400).json({ erro: 'uid inválido' });

  await ensureRastreamentoTable();
  const [r] = await db.query(
    `UPDATE rastreamentorfid
        SET desvinculado_em = NOW()
      WHERE UPPER(uid) = ? AND desvinculado_em IS NULL AND tipo='bind'`,
    [uid]
  );
  console.log('[DEBUG][/unbind] desvinculo', { uid, affected: r.affectedRows });
  if (!r.affectedRows) return res.status(404).json({ erro: 'Nenhum vínculo ativo para esta TAG' });
  res.json({ ok: true, mensagem: 'TAG desvinculada', uid });
});

/* =========================================================
   EVENT: leitor RFID → atualiza OS
   ========================================================= */
router.post('/event', authLeitorHeader, async (req, res) => {
  const rawUid = (req.body?.uid || '').toString().trim();
  if (!rawUid) return res.status(400).json({ erro: 'uid obrigatório' });

  const uid = rawUid.toUpperCase().replace(/[^0-9A-F]/g, '');
  const { id_local: leitorLocal, id_scanner: leitorScanner, codigo: leitorCodigo } = req.leitor;

  console.log('[DEBUG][event] inicio', { uid, leitorCodigo, leitorScanner, leitorLocal });

  let conn;
  try {
    conn = await getConnFlexible(db);
    await safeBegin(conn);

    // grava last-uid (para o front ler, mesmo em EVENT)
    await ensureLastUidTable();
    await db.query(
      `INSERT INTO rfid_last_uid (leitor_codigo, uid, lido_em)
       VALUES (?, UPPER(?), NOW())
       ON DUPLICATE KEY UPDATE uid = VALUES(uid), lido_em = VALUES(lido_em)`,
      [leitorCodigo, uid]
    );
    console.log('[DEBUG][event] last-uid gravado', { leitorCodigo, uid });

    // Tabelas potenciais e colunas
    const osTable = await pickTable(conn, ['ordenservico', 'ordemservico', 'ordensservico']);
    console.log('[DEBUG][event] osTable =', osTable);
    if (!osTable) throw new Error('Tabela de ordens de serviço não encontrada.');

    const pkCol = await getPrimaryKey(conn, osTable);
    console.log('[DEBUG][event] pkCol =', pkCol);
    if (!pkCol) throw new Error(`Não foi possível detectar a chave primária de ${osTable}.`);

    const hasIdLocal   = await columnExists(conn, osTable, 'id_local');
    const hasIdScanner = await columnExists(conn, osTable, 'id_scanner');
    const localCol = hasIdLocal ? 'id_local' : (hasIdScanner ? 'id_scanner' : null);
    console.log('[DEBUG][event] localCol =', localCol, { hasIdLocal, hasIdScanner });
    if (!localCol) throw new Error(`Coluna de local não encontrada em ${osTable} (id_local ou id_scanner).`);

    if (!leitorScanner) {
      throw new Error('Leitor não possui id_scanner definido. Atualize o leitor com o id_scanner do setor (ex.: LOC005).');
    }

    // valida id_scanner na tabela local
    const [loc] = await conn.query(
      `SELECT local_instalado, status_interno FROM local WHERE id_scanner = ? LIMIT 1`,
      [leitorScanner]
    );
    console.log('[DEBUG][event] local lido =', loc && loc[0]);
    if (!loc.length) throw new Error(`id_scanner '${leitorScanner}' não existe em local. Cadastre/ajuste o leitor.`);
    const local_instalado = loc[0].local_instalado;
    const status_interno  = loc[0].status_interno;

    const valorLocalNaOS = leitorScanner;

    // Caminho A: rastreamentorfid (bind TAG→OS)
    let idOS = null;
    const hasRastreamento = await tableExists(conn, 'rastreamentorfid');
    console.log('[DEBUG][event] hasRastreamento =', hasRastreamento);
    if (hasRastreamento) {
      const [vincRows] = await conn.query(
        `SELECT id_os
           FROM rastreamentorfid
          WHERE UPPER(uid) = UPPER(?) AND tipo='bind' AND desvinculado_em IS NULL
          ORDER BY COALESCE(vinculado_em, evento_em) DESC
          LIMIT 1`,
        [uid]
      );
      if (vincRows.length) idOS = vincRows[0].id_os;
      console.log('[DEBUG][event] idOS via rastreamentorfid =', idOS);
    }

    // Caminho B: rfid_tag → id_equipamento → OS ativa
    if (!idOS) {
      const hasRfidTag = await tableExists(conn, 'rfid_tag');
      console.log('[DEBUG][event] hasRfidTag =', hasRfidTag);
      if (!hasRfidTag) {
        throw new Error('Tag não vinculada (tabela rastreamentorfid sem bind e tabela rfid_tag ausente).');
      }
      const [tagRows] = await conn.query(
        `SELECT id_equipamento
           FROM rfid_tag
          WHERE UPPER(uid_hex) = UPPER(?) OR UPPER(uid) = UPPER(?)
          LIMIT 1`,
        [uid, uid]
      );
      console.log('[DEBUG][event] tagRows =', tagRows && tagRows[0]);
      if (!tagRows.length) throw new Error('Tag não cadastrada em rfid_tag.');
      const id_equip = tagRows[0].id_equipamento;

      const [osRows] = await conn.query(
        `SELECT ${pkCol} AS id_os, ${localCol} AS prev_local, id_status_os
           FROM ${osTable}
          WHERE id_equipamento = ? AND status = 'ativo'
          ORDER BY data_atualizacao DESC, data_criacao DESC
          LIMIT 1`,
        [id_equip]
      );
      console.log('[DEBUG][event] osRows =', osRows && osRows[0]);
      if (!osRows.length) throw new Error('Nenhuma OS ativa para esse equipamento.');
      idOS = osRows[0].id_os;
    }
    console.log('[DEBUG][event] idOS final =', idOS);

    // Mapeia status pelo local
    let novoStatusId = null;
    const hasStatusOS = await columnExists(conn, osTable, 'id_status_os');
    if (hasStatusOS && status_interno) {
      const [[st]] = await conn.query(
        `SELECT id_status FROM status_os WHERE descricao = ? LIMIT 1`,
        [status_interno]
      );
      if (st?.id_status) novoStatusId = Number(st.id_status);
    }
    console.log('[DEBUG][event] status mapeado =', { hasStatusOS, status_interno, novoStatusId });

    // carrega dados anteriores (para auditoria)
    const [[prevRow]] = await conn.query(
      `SELECT ${localCol} AS prev_local, ${hasStatusOS ? 'id_status_os' : 'NULL'} AS prev_status
         FROM ${osTable}
        WHERE ${pkCol} = ?
        LIMIT 1`,
      [idOS]
    );
    const prevLocal  = prevRow?.prev_local ?? null;
    const prevStatus = prevRow?.prev_status ?? null;
    console.log('[DEBUG][event] prev', { prevLocal, prevStatus });

    // Atualiza OS
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

    console.log('[DEBUG][event] UPDATE OS', { sql, params });
    await conn.query(sql, params);

    // Log de rastreamento (se existir)
    if (hasRastreamento) {
      await conn.query(
        `INSERT INTO rastreamentorfid (uid, id_os, id_local, tipo, evento_em)
         VALUES (UPPER(?), ?, ?, 'move', NOW())`,
        [uid, idOS, leitorLocal || null]
      );
      console.log('[DEBUG][event] rastreamento move inserido');
    }

    // Auditoria (opcional)
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
        console.log('[DEBUG][event] audit local ok');
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
        console.log('[DEBUG][event] audit status ok');
      }
    } catch (e) {
      console.warn('[DEBUG][event] audit opcional falhou (ignorado):', e?.message);
    }

    await safeCommit(conn);
    await safeRelease(conn);

    console.log('[DEBUG][event] sucesso', { idOS, valorLocalNaOS, novoStatusId });

    // 🔔 WhatsApp (após commit): avisa cliente que a OS mudou de local
    try {
      const [[cli]] = await db.query(
        `SELECT c.nome, c.celular, c.telefone
           FROM cliente c
           JOIN ${osTable} o ON o.id_cliente = c.id_cliente
          WHERE o.${pkCol} = ?
          LIMIT 1`,
        [idOS]
      );

      await notifyLocalChange({
        osId: idOS,
        localNome: local_instalado,
        idScanner: leitorScanner,
        clienteNome: cli?.nome,
        phone: cli?.celular || cli?.telefone || null
      });
    } catch (e) {
      console.warn('[whats][event] aviso falhou:', e.message);
    }

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
    await safeRollback(conn);
    await safeRelease(conn);
    console.error('Erro no /api/ardloc/event:', err);
    return res.status(400).json({ erro: err.message || 'Falha ao processar evento RFID' });
  }
});

module.exports = router;
