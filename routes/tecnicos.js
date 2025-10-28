// backend/routes/tecnicos.js
const express = require("express");
const router = express.Router();
const db = require("../db");

// 🔍 Listar técnicos ativos (com filtros opcionais nome/cpf)
router.get("/", async (req, res) => {
  try {
    const { nome = "", cpf = "" } = req.query;

    let sql = `
      SELECT 
        t.id_tecnico,
        t.nome,
        t.especializacao,
        t.telefone,
        t.status,
        u.id_usuario,
        u.cpf
      FROM tecnico t
      LEFT JOIN usuario u ON t.id_usuario = u.id_usuario
      WHERE t.status = 'ativo'
    `;
    const params = [];

    if (nome) {
      sql += ` AND t.nome LIKE ?`;
      params.push(`%${nome}%`);
    }
    if (cpf) {
      const onlyDigits = String(cpf).replace(/\D/g, "");
      sql += ` AND (
        REPLACE(REPLACE(REPLACE(u.cpf, '.', ''), '-', ''), ' ', '') LIKE ?
        OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(t.telefone, '(', ''), ')', ''), '-', ''), ' ', ''), '.', '') LIKE ?
      )`;
      params.push(`%${onlyDigits}%`, `%${onlyDigits}%`);
    }

    sql += ` ORDER BY t.nome ASC`;

    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("❌ Erro ao listar técnicos:", err);
    res.status(500).json({ erro: "Erro ao listar técnicos." });
  }
});

// 🔍 Listar técnicos inativos
router.get("/inativos", async (_req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        t.id_tecnico,
        t.nome,
        t.especializacao,
        t.telefone,
        t.status,
        u.id_usuario,
        u.cpf
      FROM tecnico t
      LEFT JOIN usuario u ON t.id_usuario = u.id_usuario
      WHERE t.status = 'inativo'
      ORDER BY t.nome ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error("❌ Erro ao listar técnicos inativos:", err);
    res.status(500).json({ erro: "Erro ao listar técnicos inativos." });
  }
});

// 🔎 Atribuições por técnico (OS ativas)
router.get("/atribuicoes", async (_req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        t.id_tecnico,
        t.nome                    AS nome_tecnico,
        t.telefone,
        o.id_os,
        c.nome                    AS nome_cliente,
        e.tipo,
        e.marca,
        e.modelo,
        e.numero_serie,
        s.descricao               AS status_os,
        o.data_criacao,
        o.data_inicio_reparo,
        o.data_fim_reparo,
        COALESCE(o.tempo_servico, 0) AS tempo_servico,
        (COALESCE(o.tempo_servico,0) +
         IF(o.data_inicio_reparo IS NULL, 0,
            TIMESTAMPDIFF(MINUTE, o.data_inicio_reparo, NOW())
         )
        ) AS minutos_total
      FROM ordenservico o
      JOIN tecnico     t ON o.id_tecnico     = t.id_tecnico
      JOIN cliente     c ON o.id_cliente     = c.id_cliente
      JOIN equipamento e ON o.id_equipamento = e.id_equipamento
      JOIN status_os   s ON o.id_status_os   = s.id_status
      WHERE o.status = 'ativo'
      ORDER BY t.nome, o.id_os DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("❌ Erro em /api/tecnicos/atribuicoes:", err);
    res.status(500).json({ erro: "Erro ao buscar atribuições dos técnicos." });
  }
});

// ➕ Cadastrar técnico
router.post("/", async (req, res) => {
  const { nome, especializacao, telefone, id_usuario } = req.body;

  if (!nome || !especializacao || !telefone || !id_usuario) {
    return res.status(400).json({ erro: "Todos os campos são obrigatórios." });
  }

  try {
    const [[u]] = await db.query(
      "SELECT id_usuario FROM usuario WHERE id_usuario = ? LIMIT 1",
      [id_usuario]
    );
    if (!u) return res.status(400).json({ erro: "Usuário vinculado não encontrado." });

    const [result] = await db.query(
      `INSERT INTO tecnico (nome, especializacao, telefone, status, id_usuario) 
       VALUES (?, ?, ?, 'ativo', ?)`,
      [nome, especializacao, telefone, id_usuario],
    );
    res.status(201).json({
      mensagem: "Técnico cadastrado com sucesso.",
      id_tecnico: result.insertId,
    });
  } catch (err) {
    console.error("❌ Erro ao cadastrar técnico:", err);
    res.status(500).json({ erro: "Erro ao cadastrar técnico." });
  }
});

