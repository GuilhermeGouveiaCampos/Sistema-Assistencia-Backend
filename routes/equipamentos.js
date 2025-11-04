// routes/equipamentos.js
const path = require("path");
const fs = require("fs");

const express = require("express");
const router = express.Router();
const multer = require("multer");

/* ===== Upload (para POST/PUT com imagens) ===== */
/* ***** INÍCIO – TRECHO ALTERADO (UPLOAD IMAGENS) ***** */
/**
 * Queremos usar a MESMA pasta base que o server.js expõe em /uploads.
 *
 * No server.js (resumido) está assim:
 *   const uploadsRoot = process.env.UPLOAD_DIR
 *     ? path.resolve(process.env.UPLOAD_DIR)   // ex: /data/uploads/os
 *     : path.join(__dirname, "uploads", "os");
 *   const uploadsBase = path.dirname(uploadsRoot);     // ex: /data/uploads
 *   app.use("/uploads", express.static(uploadsBase));
 *
 * Então:
 *   - Em produção, com UPLOAD_DIR=/data/uploads/os → usamos /data/uploads
 *   - Em dev, continuamos usando ../uploads (backend/uploads)
 */
const uploadDir = process.env.UPLOAD_DIR
  ? path.dirname(path.resolve(process.env.UPLOAD_DIR)) // ex.: /data/uploads
  : path.join(__dirname, "../uploads");                // ex.: backend/uploads

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) =>
    cb(null, Date.now() + path.extname(file.originalname)),
});

const upload = multer({ storage });
/* ***** FIM – TRECHO ALTERADO (UPLOAD IMAGENS) ***** */

/* ===== Helpers ===== */
function getColumns(db, table, cols, cb) {
  try {
    if (!Array.isArray(cols) || cols.length === 0) return cb(new Set());
    const inList = cols.map(() => "?").join(",");
    const sql = `SHOW COLUMNS FROM ${table} WHERE Field IN (${inList})`;
    db.query(sql, cols, (err, rows) => {
      if (err) {
        console.error(
          `⛔ Erro ao checar colunas de ${table}:`,
          err?.sqlMessage || err,
        );
        return cb(new Set());
      }
      cb(new Set((rows || []).map((r) => r.Field)));
    });
  } catch (e) {
    console.error("⛔ Exceção getColumns:", e);
    cb(new Set());
  }
}

/* ===== GET /api/equipamentos?tipo=&nome_cliente=&modelo= ===== */
router.get("/", (req, res) => {
  const db = req.app.get("db");
  const { tipo = "", nome_cliente = "", modelo = "" } = req.query || {};

  getColumns(
    db,
    "equipamento",
    [
      "status",
      "tipo",
      "marca",
      "modelo",
      "numero_serie",
      "imagem",
      "id_cliente",
      "id_equipamento",
    ],
    (eqCols) => {
      getColumns(db, "cliente", ["id_cliente", "nome"], (clCols) => {
        const selectParts = ["e.id_equipamento"];
        if (eqCols.has("tipo")) selectParts.push("e.tipo");
        if (eqCols.has("marca")) selectParts.push("e.marca");
        if (eqCols.has("modelo")) selectParts.push("e.modelo");
        if (eqCols.has("numero_serie")) selectParts.push("e.numero_serie");
        if (eqCols.has("imagem")) selectParts.push("e.imagem");
        if (eqCols.has("status")) selectParts.push("e.status");

        const where = [];
        const params = [];

        if (eqCols.has("status")) where.push("e.status = 'ativo'");
        if (tipo && eqCols.has("tipo")) {
          where.push("e.tipo LIKE ?");
          params.push(`%${tipo}%`);
        }
        if (modelo && eqCols.has("modelo")) {
          where.push("e.modelo LIKE ?");
          params.push(`%${modelo}%`);
        }

        // Preferimos JOIN; se não der, usamos subconsulta para nome_cliente
        const canJoin = eqCols.has("id_cliente") && clCols.has("id_cliente");
        let joinClause = "";
        if (canJoin) {
          joinClause = "JOIN cliente c ON e.id_cliente = c.id_cliente";
          if (clCols.has("nome")) selectParts.push("c.nome AS nome_cliente");
          if (nome_cliente && clCols.has("nome")) {
            where.push("c.nome LIKE ?");
            params.push(`%${nome_cliente}%`);
          }
        } else if (clCols.has("nome") && eqCols.has("id_cliente")) {
          // fallback sem JOIN
          selectParts.push(
            "(SELECT nome FROM cliente WHERE cliente.id_cliente = e.id_cliente) AS nome_cliente",
          );
          if (nome_cliente) {
            where.push(
              "(SELECT nome FROM cliente WHERE cliente.id_cliente = e.id_cliente) LIKE ?",
            );
            params.push(`%${nome_cliente}%`);
          }
        }

        const sql = `
          SELECT ${selectParts.join(", ")}
          FROM equipamento e
          ${joinClause}
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY e.id_equipamento DESC
        `;

        db.query(sql, params, (err, rows) => {
          if (err) {
            console.error(
              "⛔ Erro DB GET /api/equipamentos:",
              err?.sqlMessage || err,
              "\nSQL:",
              sql,
              "\nParams:",
              params,
            );
            return res
              .status(500)
              .json({ erro: "Erro ao buscar equipamentos." });
          }
          res.json(rows || []);
        });
      });
    },
  );
});

