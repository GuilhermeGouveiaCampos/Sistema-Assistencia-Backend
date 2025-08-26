// routes/equipamentos.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Garante a pasta /uploads
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer (salva arquivos em /uploads)
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

/** Helper: checa se a coluna 'status' existe na tabela equipamento */
function checkHasStatusColumn(db, cb) {
  db.query("SHOW COLUMNS FROM equipamento LIKE 'status'", (err, rows) => {
    if (err) {
      console.error('⛔ Erro ao checar coluna status:', err);
      return cb(false); // segue sem status
    }
    cb(Array.isArray(rows) && rows.length > 0);
  });
}

/** GET /api/equipamentos?tipo=&nome_cliente=&modelo= */
router.get('/', (req, res) => {
  const db = req.app.get('db');
  const { tipo = '', nome_cliente = '', modelo = '' } = req.query || {};

  checkHasStatusColumn(db, (hasStatus) => {
    const where = [];
    const params = [];

    // Só filtra status se a coluna existir
    if (hasStatus) {
      where.push("e.status = 'ativo'");
    }

    if (tipo) {
      where.push('e.tipo LIKE ?');
      params.push(`%${tipo}%`);
    }
    if (nome_cliente) {
      where.push('c.nome LIKE ?');
      params.push(`%${nome_cliente}%`);
    }
    if (modelo) {
      where.push('e.modelo LIKE ?');
      params.push(`%${modelo}%`);
    }

    const sql = `
      SELECT
        e.*,
        c.nome AS nome_cliente
      FROM equipamento e
      JOIN cliente c ON e.id_cliente = c.id_cliente
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.id_equipamento DESC
    `;

    db.query(sql, params, (err, rows) => {
      if (err) {
        console.error('⛔ Erro DB GET /api/equipamentos:', err);
        return res.status(500).json({ erro: 'Erro ao buscar equipamentos.' });
      }
      res.json(rows || []);
    });
  });
});

/** DELETE lógico: /api/equipamentos/:id  → status = inativo (se existir), senão apaga */
router.delete('/:id', (req, res) => {
  const db = req.app.get('db');
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erro: 'ID inválido.' });

  checkHasStatusColumn(db, (hasStatus) => {
    const sql = hasStatus
      ? 'UPDATE equipamento SET status = "inativo" WHERE id_equipamento = ?'
      : 'DELETE FROM equipamento WHERE id_equipamento = ?';

    db.query(sql, [id], (err, result) => {
      if (err) {
        console.error('⛔ Erro DB DELETE /api/equipamentos:', err);
        return res.status(500).json({ erro: 'Erro ao inativar/excluir equipamento.' });
      }
      if (!result || result.affectedRows === 0) {
        return res.status(404).json({ erro: 'Equipamento não encontrado.' });
      }
      res.json({
        ok: true,
        acao: hasStatus ? 'inativado' : 'excluido',
        affectedRows: result.affectedRows || 0,
      });
    });
  });
});

/** GET /api/equipamentos/inativos */
router.get('/inativos', (req, res) => {
  const db = req.app.get('db');
  checkHasStatusColumn(db, (hasStatus) => {
    if (!hasStatus) {
      // Se não tem coluna status, não há como listar "inativos"
      return res.json([]);
    }
    db.query("SELECT * FROM equipamento WHERE status = 'inativo' ORDER BY id_equipamento DESC", (err, rows) => {
      if (err) {
        console.error('⛔ Erro DB GET /api/equipamentos/inativos:', err);
        return res.status(500).json({ erro: 'Erro ao buscar equipamentos inativos.' });
      }
      res.json(rows || []);
    });
  });
});

/** PUT /api/equipamentos/ativar/:id */
router.put('/ativar/:id', (req, res) => {
  const db = req.app.get('db');
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erro: 'ID inválido.' });

  checkHasStatusColumn(db, (hasStatus) => {
    if (!hasStatus) {
      return res.status(400).json({ erro: 'Coluna "status" não existe na tabela equipamento.' });
    }
    db.query("UPDATE equipamento SET status = 'ativo' WHERE id_equipamento = ?", [id], (err, result) => {
      if (err) {
        console.error('⛔ Erro DB PUT /api/equipamentos/ativar:', err);
        return res.status(500).json({ erro: 'Erro ao ativar equipamento.' });
      }
      res.json({ ok: true, affectedRows: result?.affectedRows || 0 });
    });
  });
});

