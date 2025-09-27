// routes/ordens.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { logAudit } = require('../utils/audit');
const sharp = require('sharp');

// 🔔 WhatsApp (Evolution API) – avisa mudanças de LOCAL
const { notifyLocalChange } = require('../utils/whats');

// Multer em memória (definido no middleware)
const { upload } = require('../middleware/upload');

console.log('🧩 routes/ordens.js carregado');

/**
 * Cadastro de ordem (suporta multipart com campo "imagens")
 * -> As imagens são comprimidas (JPEG) e salvas como BLOB no MySQL
 */
router.post('/', upload.array('imagens', 20), async (req, res) => {
  const {
    id_cliente,
    id_tecnico,
    id_equipamento,
    id_local,          // STRING (ex.: "LOC001")
    id_status_os,
    descricao_problema,
    descricao_servico,
    data_criacao,
    data_inicio_reparo,
    data_fim_reparo,
    tempo_servico
  } = req.body;

  const files = req.files || [];
  const userId = Number(req.headers['x-user-id']) || null;

  const sqlInsert = `
    INSERT INTO ordenservico (
      id_cliente, id_tecnico, id_equipamento, id_local, id_status_os,
      descricao_problema, descricao_servico, data_criacao,
      data_inicio_reparo, data_fim_reparo, tempo_servico, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ativo')
  `;

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    const [result] = await conn.query(sqlInsert, [
      id_cliente,
      id_tecnico,
      id_equipamento,
      id_local,
      id_status_os,
      descricao_problema,
      descricao_servico,
      data_criacao,
      data_inicio_reparo,
      data_fim_reparo,
      tempo_servico
    ]);

    const id_os = result.insertId;

    // 📝 AUDIT
    await logAudit(conn, {
      entityType: 'ordem',
      entityId: id_os,
      action: 'criou',
      note: 'Cadastro de OS',
      userId
    });
    if (id_local) {
      await logAudit(conn, {
        entityType: 'ordem',
        entityId: id_os,
        action: 'local',
        field: 'id_local',
        oldValue: null,
        newValue: String(id_local),
        userId
      });
    }
    if (id_status_os) {
      await logAudit(conn, {
        entityType: 'ordem',
        entityId: id_os,
        action: 'status',
        field: 'id_status_os',
        oldValue: null,
        newValue: String(id_status_os),
        userId
      });
    }

    // 👉 Se houver imagens, salvar BINÁRIO no banco (com compressão)
    if (files.length > 0) {
      const rowsToInsert = [];

      for (const f of files) {
        let outBuf = f.buffer;
        let outMime = f.mimetype;

        try {
          const img = sharp(f.buffer).rotate(); // corrige EXIF
          const meta = await img.metadata();
          if ((meta.width || 0) > 1600) img.resize({ width: 1600 });

          // JPEG para reduzir tamanho
          outBuf = await img.jpeg({ quality: 80 }).toBuffer();
          outMime = 'image/jpeg';
        } catch {
          // segue com o original se der erro
          outBuf = f.buffer;
          outMime = f.mimetype || 'application/octet-stream';
        }

        rowsToInsert.push([
          id_os,
          null,                         // url (não usamos disco)
          f.originalname || null,
          outMime,
          outBuf.length,
          outBuf                        // BINÁRIO
        ]);
      }

      await conn.query(
        `INSERT INTO os_imagem (id_os, url, original_name, mime, size, data)
         VALUES ?`,
        [rowsToInsert]
      );

      await logAudit(conn, {
        entityType: 'ordem',
        entityId: id_os,
        action: 'imagem_add',
        note: `+${files.length} imagem(ns) (blob)`,
        userId
      });
    }

    await conn.commit();
    res.status(201).json({ mensagem: 'Ordem cadastrada com sucesso!', id_os });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('❌ Erro ao cadastrar ordem de serviço:', err);
    res.status(500).json({ erro: 'Erro ao cadastrar ordem de serviço.' });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * Listas auxiliares (clientes/tecnicos/locais)
 */
router.get('/clientes', async (_req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id_cliente, nome, cpf FROM cliente WHERE status = "ativo"'
    );
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar clientes:', err);
    res.status(500).json({ erro: 'Erro ao buscar clientes.' });
  }
});