/* ===== DELETE lógico/físico ===== */
router.delete("/:id", (req, res) => {
  const db = req.app.get("db");
  const id = Number(req.params.id);
  if (!Number.isInteger(id))
    return res.status(400).json({ erro: "ID inválido." });

  getColumns(db, "equipamento", ["status"], (eqCols) => {
    const sql = eqCols.has("status")
      ? "UPDATE equipamento SET status = 'inativo' WHERE id_equipamento = ?"
      : "DELETE FROM equipamento WHERE id_equipamento = ?";
    db.query(sql, [id], (err, result) => {
      if (err) {
        console.error(
          "⛔ Erro DB DELETE /api/equipamentos:",
          err?.sqlMessage || err,
        );
        return res
          .status(500)
          .json({ erro: "Erro ao inativar/excluir equipamento." });
      }
      if (!result || result.affectedRows === 0)
        return res.status(404).json({ erro: "Equipamento não encontrado." });
      res.json({
        ok: true,
        affectedRows: result.affectedRows || 0,
        soft: eqCols.has("status"),
      });
    });
  });
});

/* ===== GET /api/equipamentos/inativos ===== */
router.get("/inativos", (req, res) => {
  const db = req.app.get("db");
  getColumns(
    db,
    "equipamento",
    ["status", "id_equipamento", "tipo", "modelo", "id_cliente"],
    (eqCols) => {
      getColumns(db, "cliente", ["id_cliente", "nome"], (clCols) => {
        if (!eqCols.has("status")) return res.json([]);

        const parts = ["e.id_equipamento"];
        if (eqCols.has("tipo")) parts.push("e.tipo");
        if (eqCols.has("modelo")) parts.push("e.modelo");

        const canJoin = eqCols.has("id_cliente") && clCols.has("id_cliente");
        const join = canJoin
          ? "JOIN cliente c ON e.id_cliente = c.id_cliente"
          : "";
        if (canJoin && clCols.has("nome")) parts.push("c.nome AS nome_cliente");
        else if (clCols.has("nome") && eqCols.has("id_cliente")) {
          parts.push(
            "(SELECT nome FROM cliente WHERE cliente.id_cliente = e.id_cliente) AS nome_cliente",
          );
        }

        const sql = `
        SELECT ${parts.join(", ")}
        FROM equipamento e
        ${join}
        WHERE e.status = 'inativo'
        ORDER BY e.id_equipamento DESC
      `;
        db.query(sql, [], (err, rows) => {
          if (err) {
            console.error(
              "⛔ Erro DB GET /api/equipamentos/inativos:",
              err?.sqlMessage || err,
              "\nSQL:",
              sql,
            );
            return res
              .status(500)
              .json({ erro: "Erro ao buscar equipamentos inativos." });
          }
          res.json(rows || []);
        });
      });
    },
  );
});

