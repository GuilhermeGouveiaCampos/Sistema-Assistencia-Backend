// routes/ordens.js
const express = require("express");
const router = express.Router();
const sharp = require("sharp");

const db = require("../db");
const { logAudit } = require("../utils/audit");
// const { notifyLocalChange } = require("../utils/whats"); // (desativado)

// Multer em memória (definido no middleware)
const { upload } = require("../middleware/upload");

console.log("🧩 routes/ordens.js carregado");

/**
 * Cadastro de ordem (suporta multipart com campo "imagens")
 * -> As imagens são comprimidas (JPEG) e salvas como BLOB no MySQL
 */
router.post("/", upload.array("imagens", 20), async (req, res) => {
  // 1) Normalização e coerção de tipos
  const id_cliente = Number(req.body.id_cliente);
  const id_tecnico = Number(req.body.id_tecnico);
  const id_equipamento = Number(req.body.id_equipamento);
  const id_local = String(req.body.id_local || "").trim(); // ex.: "LOC001"
  const id_status_os = Number(req.body.id_status_os);

  const descricao_problema = (req.body.descricao_problema || "").trim();
  const descricao_servico = (req.body.descricao_servico || "").trim() || null;

  // "YYYY-MM-DD" -> DATETIME vira "YYYY-MM-DD 00:00:00"
  const data_criacao = (req.body.data_criacao || "").trim() || null;
  const data_inicio_reparo = (req.body.data_inicio_reparo || "").trim() || null;
  const data_fim_reparo = (req.body.data_fim_reparo || "").trim() || null;

  const tempo_servico =
    req.body.tempo_servico != null ? Number(req.body.tempo_servico) : null;

  const files = req.files || [];
  const userId = Number(req.headers["x-user-id"]) || null;

  // 2) Validações de presença (falha com 400 — evita 500 genérico)
  const faltando = [];
  if (!id_cliente) faltando.push("id_cliente");
  if (!id_tecnico) faltando.push("id_tecnico");
  if (!id_equipamento) faltando.push("id_equipamento");
  if (!id_local) faltando.push("id_local");
  if (!id_status_os) faltando.push("id_status_os");
  if (!descricao_problema) faltando.push("descricao_problema");
  if (faltando.length) {
    return res
      .status(400)
      .json({ erro: `Campos obrigatórios ausentes: ${faltando.join(", ")}` });
  }

  // 3) Execução
  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    // 3.1) Checagem de FKs (garante que IDs existem)
    const [[okCli]] = await conn.query(
      "SELECT 1 ok FROM cliente WHERE id_cliente = ? AND status='ativo' LIMIT 1",
      [id_cliente],
    );
    const [[okTec]] = await conn.query(
      "SELECT 1 ok FROM tecnico WHERE id_tecnico = ? AND status='ativo' LIMIT 1",
      [id_tecnico],
    );
    const [[okEqp]] = await conn.query(
      "SELECT 1 ok FROM equipamento WHERE id_equipamento = ? LIMIT 1",
      [id_equipamento],
    );
    const [[okLoc]] = await conn.query(
      "SELECT 1 ok FROM local WHERE TRIM(id_scanner)=TRIM(?) AND TRIM(status)='ativo' LIMIT 1",
      [id_local],
    );
    const [[okSta]] = await conn.query(
      "SELECT 1 ok FROM status_os WHERE id_status = ? LIMIT 1",
      [id_status_os],
    );

    const faltantes = [];
    if (!okCli?.ok) faltantes.push("id_cliente (não encontrado/ativo)");
    if (!okTec?.ok) faltantes.push("id_tecnico (não encontrado/ativo)");
    if (!okEqp?.ok) faltantes.push("id_equipamento (não encontrado)");
    if (!okLoc?.ok) faltantes.push("id_local (scanner inválido/inativo)");
    if (!okSta?.ok) faltantes.push("id_status_os (não encontrado)");
    if (faltantes.length) {
      await conn.rollback();
      return res
        .status(400)
        .json({ erro: `Referências inválidas: ${faltantes.join(", ")}` });
    }

    // 3.2) Insert principal
    const sqlInsert = `
      INSERT INTO ordenservico (
        id_cliente, id_tecnico, id_equipamento, id_local, id_status_os,
        descricao_problema, descricao_servico, data_criacao,
        data_inicio_reparo, data_fim_reparo, tempo_servico, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ativo')
    `;

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
      tempo_servico,
    ]);

    const id_os = result.insertId;

    // 3.3) Audit
    await logAudit(conn, {
      entityType: "ordem",
      entityId: id_os,
      action: "criou",
      note: "Cadastro de OS",
      userId,
    });
    await logAudit(conn, {
      entityType: "ordem",
      entityId: id_os,
      action: "local",
      field: "id_local",
      oldValue: null,
      newValue: id_local,
      userId,
    });
    await logAudit(conn, {
      entityType: "ordem",
      entityId: id_os,
      action: "status",
      field: "id_status_os",
      oldValue: null,
      newValue: String(id_status_os),
      userId,
    });

    // 3.4) Imagens (se vierem no multipart)
    if (files.length > 0) {
      const rowsToInsert = [];
      for (const f of files) {
        let outBuf = f.buffer;
        let outMime = f.mimetype;
        try {
          const img = sharp(f.buffer).rotate();
          const meta = await img.metadata();
          if ((meta.width || 0) > 1600) img.resize({ width: 1600 });
          outBuf = await img.jpeg({ quality: 80 }).toBuffer();
          outMime = "image/jpeg";
        } catch {
          outBuf = f.buffer;
          outMime = f.mimetype || "application/octet-stream";
        }
        rowsToInsert.push([
          id_os,
          null,
          f.originalname || null,
          outMime,
          outBuf.length,
          outBuf,
        ]);
      }

      await conn.query(
        `INSERT INTO os_imagem (id_os, url, original_name, mime, size, data) VALUES ?`,
        [rowsToInsert],
      );

      await logAudit(conn, {
        entityType: "ordem",
        entityId: id_os,
        action: "imagem_add",
        note: `+${files.length} imagem(ns) (blob)`,
        userId,
      });
    }

    await conn.commit();
    return res
      .status(201)
      .json({ mensagem: "Ordem cadastrada com sucesso!", id_os });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error("❌ Erro ao cadastrar ordem de serviço:", {
      message: err?.message,
      code: err?.code,
      sqlState: err?.sqlState,
      errno: err?.errno,
    });
    return res
      .status(500)
      .json({ erro: "Erro ao cadastrar ordem de serviço." });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * Listas auxiliares (clientes/tecnicos/locais)
 */