router.get('/tecnicos', async (_req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id_tecnico, nome, cpf FROM tecnico WHERE status = "ativo"'
    );
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar técnicos:', err);
    res.status(500).json({ erro: 'Erro ao buscar técnicos.' });
  }
});

/* ✅ Locais: lista TODOS (sem join/duplicatas) */
router.get('/locais', async (_req, res) => {
  try {
    const [locais] = await db.query(`
      SELECT 
        TRIM(id_scanner)      AS id_scanner,
        TRIM(local_instalado) AS local_instalado,
        TRIM(status_interno)  AS status_interno,
        TRIM(status)          AS status
      FROM local
      ORDER BY id_scanner
    `);

    // mapa status_os (descricao -> id_status), se existir
    let statusMap = new Map();
    try {
      const [sts] = await db.query(`SELECT id_status, descricao FROM status_os`);
      for (const s of sts) statusMap.set(String(s.descricao || '').trim(), Number(s.id_status));
    } catch { /* opcional */ }

    const vistos = new Set();
    const saida = [];
    for (const l of locais) {
      const key = String(l.id_scanner || '').trim();
      if (!key || vistos.has(key)) continue;
      vistos.add(key);

      const desc = String(l.status_interno || '').trim();
      const id_status = statusMap.has(desc) ? statusMap.get(desc) : 0;

      saida.push({
        id_local: key,
        id_scanner: key,
        local_instalado: String(l.local_instalado || '').trim(),
        status_interno: desc,
        id_status: Number(id_status || 0),
        status: String(l.status || '').trim()
      });
    }

    console.log(`[ordens/locais] retornando ${saida.length} locais`);
    res.json(saida);
  } catch (err) {
    console.error('GET /api/ordens/locais error:', err);
    res.status(500).json({ erro: 'Falha ao listar locais' });
  }
});

/* 🔎 Histórico de auditoria da OS (com labels legíveis) */
router.get('/:id/auditoria', async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ erro: 'ID inválido' });

  try {
    const [rows] = await db.query(
      `
      SELECT 
        a.id_log,
        a.action,
        a.field,
        a.note,
        a.user_id,
        u.nome AS usuario,
        a.created_at,

        CASE 
          WHEN a.field = 'id_local' THEN COALESCE(
            (SELECT l.local_instalado FROM local l WHERE l.id_scanner = a.old_value LIMIT 1),
            a.old_value
          )
          WHEN a.field = 'id_status_os' THEN COALESCE(
            (SELECT s.descricao FROM status_os s WHERE s.id_status = CAST(a.old_value AS UNSIGNED) LIMIT 1),
            a.old_value
          )
          ELSE a.old_value
        END AS old_label,

        CASE 
          WHEN a.field = 'id_local' THEN COALESCE(
            (SELECT l.local_instalado FROM local l WHERE l.id_scanner = a.new_value LIMIT 1),
            a.new_value
          )
          WHEN a.field = 'id_status_os' THEN COALESCE(
            (SELECT s.descricao FROM status_os s WHERE s.id_status = CAST(a.new_value AS UNSIGNED) LIMIT 1),
            a.new_value
          )
          ELSE a.new_value
        END AS new_label

      FROM audit_log a
      LEFT JOIN usuario u ON u.id_usuario = a.user_id
      WHERE a.entity_type = 'ordem' AND a.entity_id = ?
      ORDER BY a.created_at DESC, a.id_log DESC
      `,
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ Erro ao buscar auditoria da OS:', err);
    res.status(500).json({ erro: 'Erro ao buscar auditoria.' });
  }
});

/* ================== Imagens da OS ================== */

