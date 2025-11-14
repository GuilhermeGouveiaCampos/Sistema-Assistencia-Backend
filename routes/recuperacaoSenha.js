// backend/routes/recuperacaoSenha.js
const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();
const db = require("../db"); // seu pool mysql2/promise
const { sendDirectMessage } = require("../utils/whats-bot");

// Se você já tiver algo parecido em utils/whats.js, reaproveita
let enviarWhatsapp = async () => {};
try {
  ({ enviarWhatsapp } = require("../utils/whats"));
} catch {
  console.log("[RECUPERAÇÃO] utils/whats não encontrado, usando stub");
  enviarWhatsapp = async (numero, mensagem) => {
    console.log(`[FAKE WHATS] Enviando para ${numero}: ${mensagem}`);
  };
}

/**
 * POST /api/recuperar-senha
 * Body: { cpf: "12345678900" }
 * - Busca usuário pelo CPF
 * - Gera código
 * - Salva em recuperacao_senha
 * - Envia código via WhatsApp
 */
router.post("/recuperar-senha", async (req, res) => {
  try {
    const { cpf } = req.body;

    if (!cpf) {
      return res.status(400).json({ erro: "Informe o CPF." });
    }

    const [usuarios] = await db.query(
      "SELECT id_usuario, cpf, telefone FROM usuario WHERE cpf = ? AND status = 'ativo'",
      [cpf]
    );

    if (usuarios.length === 0) {
      return res.status(404).json({ erro: "Usuário não encontrado para este CPF." });
    }

    const usuario = usuarios[0];

    if (!usuario.telefone) {
      return res
        .status(400)
        .json({ erro: "Usuário não possui telefone cadastrado para recuperação." });
    }

    // Código de 6 dígitos
    const codigo = Math.floor(100000 + Math.random() * 900000).toString();

    // Validade de 5 minutos
    const expiraEm = new Date(Date.now() + 5 * 60 * 1000);

    await db.query(
      "INSERT INTO recuperacao_senha (id_usuario, codigo, expira_em) VALUES (?, ?, ?)",
      [usuario.id_usuario, codigo, expiraEm]
    );

    const mensagem = `🔐 Eletrotek - Recuperação de senha\n\nSeu código é: *${codigo}*\nEle é válido por 5 minutos.\n\nSe não foi você quem solicitou, pode ignorar esta mensagem.`;

// usa o bot para mandar no WhatsApp
        await sendDirectMessage(usuario.telefone, mensagem);

    return res.json({
      ok: true,
      mensagem: "Código de recuperação enviado via WhatsApp.",
    });
  } catch (erro) {
    console.error("[RECUPERAR-SENHA] Erro:", erro);
    return res.status(500).json({ erro: "Erro ao solicitar recuperação de senha." });
  }
});

/**
 * POST /api/validar-codigo
 * Body: { cpf: "12345678900", codigo: "123456" }
 * - Confere se o código é válido, não usado e não expirado
 */
router.post("/validar-codigo", async (req, res) => {
  try {
    const { cpf, codigo } = req.body;

    if (!cpf || !codigo) {
      return res.status(400).json({ erro: "CPF e código são obrigatórios." });
    }

    const [usuarios] = await db.query(
      "SELECT id_usuario FROM usuario WHERE cpf = ? AND status = 'ativo'",
      [cpf]
    );

    if (usuarios.length === 0) {
      return res.status(404).json({ erro: "Usuário não encontrado." });
    }

    const usuario = usuarios[0];

    const [rows] = await db.query(
      `SELECT * 
         FROM recuperacao_senha 
        WHERE id_usuario = ? 
          AND codigo = ? 
          AND usado = 0
        ORDER BY id DESC
        LIMIT 1`,
      [usuario.id_usuario, codigo]
    );

    if (rows.length === 0) {
      return res.status(400).json({ erro: "Código inválido." });
    }

    const rec = rows[0];

    const agora = new Date();
    const expira = new Date(rec.expira_em);

    if (agora > expira) {
      return res.status(400).json({ erro: "Código expirado." });
    }

    // Aqui poderíamos gerar um "token de reset" simples,
    // mas como você vai enviar CPF + código também no trocar-senha,
    // vamos só retornar ok.
    return res.json({ ok: true, mensagem: "Código válido. Pode alterar a senha." });
  } catch (erro) {
    console.error("[VALIDAR-CODIGO] Erro:", erro);
    return res.status(500).json({ erro: "Erro ao validar código." });
  }
});

/**
 * POST /api/trocar-senha
 * Body: { cpf: "12345678900", codigo: "123456", nova_senha: "xxx" }
 * - Revalida código
 * - Marca como usado
 * - Atualiza a senha do usuário
 */
router.post("/trocar-senha", async (req, res) => {
  try {
    const { cpf, codigo, nova_senha } = req.body;

    if (!cpf || !codigo || !nova_senha) {
      return res
        .status(400)
        .json({ erro: "CPF, código e nova senha são obrigatórios." });
    }

    const [usuarios] = await db.query(
      "SELECT id_usuario FROM usuario WHERE cpf = ? AND status = 'ativo'",
      [cpf]
    );

    if (usuarios.length === 0) {
      return res.status(404).json({ erro: "Usuário não encontrado." });
    }

    const usuario = usuarios[0];

    const [rows] = await db.query(
      `SELECT * 
         FROM recuperacao_senha 
        WHERE id_usuario = ? 
          AND codigo = ? 
          AND usado = 0
        ORDER BY id DESC
        LIMIT 1`,
      [usuario.id_usuario, codigo]
    );

    if (rows.length === 0) {
      return res.status(400).json({ erro: "Código inválido." });
    }

    const rec = rows[0];
    const agora = new Date();
    const expira = new Date(rec.expira_em);

    if (agora > expira) {
      return res.status(400).json({ erro: "Código expirado." });
    }

    // Hash da nova senha
    const hash = await bcrypt.hash(nova_senha, 10);

    // Atualiza senha do usuário
    await db.query(
      "UPDATE usuario SET senha_hash = ? WHERE id_usuario = ?",
      [hash, usuario.id_usuario]
    );

    // Marca o código como usado
    await db.query(
      "UPDATE recuperacao_senha SET usado = 1 WHERE id = ?",
      [rec.id]
    );

    return res.json({ ok: true, mensagem: "Senha alterada com sucesso." });
  } catch (erro) {
    console.error("[TROCAR-SENHA] Erro:", erro);
    return res.status(500).json({ erro: "Erro ao alterar senha." });
  }
});

module.exports = router;