router.get("/clientes", async (_req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id_cliente, nome, cpf FROM cliente WHERE status="ativo"',
    );
    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar clientes:", err);
    res.status(500).json({ erro: "Erro ao buscar clientes." });
  }
});

router.get("/tecnicos", async (_req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id_tecnico, nome, cpf FROM tecnico WHERE status="ativo"',
    );
    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar técnicos:", err);
    res.status(500).json({ erro: "Erro ao buscar técnicos." });
  }
});

/* ✅ Locais: lista APENAS ativos + mapeia id_status com fallback */
router.get("/locais", async (_req, res) => {
  try {
    const [locais] = await db.query(`
      SELECT 
        TRIM(id_scanner)      AS id_scanner,
        TRIM(local_instalado) AS local_instalado,
        TRIM(status_interno)  AS status_interno,
        TRIM(status)          AS status
      FROM local
      WHERE TRIM(status)='ativo'
      ORDER BY id_scanner
    `);

    // status_os (descricao -> id_status)
    const statusMap = new Map();
    try {
      const [sts] = await db.query(
        `SELECT id_status, TRIM(descricao) AS descricao FROM status_os`,
      );
      for (const s of sts)
        statusMap.set(String(s.descricao || ""), Number(s.id_status));
    } catch {}

    // Fallback por ID do local
    const MAP_LOCAL_TO_STATUS = {
      LOC_DIAG: 2, // Diagnóstico
      LOC001: 1, // Recebido
      LOC002: 2, // Em Diagnóstico
      LOC003: 3, // Aguardando Aprovação
      LOC004: 4, // Aguardando Peça
      LOC005: 5, // Em Reparo
      LOC006: 6, // Finalizado
      LOC007: 7, // Aguardando Retirada
      LOC008: 6, // Com Cliente → Finalizado (Entregue)
    };

    const vistos = new Set();
    const saida = [];

    for (const l of locais) {
      const key = String(l.id_scanner || "").trim();
      if (!key || vistos.has(key)) continue;
      vistos.add(key);

      const desc = String(l.status_interno || "").trim();
      const id_status = statusMap.has(desc)
        ? statusMap.get(desc)
        : MAP_LOCAL_TO_STATUS[key] || 0;

      saida.push({
        id_local: key,
        id_scanner: key,
        local_instalado: String(l.local_instalado || "").trim(),
        status_interno: desc,
        id_status: Number(id_status || 0),
        status: "ativo",
      });
    }

    console.log(`[ordens/locais] retornando ${saida.length} locais ativos`);
    res.json(saida);
  } catch (err) {
    console.error("GET /api/ordens/locais error:", err);
    res.status(500).json({ erro: "Falha ao listar locais" });
  }
});