// Stream do binário (BLOB) da imagem
router.get('/imagens/blob/:id_img', async (req, res) => {
  const { id_img } = req.params;
  if (!/^\d+$/.test(id_img)) return res.status(400).send('ID inválido');

  try {
    const [[img]] = await db.query(
      'SELECT data, mime FROM os_imagem WHERE id_imagem = ?',
      [id_img]
    );
    if (!img || !img.data) return res.status(404).send('Imagem não encontrada');

    res.setHeader('Content-Type', img.mime || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(img.data);
  } catch (e) {
    console.error('GET /imagens/blob/:id_img error:', e);
    res.status(500).send('Erro ao carregar imagem');
  }
});

// Lista imagens da OS (com URL virtual para o blob)
router.get('/:id/imagens', async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ erro: 'ID inválido' });

  try {
    const [rows] = await db.query(
      'SELECT id_imagem, original_name, mime, size, created_at FROM os_imagem WHERE id_os = ? ORDER BY id_imagem DESC',
      [id]
    );

    const imagens = rows.map(r => ({
      ...r,
      url: `/api/ordens/imagens/blob/${r.id_imagem}` // front usa esta URL
    }));

    res.json(imagens);
  } catch (err) {
    console.error('❌ Erro ao listar imagens:', err);
    res.status(500).json({ erro: 'Erro ao listar imagens.' });
  }
});

// Deleta 1 imagem da OS (apenas banco)
router.delete('/:id/imagens/:id_img', async (req, res) => {
  const { id, id_img } = req.params;
  const userId = Number(req.headers['x-user-id']) || null;

  if (!/^\d+$/.test(id) || !/^\d+$/.test(id_img)) {
    return res.status(400).json({ erro: 'ID inválido' });
  }

  try {
    const [[img]] = await db.query(
      'SELECT original_name FROM os_imagem WHERE id_imagem = ? AND id_os = ?',
      [id_img, id]
    );
    if (!img) return res.status(404).json({ erro: 'Imagem não encontrada.' });

    await db.query('DELETE FROM os_imagem WHERE id_imagem = ?', [id_img]);

    await logAudit(db, {
      entityType: 'ordem',
      entityId: Number(id),
      action: 'imagem_del',
      note: `Removeu imagem ${img.original_name || id_img}`,
      userId,
    });

    res.json({ mensagem: 'Imagem removida com sucesso.' });
  } catch (err) {
    console.error('❌ Erro ao remover imagem:', err);
    res.status(500).json({ erro: 'Erro ao remover imagem.' });
  }
});

/**
 * Atualizar ordem + controlar timer (diagnóstico/orçamento)
 */