/** POST /api/equipamentos  (com upload de imagens) */
router.post('/', upload.array('imagens', 20), (req, res) => {
  const db = req.app.get('db');
  const { id_cliente, tipo, marca, modelo, numero_serie, status } = req.body || {};
  const files = Array.isArray(req.files) ? req.files : [];

  if (!id_cliente || !tipo || !marca || !modelo || !numero_serie) {
    // imagens podem ser opcionais dependendo do seu caso; ajuste se quiser obrigatórias
    return res.status(400).json({ erro: 'id_cliente, tipo, marca, modelo e numero_serie são obrigatórios.' });
  }

  const nomesImagens = files.map((f) => f.filename);
  const imagensCSV = nomesImagens.join(',');

  checkHasStatusColumn(db, (hasStatus) => {
    const cols = ['id_cliente', 'tipo', 'marca', 'modelo', 'numero_serie', 'imagem'];
    const qms  = ['?', '?', '?', '?', '?', '?'];
    const vals = [id_cliente, tipo, marca, modelo, numero_serie, imagensCSV];

    if (hasStatus) {
      cols.push('status');
      qms.push('?');
      vals.push(status || 'ativo');
    }

    const sql = `INSERT INTO equipamento (${cols.join(', ')}) VALUES (${qms.join(', ')})`;

    db.query(sql, vals, (err, result) => {
      if (err) {
        console.error('⛔ Erro DB POST /api/equipamentos:', err);
        return res.status(500).json({ erro: 'Erro ao cadastrar equipamento.' });
      }
      res.status(201).json({
        mensagem: 'Equipamento cadastrado com sucesso.',
        id_equipamento: result.insertId,
        imagens: nomesImagens,
      });
    });
  });
});

/** GET /api/equipamentos/:id  (detalhe) */
router.get('/:id', (req, res) => {
  const db = req.app.get('db');
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erro: 'ID inválido.' });

  const sql = `
    SELECT e.*, c.nome AS nome_cliente, c.cpf
    FROM equipamento e
    JOIN cliente c ON e.id_cliente = c.id_cliente
    WHERE e.id_equipamento = ?
    LIMIT 1
  `;
  db.query(sql, [id], (err, rows) => {
    if (err) {
      console.error('⛔ Erro DB GET /api/equipamentos/:id:', err);
      return res.status(500).json({ erro: 'Erro ao buscar equipamento.' });
    }
    if (!rows || rows.length === 0) {
      return res.status(404).json({ erro: 'Equipamento não encontrado.' });
    }
    res.json(rows[0]);
  });
});

/** PUT /api/equipamentos/:id  (atualiza dados + imagens) */
router.put('/:id', upload.array('imagens', 20), (req, res) => {
  const db = req.app.get('db');
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erro: 'ID inválido.' });

  const { tipo, marca, modelo, numero_serie, imagem } = req.body || {};
  const novas = Array.isArray(req.files) ? req.files.map((f) => f.filename) : [];

  // 1) Busca imagens atuais
  db.query('SELECT imagem FROM equipamento WHERE id_equipamento = ?', [id], (err, rows) => {
    if (err) {
      console.error('⛔ Erro DB SELECT imagens atuais:', err);
      return res.status(500).json({ erro: 'Erro ao atualizar equipamento.' });
    }
    const antigas = (rows && rows[0] && rows[0].imagem ? String(rows[0].imagem).split(',') : []).filter(Boolean);
    const mantidas = (imagem ? String(imagem).split(',') : []).filter(Boolean);

    // 2) Apaga arquivos removidos
    const remover = antigas.filter((nome) => !mantidas.includes(nome));
    for (const nome of remover) {
      const p = path.join(uploadDir, nome);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
    }

    // 3) Junta mantidas + novas e atualiza
    const todas = [...mantidas, ...novas].filter(Boolean);
    const sql = `
      UPDATE equipamento
      SET tipo = ?, marca = ?, modelo = ?, numero_serie = ?, imagem = ?
      WHERE id_equipamento = ?
    `;
    const vals = [tipo, marca, modelo, numero_serie, todas.join(','), id];

    db.query(sql, vals, (err2) => {
      if (err2) {
        console.error('⛔ Erro DB UPDATE /api/equipamentos/:id:', err2);
        return res.status(500).json({ erro: 'Erro ao atualizar equipamento.' });
      }
      res.json({ mensagem: 'Equipamento atualizado com sucesso.', imagens: todas });
    });
  });
});

/** GET /api/equipamentos/por-cliente/:id */
router.get('/por-cliente/:id', (req, res) => {
  const db = req.app.get('db');
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erro: 'ID inválido.' });

  checkHasStatusColumn(db, (hasStatus) => {
    const sql = `
      SELECT id_equipamento, tipo, marca, modelo
      FROM equipamento
      WHERE id_cliente = ?
      ${hasStatus ? 'AND status = "ativo"' : ''}
      ORDER BY id_equipamento DESC
    `;
    db.query(sql, [id], (err, rows) => {
      if (err) {
        console.error('⛔ Erro DB GET /api/equipamentos/por-cliente/:id:', err);
        return res.status(500).json({ erro: 'Erro ao buscar equipamentos do cliente.' });
      }
      res.json(rows || []);
    });
  });
});

module.exports = router;