/* 🔎 Histórico de auditoria da OS (com labels legíveis) */
router.get("/:id/auditoria", async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ erro: "ID inválido" });

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
      [id],
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ Erro ao buscar auditoria da OS:", err);
    res.status(500).json({ erro: "Erro ao buscar auditoria." });
  }
});

/* ================== Imagens da OS ================== */

// Stream do binário (BLOB) da imagem
router.get("/imagens/blob/:id_img", async (req, res) => {
  const { id_img } = req.params;
  if (!/^\d+$/.test(id_img)) return res.status(400).send("ID inválido");

  try {
    const [[img]] = await db.query(
      "SELECT data, mime FROM os_imagem WHERE id_imagem = ?",
      [id_img],
    );
    if (!img || !img.data) return res.status(404).send("Imagem não encontrada");

    res.setHeader("Content-Type", img.mime || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(img.data);
  } catch (e) {
    console.error("GET /imagens/blob/:id_img error:", e);
    res.status(500).send("Erro ao carregar imagem");
  }
});

// Lista imagens da OS (com URL virtual para o blob)
router.get("/:id/imagens", async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ erro: "ID inválido" });

  try {
    const [rows] = await db.query(
      "SELECT id_imagem, original_name, mime, size, created_at FROM os_imagem WHERE id_os = ? ORDER BY id_imagem DESC",
      [id],
    );

    const imagens = rows.map((r) => ({
      ...r,
      url: `/api/ordens/imagens/blob/${r.id_imagem}`, // front usa esta URL
    }));

    res.json(imagens);
  } catch (err) {
    console.error("❌ Erro ao listar imagens:", err);
    res.status(500).json({ erro: "Erro ao listar imagens." });
  }
});

// Deleta 1 imagem da OS (apenas banco)
router.delete("/:id/imagens/:id_img", async (req, res) => {
  const { id, id_img } = req.params;
  const userId = Number(req.headers["x-user-id"]) || null;

  if (!/^\d+$/.test(id) || !/^\d+$/.test(id_img)) {
    return res.status(400).json({ erro: "ID inválido" });
  }

  try {
    const [[img]] = await db.query(
      "SELECT original_name FROM os_imagem WHERE id_imagem = ? AND id_os = ?",
      [id_img, id],
    );
    if (!img) return res.status(404).json({ erro: "Imagem não encontrada." });

    await db.query("DELETE FROM os_imagem WHERE id_imagem = ?", [id_img]);

    await logAudit(db, {
      entityType: "ordem",
      entityId: Number(id),
      action: "imagem_del",
      note: `Removeu imagem ${img.original_name || id_img}`,
      userId,
    });

    res.json({ mensagem: "Imagem removida com sucesso." });
  } catch (err) {
    console.error("❌ Erro ao remover imagem:", err);
    res.status(500).json({ erro: "Erro ao remover imagem." });
  }
});

/**
 * Atualizar ordem (tolerante a campos faltando) + auditoria
 */
