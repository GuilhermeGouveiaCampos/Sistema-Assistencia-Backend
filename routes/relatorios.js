// routes/relatorios.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const PDFDocument = require("pdfkit");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const tz = require("dayjs/plugin/timezone");
dayjs.extend(utc);
dayjs.extend(tz);

// timezone do Brasil
const TZ = "America/Sao_Paulo";

/**
 * GET /api/relatorios/os
 * Query params:
 *  - status: ids separados por vírgula (ex: "2,6") OU "all"
 *  - tecnico: ids separados por vírgula (ex: "1,3") OU "all"
 *  - from: YYYY-MM-DD (opcional)
 *  - to:   YYYY-MM-DD (opcional)
 *
 * Observação: o "prazo (de-até)" filtra por data_atualizacao (pode trocar para data_criacao, se preferir).
 */
router.get("/os", async (req, res) => {
  try {
    const { status = "all", tecnico = "all", from = "", to = "" } = req.query;

    // Monta filtros dinamicamente
    const where = ["os.status = 'ativo'"];
    const params = [];

    // status (id_status_os)
    if (String(status).toLowerCase() !== "all") {
      const ids = String(status)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s));
      if (ids.length) {
        where.push(`os.id_status_os IN (${ids.map(() => "?").join(",")})`);
        params.push(...ids.map(Number));
      }
    }

    // técnico (id_tecnico)
    if (String(tecnico).toLowerCase() !== "all") {
      const ids = String(tecnico)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s));
      if (ids.length) {
        where.push(`os.id_tecnico IN (${ids.map(() => "?").join(",")})`);
        params.push(...ids.map(Number));
      }
    }

    // período (data_atualizacao) — inclua o término do dia em "to"
    if (from) {
      where.push(`DATE(os.data_atualizacao) >= ?`);
      params.push(from);
    }
    if (to) {
      where.push(`DATE(os.data_atualizacao) <= ?`);
      params.push(to);
    }

    const sql = `
      SELECT
        os.id_os,
        COALESCE(c.nome, CONCAT('Cliente #', os.id_cliente)) AS cliente,
        t.nome AS tecnico,
        s.descricao AS status,
        os.data_criacao,
        os.data_atualizacao
      FROM ordenservico os
      LEFT JOIN cliente c   ON c.id_cliente = os.id_cliente
      LEFT JOIN tecnico t   ON t.id_tecnico = os.id_tecnico
      LEFT JOIN status_os s ON s.id_status  = os.id_status_os
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY os.data_atualizacao DESC, os.id_os DESC
      LIMIT 5000
    `;

    const [rows] = await db.query(sql, params);

    // === PDF ===
    const doc = new PDFDocument({ size: "A4", margin: 36 });
    const filename = `relatorio-os_${dayjs().tz(TZ).format("YYYYMMDD_HHmm")}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    doc.pipe(res);

    // Header
    doc
      .fontSize(16)
      .text("Relatório de Ordens de Serviço", { align: "center" })
      .moveDown(0.2);
    doc
      .fontSize(10)
      .fillColor("#444")
      .text(`Gerado em: ${dayjs().tz(TZ).format("DD/MM/YYYY HH:mm")}`, { align: "center" })
      .moveDown();

    // Filtros exibidos
    doc
      .fontSize(10)
      .fillColor("#000")
      .text("Filtros aplicados:", { underline: true });
    doc
      .fontSize(10)
      .text(`• Status: ${String(status).toLowerCase() === "all" ? "Todos" : status}`)
      .text(`• Técnico: ${String(tecnico).toLowerCase() === "all" ? "Todos" : tecnico}`)
      .text(`• Período: ${from ? dayjs(from).format("DD/MM/YYYY") : "—"} a ${to ? dayjs(to).format("DD/MM/YYYY") : "—"}`)
      .moveDown();

    // Totais
    doc
      .fontSize(11)
      .fillColor("#000")
      .text(`Total de OS encontradas: ${rows.length}`)
      .moveDown(0.5);

    // Cabeçalho da tabela
    const col = {
      id: 36,
      cliente: 90,
      tecnico: 260,
      status: 420,
      data: 510,
    };
    const rowHeight = 18;

    doc
      .fontSize(10)
      .fillColor("#111")
      .text("ID", col.id, doc.y, { continued: true })
      .text("Cliente", col.cliente, doc.y, { continued: true })
      .text("Técnico", col.tecnico, doc.y, { continued: true })
      .text("Status", col.status, doc.y, { continued: true })
      .text("Atualização", col.data, doc.y)
      .moveTo(36, doc.y + 2)
      .lineTo(559, doc.y + 2)
      .strokeColor("#999")
      .stroke()
      .moveDown(0.2);

    // Linhas
    doc.strokeColor("#eee");
    rows.forEach((r, idx) => {
      if (doc.y > 780) {
        doc.addPage();
        // Repetir cabeçalho simples na página nova
        doc
          .fontSize(10)
          .fillColor("#111")
          .text("ID", col.id, 36, { continued: true })
          .text("Cliente", col.cliente, 36, { continued: true })
          .text("Técnico", col.tecnico, 36, { continued: true })
          .text("Status", col.status, 36, { continued: true })
          .text("Atualização", col.data, 36)
          .moveTo(36, 48)
          .lineTo(559, 48)
          .strokeColor("#999")
          .stroke()
          .moveDown(0.2);
      }

      const yStart = doc.y;
      doc
        .fontSize(9)
        .fillColor("#000")
        .text(String(r.id_os), col.id, yStart, { width: 50 })
        .text(String(r.cliente || "-"), col.cliente, yStart, { width: 160 })
        .text(String(r.tecnico || "-"), col.tecnico, yStart, { width: 150 })
        .text(String(r.status || "-"), col.status, yStart, { width: 80 })
        .text(
          r.data_atualizacao
            ? dayjs(r.data_atualizacao).tz(TZ).format("DD/MM/YYYY HH:mm")
            : "-",
          col.data,
          yStart,
          { width: 80 }
        );

      // linha separadora
      doc
        .moveTo(36, yStart + rowHeight - 4)
        .lineTo(559, yStart + rowHeight - 4)
        .strokeColor(idx % 2 === 0 ? "#f0f0f0" : "#e6e6e6")
        .stroke();

      doc.moveDown(0.2);
    });

    doc.end();
  } catch (e) {
    console.error("relatorios/os error:", e);
    res.status(500).json({ erro: "Falha ao gerar relatório." });
  }
});

module.exports = router;