router.put('/:id', async (req, res) => {
  const id_ordem = req.params.id;
  let { descricao_problema, id_local, id_status } = req.body || {};
  const userId = Number(req.headers['x-user-id']) || null;

  if (!/^\d+$/.test(String(id_ordem))) {
    return res.status(400).json({ erro: 'ID inválido' });
  }

  const idLocalStr = String(id_local || '').trim();
  let idStatusNum = Number(id_status);

  try {
    const [prevRows] = await db.query(
      `SELECT id_local, id_status_os, descricao_problema, data_inicio_reparo, data_fim_reparo, tempo_servico
       FROM ordenservico
       WHERE id_os = ?`,
      [id_ordem]
    );
    if (!prevRows.length) return res.status(404).json({ erro: 'Ordem não encontrada' });
    const prev = prevRows[0];

    /* 🔧 AJUSTE: validar local ATIVO e mapear status corretamente
       - Se status_interno não existir em status_os, usa fallback por id_local (inclui LOC008 → 6)
    */
    const [[locRow]] = await db.query(
      `SELECT TRIM(id_scanner) AS id_scanner,
              TRIM(local_instalado) AS local_instalado,
              TRIM(status_interno)  AS status_interno,
              TRIM(status)          AS status
         FROM local
        WHERE TRIM(id_scanner) = TRIM(?)
        LIMIT 1`,
      [idLocalStr]
    );
    if (!locRow || locRow.status !== 'ativo') {
      return res.status(400).json({ erro: 'Status inválido. Selecione um local válido.' });
    }

    const MAP_LOCAL_TO_STATUS = {
      LOC_DIAG: 2, // Diagnóstico
      LOC001: 1,   // Recebido
      LOC002: 2,   // Em Diagnóstico
      LOC003: 3,   // Aguardando Aprovação
      LOC004: 4,   // Aguardando Peça
      LOC005: 5,   // Em Reparo
      LOC006: 6,   // Finalizado
      LOC007: 7,   // Aguardando Retirada
      LOC008: 6    // Com Cliente → Finalizado (Entregue)
    };

    if (!idStatusNum || Number.isNaN(idStatusNum)) {
      // tenta pelo status_interno (ex.: "Em Diagnóstico"). Se não achar, cai no fallback.
      if (locRow.status_interno) {
        const [[st]] = await db.query(
          `SELECT id_status FROM status_os WHERE descricao = ? LIMIT 1`,
          [locRow.status_interno]
        );
        if (st?.id_status) idStatusNum = Number(st.id_status);
      }
      if (!idStatusNum || Number.isNaN(idStatusNum)) {
        const fallback = MAP_LOCAL_TO_STATUS[idLocalStr];
        if (fallback) idStatusNum = fallback;
      }
    }

    if (!descricao_problema || !idLocalStr || !idStatusNum || Number.isNaN(idStatusNum)) {
      return res.status(400).json({ erro: 'Campos obrigatórios ausentes' });
    }

    const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const isBancadaDiag = (nomeLocal) => {
      const n = norm(nomeLocal);
      return (
        (n.includes('bancada') && (n.includes('orcamento') || n.includes('diagnostico'))) ||
        n.includes('area de diagnostico') ||
        n === 'diagnostico'
      );
    };

    const [[prevLocalRow]] = await db.query(
      `SELECT local_instalado FROM local WHERE id_scanner = ?`,
      [prev.id_local]
    );
    const [[newLocalRow]] = await db.query(
      `SELECT local_instalado FROM local WHERE id_scanner = ?`,
      [idLocalStr]
    );

    const prevOnBench = isBancadaDiag(prevLocalRow?.local_instalado);
    const newOnBench  = isBancadaDiag(newLocalRow?.local_instalado);

    const [updMain] = await db.query(
      `UPDATE ordenservico
          SET descricao_problema = ?,
              id_local          = ?,
              id_status_os      = ?,
              data_atualizacao  = NOW()
        WHERE id_os = ?`,
      [descricao_problema, idLocalStr, idStatusNum, id_ordem]
    );
    if (updMain.affectedRows === 0) {
      return res.status(404).json({ erro: 'Ordem não encontrada' });
    }

    const localChanged   = String(prev.id_local)     !== String(idLocalStr);
    const statusChanged  = Number(prev.id_status_os) !== Number(idStatusNum);

    const [[mapTo]] = await db.query(
      `SELECT status_interno FROM local WHERE id_scanner = ?`,
      [idLocalStr]
    );
    let mappedStatusId = null;
    if (mapTo?.status_interno) {
      const [[ms]] = await db.query(
        `SELECT id_status FROM status_os WHERE descricao = ? LIMIT 1`,
        [mapTo.status_interno]
      );
      if (ms?.id_status) mappedStatusId = Number(ms.id_status);
    }

    const [[oldStatusRow]] = await db.query(
      'SELECT descricao FROM status_os WHERE id_status = ?',
      [prev.id_status_os]
    );
    const [[newStatusRow]] = await db.query(
      'SELECT descricao FROM status_os WHERE id_status = ?',
      [idStatusNum]
    );
    const oldStatusLabel = oldStatusRow?.descricao || String(prev.id_status_os);
    const newStatusLabel = newStatusRow?.descricao || String(idStatusNum);

    const oldLocalLabel = prevLocalRow?.local_instalado || String(prev.id_local);
    const newLocalLabel = newLocalRow?.local_instalado || String(idLocalStr);

    const aggregateLocalAndStatus =
      localChanged &&
      statusChanged &&
      mappedStatusId !== null &&
      Number(idStatusNum) === mappedStatusId;

    if (aggregateLocalAndStatus) {
      await logAudit(db, {
        entityType: 'ordem',
        entityId: Number(id_ordem),
        action: 'local',
        field: 'id_local',
        oldValue: String(prev.id_local),
        newValue: String(idLocalStr),
        note: `Status (derivado): ${oldStatusLabel} → ${newStatusLabel}`,
        userId
      });
    } else {
      if (localChanged) {
        await logAudit(db, {
          entityType: 'ordem',
          entityId: Number(id_ordem),
          action: 'local',
          field: 'id_local',
          oldValue: String(prev.id_local),
          newValue: String(idLocalStr),
          note: `${oldLocalLabel} → ${newLocalLabel}`,
          userId
        });
      }
      if (statusChanged) {
        await logAudit(db, {
          entityType: 'ordem',
          entityId: Number(id_ordem),
          action: 'status',
          field: 'id_status_os',
          oldValue: String(prev.id_status_os),
          newValue: String(idStatusNum),
          note: `${oldStatusLabel} → ${newStatusLabel}`,
          userId
        });
      }
    }

    // TIMER — entrou na bancada
    if (!prevOnBench && newOnBench) {
      await db.query(
        `UPDATE ordenservico
            SET data_inicio_reparo = NOW(),
                data_fim_reparo    = NULL
          WHERE id_os = ?
            AND data_inicio_reparo IS NULL`,
        [id_ordem]
      );

      await logAudit(db, {
        entityType: 'ordem',
        entityId: Number(id_ordem),
        action: 'timer_start',
        note: `Entrou na bancada (${newLocalRow?.local_instalado || ''})`,
        userId
      });
    }

    // TIMER — saiu da bancada
    if (prevOnBench && !newOnBench) {
      const [[minsRow]] = await db.query(
        `SELECT IF(data_inicio_reparo IS NULL, NULL, TIMESTAMPDIFF(MINUTE, data_inicio_reparo, NOW())) AS minutos
          FROM ordenservico
          WHERE id_os = ?`,
        [id_ordem]
      );
      const minutos = Number(minsRow?.minutos || 0);

      await db.query(
        `UPDATE ordenservico
            SET data_fim_reparo = NOW(),
                tempo_servico   = COALESCE(tempo_servico, 0) +
                                  IF(data_inicio_reparo IS NULL, 0,
                                    GREATEST(0, TIMESTAMPDIFF(MINUTE, data_inicio_reparo, NOW()))),
                data_inicio_reparo = NULL
          WHERE id_os = ?
            AND data_inicio_reparo IS NOT NULL`,
        [id_ordem]
      );

      await logAudit(db, {
        entityType: 'ordem',
        entityId: Number(id_ordem),
        action: 'timer_stop',
        note: `Saiu da bancada (${prevLocalRow?.local_instalado || ''}) — +${minutos} min`,
        userId
      });
    }

    // 🔔 WhatsApp (Evolution API): se mudou de LOCAL, avisa o cliente (após todas as atualizações)
    if (localChanged) {
      try {
        const [[cli]] = await db.query(
          `SELECT c.nome, c.celular, c.telefone
             FROM cliente c
             JOIN ordenservico o ON o.id_cliente = c.id_cliente
            WHERE o.id_os = ?
            LIMIT 1`,
          [id_ordem]
        );

        await notifyLocalChange({
          osId: Number(id_ordem),
          localNome: newLocalRow?.local_instalado || String(idLocalStr),
          idScanner: String(idLocalStr),
          clienteNome: cli?.nome,
          phone: cli?.celular || cli?.telefone || null
        });
      } catch (e) {
        console.warn('[whats][put /:id] aviso falhou:', e.message);
      }
    }

    res.json({ mensagem: 'Ordem atualizada e timer tratado com sucesso' });
  } catch (err) {
    console.error('Erro ao atualizar ordem:', err);
    res.status(500).json({ erro: 'Erro interno ao atualizar ordem' });
  }
});