router.put("/:id", async (req, res) => {
  const id_ordem = String(req.params.id || "").trim();
  if (!/^\d+$/.test(id_ordem)) return res.status(400).json({ erro: "ID inválido" });

  // Aceita ambos os nomes vindos do front
  const body = req.body || {};
  const descricao_problema = (body.descricao_problema ?? "").toString().trim();
  const descricao_servico = (body.descricao_servico ?? "").toString().trim() || null;
  const idLocalStrRaw = (body.id_local ?? "").toString().trim();
  // o front às vezes manda id_status_os; outras, id_status
  let idStatusNum = Number(body.id_status_os ?? body.id_status);

  const userId = Number(req.headers["x-user-id"]) || null;

  let conn;
  try {
    conn = await db.getConnection();

    // 1) Registro anterior  (🆕 agora traz também datas e tempo)
    const [prevRows] = await conn.query(
      `SELECT id_local,
              id_status_os,
              descricao_problema,
              data_inicio_reparo,
              data_fim_reparo,
              tempo_servico,
              data_criacao
         FROM ordenservico
        WHERE id_os = ?`,
      [id_ordem],
    );
    if (!prevRows.length) return res.status(404).json({ erro: "Ordem não encontrada" });

    const prev = prevRows[0];
    const idLocalStr = idLocalStrRaw || String(prev.id_local || "").trim();

    // 2) Validar local ativo (se informado ou herdado)
    const [[locRow]] = await conn.query(
      `SELECT TRIM(id_scanner) AS id_scanner,
              TRIM(local_instalado) AS local_instalado,
              TRIM(status_interno)  AS status_interno,
              TRIM(status)          AS status
         FROM local
        WHERE TRIM(id_scanner) = TRIM(?)
        LIMIT 1`,
      [idLocalStr],
    );
    if (!locRow || locRow.status !== "ativo") {
      return res.status(400).json({ erro: "Local inválido ou inativo" });
    }

    // 3) Resolver status: prioridade (a) enviado, (b) mapeado pelo local, (c) manter anterior
    if (!idStatusNum || Number.isNaN(idStatusNum)) {
      const [[stByDesc]] = await conn.query(
        `SELECT id_status FROM status_os WHERE descricao = ? LIMIT 1`,
        [locRow.status_interno],
      );
      if (stByDesc?.id_status) idStatusNum = Number(stByDesc.id_status);
    }
    if (!idStatusNum || Number.isNaN(idStatusNum)) {
      idStatusNum = Number(prev.id_status_os);
    }

    // 4) Se vier string vazia de descrição, mantém a antiga (evita 400)
    const descProblemaToSave =
      descricao_problema.length
        ? descricao_problema
        : String(prev.descricao_problema || "");

    /* ========= 🔥 NOVO: lógica de datas/tempo por status ========= */

    // Descobrimos a descrição do novo status
    const [[newStatusRow]] = await conn.query(
      `SELECT descricao FROM status_os WHERE id_status = ? LIMIT 1`,
      [idStatusNum],
    );
    const newStatusDesc = (newStatusRow?.descricao || "").trim();

    const agora = new Date();

    // Começamos com os valores atuais
    let dataInicioReparo = prev.data_inicio_reparo || null;
    let dataFimReparo = prev.data_fim_reparo || null;
    let tempoServico =
      prev.tempo_servico != null ? Number(prev.tempo_servico) : null;

    // Se status virou "Em Diagnóstico" e ainda não tinha início, marca agora
    if (["Em Diagnóstico", "Em Diagnostico"].includes(newStatusDesc)) {
      if (!dataInicioReparo) {
        dataInicioReparo = agora;
      }
    }

    // Se status virou "Finalizado" ou "Cancelado", fecha o reparo e calcula tempo
    if (["Finalizado", "Cancelado"].includes(newStatusDesc)) {
      dataFimReparo = agora;

      const baseStr = dataInicioReparo || prev.data_criacao;
      if (baseStr) {
        const baseDate = new Date(baseStr);
        const diffMs = agora.getTime() - baseDate.getTime();
        const diffMin = Math.max(0, Math.round(diffMs / 60000));
        tempoServico = diffMin;
      }
    }

    /* ======== FIM NOVO bloco de datas/tempo ======== */

    // 5) Atualizar (🆕 adicionamos data_inicio_reparo, data_fim_reparo, tempo_servico)
    const [upd] = await conn.query(
      `UPDATE ordenservico
          SET descricao_problema = ?,
              descricao_servico  = COALESCE(?, descricao_servico),
              id_local           = ?,
              id_status_os       = ?,
              data_atualizacao   = NOW(),
              data_inicio_reparo = ?,
              data_fim_reparo    = ?,
              tempo_servico      = ?
        WHERE id_os = ?`,
      [
        descProblemaToSave,
        descricao_servico,
        idLocalStr,
        idStatusNum,
        dataInicioReparo,
        dataFimReparo,
        tempoServico,
        id_ordem,
      ],
    );

    if (upd.affectedRows === 0) {
      return res.status(404).json({ erro: "Ordem não encontrada" });
    }

    // 6) Auditoria (somente quando mudou)
    const localChanged = String(prev.id_local) !== String(idLocalStr);
    const statusChanged = Number(prev.id_status_os) !== Number(idStatusNum);

    if (localChanged) {
      await logAudit(db, {
        entityType: "ordem",
        entityId: Number(id_ordem),
        action: "local",
        field: "id_local",
        oldValue: String(prev.id_local),
        newValue: String(idLocalStr),
        userId,
      });
    }
    if (statusChanged) {
      await logAudit(db, {
        entityType: "ordem",
        entityId: Number(id_ordem),
        action: "status",
        field: "id_status_os",
        oldValue: String(prev.id_status_os),
        newValue: String(idStatusNum),
        userId,
      });
    }

    return res.json({ mensagem: "Ordem atualizada com sucesso" });
  } catch (err) {
    console.error("💥 PUT /api/ordens/:id erro:", {
      message: err?.message,
      code: err?.code,
      sqlState: err?.sqlState,
      errno: err?.errno,
    });
    return res.status(500).json({ erro: "Erro interno ao atualizar ordem" });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * Ativar (voltar para 'ativo')
 */
router.put("/ativar/:id", async (req, res) => {
  const { id } = req.params;
  const userId = Number(req.headers["x-user-id"]) || null;

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ erro: "ID inválido" });
  }

  try {
    const [upd] = await db.query(
      `UPDATE ordenservico
          SET status='ativo'
        WHERE id_os=? AND status='inativo'`,
      [id],
    );

    if (upd.affectedRows === 0) {
      return res
        .status(404)
        .json({ erro: "Ordem não encontrada ou já está ativa." });
    }

    await logAudit(db, {
      entityType: "ordem",
      entityId: Number(id),
      action: "reativou",
      field: "status",
      oldValue: "inativo",
      newValue: "ativo",
      userId,
    });

    res.json({ mensagem: "Ordem ativada com sucesso" });
  } catch (err) {
    console.error("💥 Erro ao ativar ordem:", err);
    res.status(500).json({ erro: "Erro interno ao ativar ordem" });
  }
});