/* ===== PUT /ativar/:id ===== */
router.put("/ativar/:id", (req, res) => {
  const db = req.app.get("db");
  const id = Number(req.params.id);
  if (!Number.isInteger(id))
    return res.status(400).json({ erro: "ID inválido." });

  getColumns(db, "equipamento", ["status"], (eqCols) => {
    if (!eqCols.has("status"))
      return res.status(400).json({ erro: 'Coluna "status" não existe.' });
    db.query(
      "UPDATE equipamento SET status = 'ativo' WHERE id_equipamento = ?",
      [id],
      (err, result) => {
        if (err) {
          console.error(
            "⛔ Erro DB PUT /api/equipamentos/ativar:",
            err?.sqlMessage || err,
          );
          return res.status(500).json({ erro: "Erro ao ativar equipamento." });
        }
        res.json({ ok: true, affectedRows: result?.affectedRows || 0 });
      },
    );
  });
});

/* ===== POST / (com upload) ===== */
router.post("/", upload.array("imagens", 20), (req, res) => {
  const db = req.app.get("db");
  const body = req.body || {};
  const files = Array.isArray(req.files) ? req.files : [];
  const nomesImagens = files.map((f) => f.filename);
  const imagensCSV = nomesImagens.join(",");

  getColumns(
    db,
    "equipamento",
    [
      "status",
      "tipo",
      "marca",
      "modelo",
      "numero_serie",
      "imagem",
      "id_cliente",
    ],
    (eqCols) => {
      const obrig = [
        "id_cliente",
        "tipo",
        "marca",
        "modelo",
        "numero_serie",
      ].filter((c) => eqCols.has(c));
      for (const c of obrig)
        if (!body[c])
          return res
            .status(400)
            .json({ erro: `Campo obrigatório ausente: ${c}` });

      const cols = [];
      const qms = [];
      const vals = [];

      for (const c of [
        "id_cliente",
        "tipo",
        "marca",
        "modelo",
        "numero_serie",
      ]) {
        if (eqCols.has(c) && body[c] !== null && body[c] !== undefined) {
          cols.push(c);
          qms.push("?");
          vals.push(body[c]);
        }
      }
      if (eqCols.has("imagem")) {
        cols.push("imagem");
        qms.push("?");
        vals.push(imagensCSV);
      }
      if (eqCols.has("status")) {
        cols.push("status");
        qms.push("?");
        vals.push(body.status || "ativo");
      }

      const sql = `INSERT INTO equipamento (${cols.join(", ")}) VALUES (${qms.join(", ")})`;
      db.query(sql, vals, (err, result) => {
        if (err) {
          console.error(
            "⛔ Erro DB POST /api/equipamentos:",
            err?.sqlMessage || err,
            "\nSQL:",
            sql,
            "\nVals:",
            vals,
          );
          return res
            .status(500)
            .json({ erro: "Erro ao cadastrar equipamento." });
        }
        res.status(201).json({
          mensagem: "Equipamento cadastrado com sucesso.",
          id_equipamento: result.insertId,
          imagens: nomesImagens,
        });
      });
    },
  );
});

/* ===== GET /api/equipamentos/por-cliente/:id ===== */
router.get("/por-cliente/:id", (req, res) => {
  const db = req.app.get("db");
  const id = Number(req.params.id);
  if (!Number.isInteger(id))
    return res.status(400).json({ erro: "ID inválido." });

  db.query(
    `SELECT id_equipamento, tipo, marca, modelo, numero_serie
     FROM equipamento
     WHERE id_cliente = ? AND status = 'ativo'
     ORDER BY id_equipamento DESC`,
    [id],
    (err, rows) => {
      if (err) {
        console.error(
          "⛔ Erro DB GET /api/equipamentos/por-cliente/:id:",
          err?.sqlMessage || err,
        );
        return res
          .status(500)
          .json({ erro: "Erro ao buscar equipamentos do cliente." });
      }
      res.json(rows || []);
    },
  );
});

