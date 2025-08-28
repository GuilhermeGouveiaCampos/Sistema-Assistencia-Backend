// routes/clientes.js
const express = require('express');
const router = express.Router();

/** Utils */
function norm(s) { return String(s || '').trim(); }
function onlyDigits(s) { return String(s || '').replace(/\D/g, ''); }

/** Descobre se certas colunas existem na tabela `cliente` */
function getClienteColumns(db, cols, cb) {
  try {
    if (!Array.isArray(cols) || cols.length === 0) return cb(new Set());
    const inList = cols.map(() => '?').join(',');
    const sql = `SHOW COLUMNS FROM cliente WHERE Field IN (${inList})`;
    db.query(sql, cols, (err, rows) => {
      if (err) {
        console.error('⛔ Erro ao checar colunas de cliente:', err?.sqlMessage || err);
        return cb(new Set()); // segue sem travar
      }
      const found = new Set((rows || []).map(r => r.Field));
      cb(found);
    });
  } catch (e) {
    console.error('⛔ Exceção getClienteColumns:', e);
    cb(new Set());
  }
}

/**
 * GET /api/clientes?nome=&cpf=
 */
router.get('/', (req, res) => {
  const db = req.app.get('db');
  const nome = norm(req.query.nome);
  const cpfDigits = onlyDigits(req.query.cpf);

  getClienteColumns(db, ['telefone', 'celular', 'status'], (cols) => {
    const telSel = cols.has('telefone') ? 'telefone'
                  : (cols.has('celular') ? 'celular' : 'NULL');

    const where = [];
    const params = [];

    if (nome) {
      where.push('nome LIKE ?');
      params.push('%' + nome + '%');
    }
    if (cpfDigits) {
      // compara CPF ignorando pontuação
      where.push("REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), ' ', '') LIKE ?");
      params.push('%' + cpfDigits + '%');
    }
    if (cols.has('status')) where.push("status = 'ativo'");

    const sql = `
      SELECT id_cliente, nome, cpf, ${telSel} AS telefone
      FROM cliente
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY nome ASC
    `;

    db.query(sql, params, (err, rows) => {
      if (err) {
        console.error('⛔ Erro DB GET /api/clientes:', err?.sqlMessage || err, '\nSQL:', sql, '\nParams:', params);
        return res.status(500).json({ erro: 'Erro interno ao consultar clientes.' });
      }
      res.json(rows || []);
    });
  });
});

/** GET /api/clientes/inativos */
router.get('/inativos', (req, res) => {
  const db = req.app.get('db');
  getClienteColumns(db, ['status', 'telefone', 'celular'], (cols) => {
    if (!cols.has('status')) return res.json([]); // sem status não há "inativos"

    const telSel = cols.has('telefone') ? 'telefone'
                  : (cols.has('celular') ? 'celular' : 'NULL');

    const sql = `
      SELECT id_cliente, nome, cpf, ${telSel} AS telefone
      FROM cliente
      WHERE status = 'inativo'
      ORDER BY nome ASC
    `;
    db.query(sql, [], (err, rows) => {
      if (err) {
        console.error('⛔ Erro DB GET /api/clientes/inativos:', err?.sqlMessage || err);
        return res.status(500).json({ erro: 'Erro ao buscar clientes inativos.' });
      }
      res.json(rows || []);
    });
  });
});

/** PUT /api/clientes/ativar/:id */
router.put('/ativar/:id', (req, res) => {
  const db = req.app.get('db');
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erro: 'ID inválido.' });

  getClienteColumns(db, ['status'], (cols) => {
    if (!cols.has('status')) {
      return res.status(400).json({ erro: 'Coluna "status" não existe na tabela cliente.' });
    }
    const sql = "UPDATE cliente SET status = 'ativo' WHERE id_cliente = ?";
    db.query(sql, [id], (err, result) => {
      if (err) {
        console.error('⛔ Erro DB PUT /api/clientes/ativar:', err?.sqlMessage || err);
        return res.status(500).json({ erro: 'Erro ao ativar cliente.' });
      }
      if (!result || result.affectedRows === 0) {
        return res.status(404).json({ erro: 'Cliente não encontrado.' });
      }
      res.json({ ok: true, affectedRows: result.affectedRows || 0 });
    });
  });
});

/**
 * DELETE /api/clientes/:id
 * - se tiver coluna status → soft delete (status='inativo')
 * - senão → delete físico
 */
router.delete('/:id', (req, res) => {
  const db = req.app.get('db');
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erro: 'ID inválido.' });

  getClienteColumns(db, ['status'], (cols) => {
    const sql = cols.has('status')
      ? "UPDATE cliente SET status = 'inativo' WHERE id_cliente = ?"
      : "DELETE FROM cliente WHERE id_cliente = ?";
    db.query(sql, [id], (err, result) => {
      if (err) {
        console.error('⛔ Erro DB DELETE /api/clientes:', err?.sqlMessage || err);
        return res.status(500).json({ erro: 'Erro ao excluir/inativar cliente.' });
      }
      if (!result || result.affectedRows === 0) {
        return res.status(404).json({ erro: 'Cliente não encontrado.' });
      }
      res.json({ ok: true, affectedRows: result.affectedRows || 0, soft: cols.has('status') });
    });
  });
});