/**
 * Inativar (soft delete) ordem: status -> 'inativo'
 */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const userId = Number(req.headers["x-user-id"]) || null;

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ erro: "ID inválido" });
  }

  try {
    const [upd] = await db.query(
      `UPDATE ordenservico SET status='inativo' WHERE id_os=?`,
      [id],
    );
    if (upd.affectedRows === 0) {
      return res.status(404).json({ erro: "Ordem não encontrada." });
    }

    await logAudit(db, {
      entityType: "ordem",
      entityId: Number(id),
      action: "inativou",
      field: "status",
      oldValue: "ativo",
      newValue: "inativo",
      userId,
    });

    res.json({ mensagem: "Ordem inativada com sucesso." });
  } catch (err) {
    console.error("❌ Erro ao inativar ordem:", err);
    res.status(500).json({ erro: "Erro interno ao inativar ordem." });
  }
});

/**
 * Detalhes da ordem (inclui array de imagens com URL de visualização)
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ erro: "ID inválido" });
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
      return res.status(404).json({ erro: "Ordem não encontrada" });
    }

    const [imgs] = await db.query(
      "SELECT id_imagem, original_name, mime, size, created_at FROM os_imagem WHERE id_os = ? ORDER BY id_imagem DESC",
      [id],
    );
    const imagens = imgs.map((r) => ({
      ...r,
      url: `/api/ordens/imagens/blob/${r.id_imagem}`,
    }));

    res.json({ ...rows[0], imagens });
  } catch (err) {
    console.error("❌ Erro ao buscar detalhes da ordem:", err);
    res.status(500).json({ erro: "Erro interno ao buscar ordem" });
  }
});

module.exports = router;