/* ===== GET /:id (detalhe) ===== */
router.get("/:id", (req, res) => {
  const db = req.app.get("db");
  const id = Number(req.params.id);
  if (!Number.isInteger(id))
    return res.status(400).json({ erro: "ID inválido." });

  getColumns(
    db,
    "equipamento",
    [
      "tipo",
      "marca",
      "modelo",
      "numero_serie",
      "imagem",
      "id_cliente",
      "status",
    ],
    (eqCols) => {
      getColumns(db, "cliente", ["id_cliente", "nome", "cpf"], (clCols) => {
        const parts = ["e.id_equipamento"];
        for (const c of [
          "tipo",
          "marca",
          "modelo",
          "numero_serie",
          "imagem",
          "status",
        ]) {
          if (eqCols.has(c)) parts.push(`e.${c}`);
        }

        const canJoin = eqCols.has("id_cliente") && clCols.has("id_cliente");
        let join = "";
        if (canJoin) {
          join = "JOIN cliente c ON e.id_cliente = c.id_cliente";
          if (clCols.has("nome")) parts.push("c.nome AS nome_cliente");
          if (clCols.has("cpf")) parts.push("c.cpf");
        } else if (clCols.has("nome") && eqCols.has("id_cliente")) {
          parts.push(
            "(SELECT nome FROM cliente WHERE cliente.id_cliente = e.id_cliente) AS nome_cliente",
          );
        }

        const sql = `
        SELECT ${parts.join(", ")}
        FROM equipamento e
        ${join}
        WHERE e.id_equipamento = ?
        LIMIT 1
      `;
        db.query(sql, [id], (err, rows) => {
          if (err) {
            console.error(
              "⛔ Erro DB GET /api/equipamentos/:id:",
              err?.sqlMessage || err,
              "\nSQL:",
              sql,
              "\nParam:",
              id,
            );
            return res
              .status(500)
              .json({ erro: "Erro ao buscar equipamento." });
          }
          if (!rows || rows.length === 0)
            return res
              .status(404)
              .json({ erro: "Equipamento não encontrado." });
          res.json(rows[0]);
        });
      });
    },
  );
});

/* ===== PUT /:id (atualiza + imagens) ===== */
router.put("/:id", upload.array("imagens", 20), (req, res) => {
  const db = req.app.get("db");
  const id = Number(req.params.id);
  if (!Number.isInteger(id))
    return res.status(400).json({ erro: "ID inválido." });

  const body = req.body || {};
  const novas = Array.isArray(req.files)
    ? req.files.map((f) => f.filename)
    : [];

  getColumns(
    db,
    "equipamento",
    ["tipo", "marca", "modelo", "numero_serie", "imagem"],
    (eqCols) => {
      db.query(
        "SELECT imagem FROM equipamento WHERE id_equipamento = ?",
        [id],
        (err, rows) => {
          if (err) {
            console.error(
              "⛔ Erro DB SELECT imagens atuais:",
              err?.sqlMessage || err,
            );
            return res
              .status(500)
              .json({ erro: "Erro ao atualizar equipamento." });
          }
          const antigas = (
            rows && rows[0] && rows[0].imagem
              ? String(rows[0].imagem).split(",")
              : []
          ).filter(Boolean);
          const mantidas = (
            body.imagem ? String(body.imagem).split(",") : []
          ).filter(Boolean);

          const remover = antigas.filter((n) => !mantidas.includes(n));
          for (const n of remover) {
            const p = path.join(uploadDir, n);
            if (fs.existsSync(p)) {
              try {
                fs.unlinkSync(p);
              } catch (e) {
                // noop: falha ao remover arquivo antigo
              }
            }
          }

          const todas = [...mantidas, ...novas].filter(Boolean);

          const sets = [];
          const vals = [];
          for (const c of ["tipo", "marca", "modelo", "numero_serie"]) {
            if (eqCols.has(c) && body[c] !== null && body[c] !== undefined) {
              sets.push(`${c} = ?`);
              vals.push(body[c]);
            }
          }
          if (eqCols.has("imagem")) {
            sets.push("imagem = ?");
            vals.push(todas.join(","));
          }
          sets.push("id_equipamento = id_equipamento"); // garante SQL válido mesmo sem campos

          const sql = `UPDATE equipamento SET ${sets.join(", ")} WHERE id_equipamento = ?`;
          vals.push(id);

          db.query(sql, vals, (err2) => {
            if (err2) {
              console.error(
                "⛔ Erro DB UPDATE /api/equipamentos/:id:",
                err2?.sqlMessage || err2,
                "\nSQL:",
                sql,
                "\nVals:",
                vals,
              );
              return res
                .status(500)
                .json({ erro: "Erro ao atualizar equipamento." });
            }
            res.json({
              mensagem: "Equipamento atualizado com sucesso.",
              imagens: todas,
            });
          });
        },
      );
    },
  );
});

module.exports = router;
