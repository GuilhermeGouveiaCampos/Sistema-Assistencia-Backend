// routes/ordens.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { logAudit } = require('../utils/audit');

console.log('🧩 routes/ordens.js carregado');

/**
 * Cadastro de ordem
 */
router.post('/', async (req, res) => {
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

  const sql = `
    INSERT INTO ordenservico (
      id_cliente, id_tecnico, id_equipamento, id_local, id_status_os,
      descricao_problema, descricao_servico, data_criacao,
      data_inicio_reparo, data_fim_reparo, tempo_servico, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ativo')
  `;

  try {
    const [result] = await db.query(sql, [
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

    // 📝 AUDIT
    const userId = Number(req.headers['x-user-id']) || null;
    const id_os = result.insertId;

    await logAudit(db, {
      entityType: 'ordem',
      entityId: id_os,
      action: 'criou',
      note: 'Cadastro de OS',
      userId
    });
    if (id_local) {
      await logAudit(db, {
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
      await logAudit(db, {
        entityType: 'ordem',
        entityId: id_os,
        action: 'status',
        field: 'id_status_os',
        oldValue: null,
        newValue: String(id_status_os),
        userId
      });
    }

    res.status(201).json({ mensagem: 'Ordem cadastrada com sucesso!' });
  } catch (err) {
    console.error('❌ Erro ao cadastrar ordem de serviço:', err);
    res.status(500).json({ erro: 'Erro ao cadastrar ordem de serviço.' });
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

/* ✅ AJUSTE RFID: retornar exatamente o que o front precisa */
router.get('/locais', async (_req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT
        l.id_scanner,
        l.local_instalado,
        COALESCE(l.status_interno, '') AS status_interno,
        (
          SELECT s.id_status
          FROM status_os s
          WHERE s.descricao = l.status_interno
          LIMIT 1
        ) AS id_status
      FROM local l
      WHERE l.status = 'ativo'
      ORDER BY l.local_instalado
      `
    );

    // Normaliza tipos para o front (string/número)
    const parsed = rows.map((r) => ({
      id_scanner: String(r.id_scanner || ''),
      local_instalado: String(r.local_instalado || ''),
      status_interno: String(r.status_interno || ''),
      id_status: Number(r.id_status || 0)
    }));

    res.json(parsed);
  } catch (err) {
    console.error('Erro ao buscar locais:', err);
    res.status(500).json({ erro: 'Erro ao buscar locais.' });
  }
});

/**
 * Técnico menos carregado (simples)
 */
router.get('/menos-carregados', async (_req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT t.id_tecnico, t.nome, COUNT(o.id_tecnico) AS total_os
      FROM tecnico t
      LEFT JOIN ordenservico o ON t.id_tecnico = o.id_tecnico
      GROUP BY t.id_tecnico
      ORDER BY total_os ASC
      LIMIT 1
    `);
  res.json(rows[0] || null);
  } catch (err) {
    console.error('Erro ao buscar técnico menos carregado:', err);
    res.status(500).json({ erro: 'Erro interno ao buscar técnico balanceado' });
  }
});

// 🔎 Histórico de auditoria da OS (com labels legíveis)
router.get('/:id/auditoria', async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ erro: 'ID inválido' });
  }

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

        /* valor ANTERIOR traduzido */
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

        /* valor NOVO traduzido */
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

/**
 * Atualizar ordem + controlar timer (diagnóstico/orçamento)
 */
router.put('/:id', async (req, res) => {
  const id_ordem = req.params.id;
  let { descricao_problema, id_local, id_status } = req.body || {};
  const userId = Number(req.headers['x-user-id']) || null;

  // validar id_os
  if (!/^\d+$/.test(String(id_ordem))) {
    return res.status(400).json({ erro: 'ID inválido' });
  }

  // id_local é STRING no schema (ex.: LOC001)
  const idLocalStr = String(id_local || '').trim();

  // tenta usar id_status do body; se vazio, resolvemos pelo local
  let idStatusNum = Number(id_status);

  try {
    // estado anterior
    const [prevRows] = await db.query(
      `SELECT id_local, id_status_os, descricao_problema, data_inicio_reparo, data_fim_reparo, tempo_servico
        FROM ordenservico
        WHERE id_os = ?`,
      [id_ordem]
    );
    if (!prevRows.length) return res.status(404).json({ erro: 'Ordem não encontrada' });
    const prev = prevRows[0];

    // se id_status não veio, mapeia pelo local escolhido (status_interno -> status_os.id_status)
    if (!idStatusNum || Number.isNaN(idStatusNum)) {
      const [[loc]] = await db.query(
        `SELECT status_interno, local_instalado
          FROM local
          WHERE id_scanner = ?`,
        [idLocalStr]
      );
      if (loc?.status_interno) {
        const [[st]] = await db.query(
          `SELECT id_status FROM status_os WHERE descricao = ? LIMIT 1`,
          [loc.status_interno]
        );
        if (st?.id_status) idStatusNum = Number(st.id_status);
      }
    }

    // validação final
    if (!descricao_problema || !idLocalStr || !idStatusNum || Number.isNaN(idStatusNum)) {
      return res.status(400).json({ erro: 'Campos obrigatórios ausentes' });
    }

    // helpers
    const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const isBancadaDiag = (nomeLocal) => {
      const n = norm(nomeLocal);
      return (
        (n.includes('bancada') && (n.includes('orcamento') || n.includes('diagnostico'))) ||
        n.includes('area de diagnostico') ||
        n === 'diagnostico'
      );
    };

    // nomes dos locais (antes/depois)
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

    // atualizar campos principais
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

    // ---------------- AUDITORIA (após o UPDATE principal) ----------------
    const localChanged   = String(prev.id_local)     !== String(idLocalStr);
    const statusChanged  = Number(prev.id_status_os) !== Number(idStatusNum);

    // Descobre qual seria o status mapeado para o NOVO local
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

    // Labels legíveis para status e local
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

    // ✅ Regra: mudou Local e o novo Status é exatamente o mapeado pelo novo Local?
    const aggregateLocalAndStatus =
      localChanged &&
      statusChanged &&
      mappedStatusId !== null &&
      Number(idStatusNum) === mappedStatusId;

    if (aggregateLocalAndStatus) {
      // 👉 Logue só UMA linha de "Local" (campo id_local)
      await logAudit(db, {
        entityType: 'ordem',
        entityId: Number(id_ordem),
        action: 'local',
        field: 'id_local',
        oldValue: String(prev.id_local),
        newValue: String(idLocalStr),
        // guarda observação do status derivado (se quiser ver depois no banco)
        note: `Status (derivado): ${oldStatusLabel} → ${newStatusLabel}`,
        userId
      });
    } else {
      // 👉 Caso contrário, registre separadamente o que mudou
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

    // TIMER — entrou na bancada: inicia ciclo se não estiver rodando
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

    // TIMER — saiu da bancada: registra minutos e encerra ciclo
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

    // 📝 AUDIT
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

    // 📝 AUDIT
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
 * Detalhes da ordem
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
      e.numero_serie,
      e.imagem
    FROM ordenservico o
    JOIN cliente     c ON o.id_cliente     = c.id_cliente
    JOIN tecnico     t ON o.id_tecnico     = t.id_tecnico
    JOIN equipamento e ON o.id_equipamento = e.id_equipamento
    JOIN status_os   s ON o.id_status_os   = s.id_status
    WHERE o.id_os = ?
  `;

  try {
    const [rows] = await db.query(sql, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ erro: 'Ordem não encontrada' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ Erro ao buscar detalhes da ordem:', err);
    res.status(500).json({ erro: 'Erro interno ao buscar ordem' });
  }
});

module.exports = router;