/** GET /api/clientes/:id */
router.get('/:id', (req, res) => {
  const db = req.app.get('db');
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erro: 'ID inválido.' });

  getClienteColumns(db, ['telefone', 'celular'], (cols) => {
    const telSel = cols.has('telefone') ? 'telefone'
                  : (cols.has('celular') ? 'celular' : 'NULL');
    const sql = `
      SELECT id_cliente, nome, cpf, ${telSel} AS telefone
      FROM cliente
      WHERE id_cliente = ?
      LIMIT 1
    `;
    db.query(sql, [id], (err, rows) => {
      if (err) {
        console.error('⛔ Erro DB GET /api/clientes/:id:', err?.sqlMessage || err);
        return res.status(500).json({ erro: 'Erro ao buscar cliente.' });
      }
      if (!rows || rows.length === 0) return res.status(404).json({ erro: 'Cliente não encontrado.' });
      res.json(rows[0]);
    });
  });
});

/** POST /api/clientes */
router.post('/', (req, res) => {
  const db = req.app.get('db');
  let { nome, cpf, telefone } = req.body || {};
  if (!nome || !cpf) return res.status(400).json({ erro: 'Nome e CPF são obrigatórios.' });

  const cpfClean = onlyDigits(cpf);

  getClienteColumns(db, ['telefone', 'celular'], (cols) => {
    const telCol = cols.has('telefone') ? 'telefone' : (cols.has('celular') ? 'celular' : null);

    db.query('SELECT 1 FROM cliente WHERE cpf = ? LIMIT 1', [cpfClean], (err, dup) => {
      if (err) {
        console.error('⛔ Erro DB dup POST /api/clientes:', err?.sqlMessage || err);
        return res.status(500).json({ erro: 'Erro ao validar CPF.' });
      }
      if (dup && dup.length) return res.status(409).json({ erro: 'CPF já cadastrado.' });

      let sql, params;
      if (telCol) {
        if (telefone == null) telefone = '';
        sql = `INSERT INTO cliente (nome, cpf, ${telCol}) VALUES (?, ?, ?)`;
        params = [nome, cpfClean, telefone];
      } else {
        sql = 'INSERT INTO cliente (nome, cpf) VALUES (?, ?)';
        params = [nome, cpfClean];
      }

      db.query(sql, params, (err2, result) => {
        if (err2) {
          console.error('⛔ Erro DB INSERT /api/clientes:', err2?.sqlMessage || err2);
          return res.status(500).json({ erro: 'Erro ao cadastrar cliente.' });
        }
        res.status(201).json({ mensagem: 'Cliente cadastrado com sucesso.', id_cliente: result.insertId });
      });
    });
  });
});

/** PUT /api/clientes/:id */
router.put('/:id', (req, res) => {
  const db = req.app.get('db');
  const id = Number(req.params.id);
  let { nome, cpf, telefone } = req.body || {};

  if (!Number.isInteger(id)) return res.status(400).json({ erro: 'ID inválido.' });
  if (!nome || !cpf) return res.status(400).json({ erro: 'Nome e CPF são obrigatórios.' });

  const cpfClean = onlyDigits(cpf);

  getClienteColumns(db, ['telefone', 'celular'], (cols) => {
    const telCol = cols.has('telefone') ? 'telefone' : (cols.has('celular') ? 'celular' : null);

    db.query('SELECT 1 FROM cliente WHERE cpf = ? AND id_cliente <> ? LIMIT 1', [cpfClean, id], (err, dup) => {
      if (err) {
        console.error('⛔ Erro DB dup PUT /api/clientes:', err?.sqlMessage || err);
        return res.status(500).json({ erro: 'Erro ao validar CPF.' });
      }
      if (dup && dup.length) return res.status(409).json({ erro: 'CPF já cadastrado para outro cliente.' });

      let sql, params;
      if (telCol) {
        if (telefone == null) telefone = '';
        sql = `UPDATE cliente SET nome = ?, cpf = ?, ${telCol} = ? WHERE id_cliente = ?`;
        params = [nome, cpfClean, telefone, id];
      } else {
        sql = 'UPDATE cliente SET nome = ?, cpf = ? WHERE id_cliente = ?';
        params = [nome, cpfClean, id];
      }

      db.query(sql, params, (err2, result) => {
        if (err2) {
          console.error('⛔ Erro DB UPDATE /api/clientes:', err2?.sqlMessage || err2);
          return res.status(500).json({ erro: 'Erro ao atualizar cliente.' });
        }
        if (!result || result.affectedRows === 0) return res.status(404).json({ erro: 'Cliente não encontrado.' });
        res.json({ mensagem: 'Cliente atualizado com sucesso.' });
      });
    });
  });
});

module.exports = router;