/**
 * Ativar (voltar para 'ativo')
 */
router.put('/ativar/:id', async (req, res) => {
  const { id } = req.params;
  const userId = Number(req.headers['x-user-id']) || null;

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ erro: 'ID inválido' });
  }

  try {
    const [upd] = await db.query(
      `UPDATE ordenservico
          SET status = 'ativo'
        WHERE id_os = ? AND status = 'inativo'`,
      [id]
    );

    if (upd.affectedRows === 0) {
      return res.status(404).json({ erro: 'Ordem não encontrada ou já está ativa.' });
    }

    await logAudit(db, {
      entityType: 'ordem',
      entityId: Number(id),
      action: 'reativou',
      field: 'status',
      oldValue: 'inativo',
      newValue: 'ativo',
      userId
    });

    res.json({ mensagem: 'Ordem ativada com sucesso' });
  } catch (err) {
    console.error('💥 Erro ao ativar ordem:', err);
    res.status(500).json({ erro: 'Erro interno ao ativar ordem' });
  }
});

/**
 * Inativar (soft delete) ordem: status -> 'inativo'
 */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const userId = Number(req.headers['x-user-id']) || null;

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ erro: 'ID inválido' });
  }

  try {
    const [upd] = await db.query(
      `UPDATE ordenservico SET status = 'inativo' WHERE id_os = ?`,
      [id]
    );
    if (upd.affectedRows === 0) {
      return res.status(404).json({ erro: 'Ordem não encontrada.' });
    }

    await logAudit(db, {
      entityType: 'ordem',
      entityId: Number(id),
      action: 'inativou',
      field: 'status',
      oldValue: 'ativo',
      newValue: 'inativo',
      userId
    });

    res.json({ mensagem: 'Ordem inativada com sucesso.' });
  } catch (err) {
    console.error('❌ Erro ao inativar ordem:', err);
    res.status(500).json({ erro: 'Erro interno ao inativar ordem.' });
  }
});

