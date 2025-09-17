// middleware/upload.js
const multer = require('multer');
const path = require('path');
const fs = require('fs');

//
// ONDE SALVAR?
// - Em DEV: usa <repo>/uploads/os
// - Em PROD (Railway com Volume): defina UPLOAD_DIR=/data/uploads/os
//
const UPLOAD_ROOT = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', 'uploads', 'os');

// garante que a pasta existe
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_ROOT),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path
      .basename(file.originalname, ext)
      .replace(/[^\w\-]+/g, '_')
      .slice(0, 50);
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${unique}-${base}${ext}`);
  },
});

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/jpg'];

const fileFilter = (req, file, cb) => {
  if (ALLOWED.includes(file.mimetype)) return cb(null, true);
  cb(new Error('Tipo de arquivo não suportado'));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { files: 20, fileSize: 5 * 1024 * 1024 }, // 20 imagens, 5MB cada
});

module.exports = { upload, UPLOAD_ROOT };
