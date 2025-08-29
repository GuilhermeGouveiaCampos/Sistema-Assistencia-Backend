// routes/clientes.js
const express = require('express');
const router = express.Router();

/** Utils */
function norm(s) { return String(s || '').trim(); }
function onlyDigits(s) { return String(s || '').replace(/\D/g, ''); }

/** Normaliza datas para YYYY-MM-DD */
function toSqlDate(s) {
  s = String(s || '').trim();
  if (!s) return null;
  const m1 = s.match(/^(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{4})$/); // dd/mm/aaaa
  if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;
  const m2 = s.match(/^(\d{4})[\/\-\.](\d{2})[\/\-\.](\d{2})$/); // aaaa-mm-dd
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return null;
}

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
      where.push("REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), ' ', '') LIKE ?");
      params.push('%' + cpfDigits + '%');
    }
    if (cols.has('status')) where.push("status = 'ativo'");

    const sql = `
      SELECT id_cliente, nome, cpf, ${telSel} AS telefone, data_nascimento, status
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
    if (!cols.has('status')) return res.json([]);

    const telSel = cols.has('telefone') ? 'telefone'
                  : (cols.has('celular') ? 'celular' : 'NULL');

    const sql = `
      SELECT id_cliente, nome, cpf, ${telSel} AS telefone, data_nascimento, status
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
      SELECT id_cliente, nome, cpf, ${telSel} AS telefone, data_nascimento, status
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
  let { nome, cpf, telefone, data_nascimento, status } = req.body || {};
  if (!nome || !cpf) return res.status(400).json({ erro: 'Nome e CPF são obrigatórios.' });

  const cpfClean = onlyDigits(cpf);
  const dataSQL = toSqlDate(data_nascimento);

  getClienteColumns(db, ['telefone', 'celular','status','data_nascimento'], (cols) => {
    const telCol = cols.has('telefone') ? 'telefone' : (cols.has('celular') ? 'celular' : null);

    db.query('SELECT 1 FROM cliente WHERE cpf = ? LIMIT 1', [cpfClean], (err, dup) => {
      if (err) {
        console.error('⛔ Erro DB dup POST /api/clientes:', err?.sqlMessage || err);
        return res.status(500).json({ erro: 'Erro ao validar CPF.' });
      }
      if (dup && dup.length) return res.status(409).json({ erro: 'CPF já cadastrado.' });

      const colsList = ['nome','cpf'];
      const qms = ['?','?'];
      const params = [nome, cpfClean];

      if (telCol) { colsList.push(telCol); qms.push('?'); params.push(telefone ?? ''); }
      if (cols.has('data_nascimento') && dataSQL) { colsList.push('data_nascimento'); qms.push('?'); params.push(dataSQL); }
      if (cols.has('status')) { colsList.push('status'); qms.push('?'); params.push(status || 'ativo'); }

      const sql = `INSERT INTO cliente (${colsList.join(', ')}) VALUES (${qms.join(', ')})`;
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
  let { nome, cpf, telefone, data_nascimento, status } = req.body || {};

  if (!Number.isInteger(id)) return res.status(400).json({ erro: 'ID inválido.' });
  if (!nome || !cpf) return res.status(400).json({ erro: 'Nome e CPF são obrigatórios.' });

  const cpfClean = onlyDigits(cpf);
  const dataSQL = toSqlDate(data_nascimento);

  getClienteColumns(db, ['telefone','celular','status','data_nascimento'], (cols) => {
    const telCol = cols.has('telefone') ? 'telefone' : (cols.has('celular') ? 'celular' : null);

    db.query('SELECT 1 FROM cliente WHERE cpf = ? AND id_cliente <> ? LIMIT 1', [cpfClean, id], (err, dup) => {
      if (err) {
        console.error('⛔ Erro DB dup PUT /api/clientes:', err?.sqlMessage || err);
        return res.status(500).json({ erro: 'Erro ao validar CPF.' });
      }
      if (dup && dup.length) return res.status(409).json({ erro: 'CPF já cadastrado para outro cliente.' });

      const sets = ['nome = ?','cpf = ?'];
      const params = [nome, cpfClean];

      if (telCol) { sets.push(`${telCol} = ?`); params.push(telefone ?? ''); }
      if (cols.has('data_nascimento')) { sets.push('data_nascimento = ?'); params.push(dataSQL); }
      if (cols.has('status') && status) { sets.push('status = ?'); params.push(status); }

      const sql = `UPDATE cliente SET ${sets.join(', ')} WHERE id_cliente = ?`;
      params.push(id);

      db.query(sql, params, (err2, result) => {
        if (err2) {
          console.error('⛔ Erro DB UPDATE /api/clientes:', err2?.sqlMessage || err2, '\nSQL:', sql, '\nParams:', params);
          return res.status(500).json({ erro: 'Erro ao atualizar cliente.' });
        }
        if (!result || result.affectedRows === 0) return res.status(404).json({ erro: 'Cliente não encontrado.' });
        res.json({ mensagem: 'Cliente atualizado com sucesso.' });
      });
    });
  });
});

module.exports = router;