/**
 * Detalhes da ordem (inclui array de imagens com URL de visualização)
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ erro: 'ID inválido' });
  }

  const sql = `
    SELECT
      o.id_os,
      o.descricao_problema,
      o.descricao_servico,
      o.data_criacao,
      o.data_inicio_reparo,
      o.data_fim_reparo,
      o.tempo_servico,
      s.descricao AS status_os,
      c.nome AS nome_cliente,
      c.cpf  AS cpf_cliente,
      t.nome AS nome_tecnico,
      e.tipo,
      e.marca,
      e.modelo,
      e.numero_serie
    FROM ordenservico o
    JOIN cliente     c ON o.id_cliente     = c.id_cliente
    JOIN tecnico     t ON o.id_tecnico     = t.id_tecnico
    JOIN equipamento e ON o.id_equipamento = e.id_equipamento
    JOIN status_os   s ON o.id_status_os   = s.id_status
    WHERE o.id_os = ?
    LIMIT 1
  `;

  try {
    const [rows] = await db.query(sql, [id]);
    if (!rows.length) {
      return res.status(404).json({ erro: 'Ordem não encontrada' });
    }

    const [imgs] = await db.query(
      'SELECT id_imagem, original_name, mime, size, created_at FROM os_imagem WHERE id_os = ? ORDER BY id_imagem DESC',
      [id]
    );
    const imagens = imgs.map(r => ({
      ...r,
      url: `/api/ordens/imagens/blob/${r.id_imagem}`
    }));

    res.json({ ...rows[0], imagens });
  } catch (err) {
    console.error('❌ Erro ao buscar detalhes da ordem:', err);
    res.status(500).json({ erro: 'Erro interno ao buscar ordem' });
  }
});

module.exports = router;
