// routes/whatsTest.js
const express = require("express");
const router = express.Router();
const { sendText, getSessionState } = require("../utils/whats");

// GET /api/whats/status  -> ver estado da sessão
router.get("/status", async (_req, res) => {
  const st = await getSessionState();
  res.json(st);
});

// POST /api/whats/test  { to: "11988887777", text: "Olá!" }
router.post("/test", async (req, res) => {
  try {
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ erro: "to e text são obrigatórios" });

    const r = await sendText({ to, text });
    res.json({ ok: true, r });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

module.exports = router;