// 📝 Atualizar técnico (update parcial) + opcional atualizar CPF do usuário vinculado
router.put("/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^\d+$/.test(id)) return res.status(400).json({ erro: "ID inválido" });

  const body = req.body || {};
  const nome           = (body.nome ?? "").toString().trim();
  const especializacao = (body.especializacao ?? "").toString().trim();
  const telefone       = (body.telefone ?? "").toString().trim();
  const cpf            = (body.cpf ?? "").toString().trim(); // opcional (na tabela usuario)

  if (![nome, especializacao, telefone, cpf].some(v => v.length)) {
    return res.status(400).json({ erro: "Nenhum campo para atualizar" });
  }

  try {
    const [[tec]] = await db.query(
      "SELECT id_tecnico, id_usuario FROM tecnico WHERE id_tecnico = ? LIMIT 1",
      [id]
    );
    if (!tec) return res.status(404).json({ erro: "Técnico não encontrado" });

    if (telefone && telefone.replace(/\D/g, "").length < 10) {
      return res.status(400).json({ erro: "Telefone inválido" });
    }
    if (cpf && !/^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/.test(cpf)) {
      return res.status(400).json({ erro: "CPF inválido" });
    }

    const sets = [];
    const vals = [];
    if (nome)           { sets.push("nome = ?"); vals.push(nome); }
    if (especializacao) { sets.push("especializacao = ?"); vals.push(especializacao); }
    if (telefone)       { sets.push("telefone = ?"); vals.push(telefone); }

    if (sets.length > 0) {
      const sql = `UPDATE tecnico SET ${sets.join(", ")} WHERE id_tecnico = ?`;
      vals.push(id);
      const [upd] = await db.query(sql, vals);
      if (upd.affectedRows === 0) {
        return res.status(404).json({ erro: "Técnico não encontrado" });
      }
    }

    if (cpf && tec.id_usuario) {
      await db.query("UPDATE usuario SET cpf = ? WHERE id_usuario = ?", [
        cpf,
        tec.id_usuario,
      ]);
    }

    return res.json({ mensagem: "Técnico atualizado com sucesso" });
  } catch (err) {
    console.error("💥 PUT /api/tecnicos/:id error:", {
      message: err?.message,
      code: err?.code,
      sqlState: err?.sqlState,
      errno: err?.errno,
    });
    return res.status(500).json({ erro: "Erro interno ao atualizar técnico" });
  }
});

// ❌ Inativar técnico
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ erro: "ID inválido" });

  try {
    const [result] = await db.query(
      `UPDATE tecnico SET status='inativo' WHERE id_tecnico=?`,
      [id],
    );
    if (!result.affectedRows)
      return res.status(404).json({ erro: "Técnico não encontrado." });
    res.json({ mensagem: "Técnico marcado como inativo." });
  } catch (err) {
    console.error("❌ Erro ao inativar técnico:", err);
    res.status(500).json({ erro: "Erro ao inativar técnico." });
  }
});

// ✅ Ativar técnico
router.put("/ativar/:id", async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ erro: "ID inválido" });

  try {
    const [r] = await db.query(
      'UPDATE tecnico SET status="ativo" WHERE id_tecnico=?',
      [id],
    );
    if (!r.affectedRows)
      return res.status(404).json({ erro: "Técnico não encontrado." });
    res.json({ mensagem: "Técnico ativado com sucesso." });
  } catch (err) {
    console.error("❌ Erro ao ativar técnico:", err);
    res.status(500).json({ erro: "Erro ao ativar técnico." });
  }
});

// 🔎 Detalhes do técnico (rota preferida p/ o front)
router.get("/:id/detalhes", async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.query(
      `
      SELECT 
        t.id_tecnico,
        t.nome,
        t.especializacao,
        t.telefone,
        t.status,
        u.id_usuario,
        u.cpf,
        NULL AS data_nascimento
      FROM tecnico t
      LEFT JOIN usuario u ON u.id_usuario = t.id_usuario
      WHERE t.id_tecnico = ?
      `,
      [id],
    );

    if (!rows.length)
      return res.status(404).json({ erro: "Técnico não encontrado." });
    res.json(rows[0]);
  } catch (err) {
    console.error("❌ Erro ao buscar técnico:", err);
    res.status(500).json({ erro: "Erro ao buscar técnico." });
  }
});

// 🔎 Compat: /api/tecnicos/:id (fallback)
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.query(
      `
      SELECT 
        t.id_tecnico,
        t.nome,
        t.especializacao,
        t.telefone,
        t.status,
        u.id_usuario,
        u.cpf,
        NULL AS data_nascimento
      FROM tecnico t
      LEFT JOIN usuario u ON u.id_usuario = t.id_usuario
      WHERE t.id_tecnico = ?
      `,
      [id],
    );

    if (!rows.length)
      return res.status(404).json({ erro: "Técnico não encontrado." });
    res.json(rows[0]);
  } catch (err) {
    console.error("❌ Erro ao buscar técnico:", err);
    res.status(500).json({ erro: "Erro ao buscar técnico." });
  }
});

module.exports = router;
