  const express = require('express');
  const router = express.Router();
  const db = require('../db');
  const multer = require('multer');
  const path = require('path');
  const fs = require('fs');

  

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '../uploads'));
  },
  filename: function (req, file, cb) {
    const nomeArquivo = Date.now() + path.extname(file.originalname);
    cb(null, nomeArquivo);
  }
});

const upload = multer({ storage: storage });

  router.get('/', (req, res) => {
    const db = req.app.get('db');
    const { tipo, nome_cliente, modelo } = req.query;

    let sql = `
      SELECT 
        e.*, 
        c.nome AS nome_cliente 
      FROM equipamento e
      JOIN cliente c ON e.id_cliente = c.id_cliente
      WHERE e.status = 'ativo'
    `;

    const params = [];

    if (tipo) {
      sql += " AND e.tipo LIKE ?";
      params.push(`%${tipo}%`);
    }

    if (nome_cliente) {
      sql += " AND c.nome LIKE ?";
      params.push(`%${nome_cliente}%`);
    }

    if (modelo) {
      sql += " AND e.modelo LIKE ?";
      params.push(`%${modelo}%`);
    }

    db.query(sql, params, (err, result) => {
      if (err) {
        console.error("❌ Erro ao buscar equipamentos:", err.message);
        return res.status(500).json({ erro: err.message });
      }
      res.json(result);
    });
  });

  // ❌ Inativar equipamento (exclusão lógica)
  router.delete('/:id', (req, res) => {
    const { id } = req.params;

    const sql = 'UPDATE equipamento SET status = "inativo" WHERE id_equipamento = ?';

    db.query(sql, [id], (err, result) => {
      if (err) {
        console.error('❌ Erro ao inativar equipamento:', err);
        return res.status(500).json({ erro: 'Erro ao marcar equipamento como inativo.' });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ erro: 'Equipamento não encontrado.' });
      }

      res.status(200).json({ mensagem: 'Equipamento marcado como inativo com sucesso.' });
    });
  });

  router.get('/inativos', async (req, res) => {
    try {
      const [result] = await db.query("SELECT * FROM equipamento WHERE status = 'inativo'");
      res.json(result);
    } catch (err) {
      console.error("Erro ao buscar equipamentos inativos:", err);
      res.status(500).json({ erro: "Erro interno ao buscar equipamentos inativos" });
    }
  });

  router.put('/ativar/:id', async (req, res) => {
    const { id } = req.params;
    try {
      await db.query("UPDATE equipamento SET status = 'ativo' WHERE id_equipamento = ?", [id]);
      res.json({ mensagem: "Equipamento ativado com sucesso" });
    } catch (err) {
      console.error("Erro ao ativar equipamento:", err);
      res.status(500).json({ erro: "Erro ao ativar equipamento" });
    }
  });
 
  // 📤 Cadastrar novo equipamento com imagens
router.post('/', upload.array('imagens', 20), (req, res) => {
  const {
    id_cliente,
    tipo,
    marca,
    modelo,
    numero_serie,
    status
  } = req.body;

  const imagens = req.files;

  if (!id_cliente || !tipo || !marca || !modelo || !numero_serie) {
    return res.status(400).json({ erro: 'Todos os campos são obrigatórios.' });
  }

  if (!imagens || imagens.length === 0) {
    return res.status(400).json({ erro: 'Pelo menos uma imagem deve ser enviada.' });
  }

  const nomesImagens = imagens.map((img) => img.filename).join(',');
  console.log("🖼️ Imagens salvas:", nomesImagens);

  const sql = `
    INSERT INTO equipamento (id_cliente, tipo, marca, modelo, numero_serie, status, imagem)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  const valores = [
    id_cliente,
    tipo,
    marca,
    modelo,
    numero_serie,
    status || 'ativo',
    nomesImagens
  ];

  const database = req.app.get('db') || db;

  database.query(sql, valores, (err, result) => {
    if (err) {
      console.error('❌ Erro ao cadastrar equipamento:', err);
      return res.status(500).json({ erro: 'Erro ao cadastrar equipamento.' });
    }

    console.log('✅ Equipamento cadastrado com ID:', result.insertId);
    res.status(201).json({
      mensagem: 'Equipamento cadastrado com sucesso.',
      id: result.insertId,
      imagens: nomesImagens
    });
  });
});

router.get('/:id', (req, res) => {
  const db = req.app.get('db'); // <-- Adiciona isso aqui!
  const id = parseInt(req.params.id);

  if (isNaN(id)) {
    return res.status(400).json({ erro: "ID inválido" });
  }

  const sql = `
    SELECT 
      e.*, 
      c.nome AS nome_cliente, 
      c.cpf
    FROM equipamento e
    JOIN cliente c ON e.id_cliente = c.id_cliente
    WHERE e.id_equipamento = ?
  `;

  db.query(sql, [id], (err, result) => {
    if (err) {
      console.error("❌ Erro ao executar query:", err);
      return res.status(500).json({ erro: "Erro interno do servidor" });
    }

    if (result.length === 0) {
      return res.status(404).json({ erro: "Equipamento não encontrado" });
    }

    return res.json(result[0]);
  });
});

// ✅ Atualizar dados de um equipamento
router.put("/:id", upload.array("imagens", 20), async (req, res) => {
  const { tipo, marca, modelo, numero_serie, imagem } = req.body;
  const id = req.params.id;

  try {
    // Obter imagens atuais do banco
    const [resultadoAtual] = await db.query("SELECT imagem FROM equipamento WHERE id_equipamento = ?", [id]);
    const imagensAntigas = resultadoAtual[0]?.imagem?.split(",") || [];

    const imagensMantidas = imagem ? imagem.split(",") : [];
    const imagensRemovidas = imagensAntigas.filter(img => !imagensMantidas.includes(img));

    // Excluir arquivos do servidor
    for (const nome of imagensRemovidas) {
      const caminho = path.join(__dirname, "../uploads", nome);
      if (fs.existsSync(caminho)) fs.unlinkSync(caminho);
    }

    const novasImagens = req.files.map((file) => file.filename);
    const todasImagens = [...imagensMantidas, ...novasImagens];

    await db.query(
      "UPDATE equipamento SET tipo = ?, marca = ?, modelo = ?, numero_serie = ?, imagem = ? WHERE id_equipamento = ?",
      [tipo, marca, modelo, numero_serie, todasImagens.join(","), id]
    );

    res.status(200).json({ message: "Equipamento atualizado com sucesso." });
  } catch (error) {
    console.error("Erro ao atualizar equipamento:", error);
    res.status(500).json({ error: "Erro ao atualizar equipamento." });
  }
});

// backend/routes/equipamentos.js
router.get('/por-cliente/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await db.query(
      'SELECT id_equipamento, tipo, marca, modelo FROM equipamento WHERE id_cliente = ? AND status = "ativo"',
      [id]
    );
    res.json(rows);
  } catch (error) {
    console.error("Erro ao buscar equipamentos:", error);
    res.status(500).json({ erro: "Erro ao buscar equipamentos" });
  }
});







  module.exports = router;
