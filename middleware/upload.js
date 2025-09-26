const multer = require('multer');

// guarda os uploads em MEMÓRIA (Buffer)
const storage = multer.memoryStorage();

// limite de 5 MB por arquivo (ajuste se quiser)
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }
});

module.exports = { upload, UPLOAD_ROOT: null };
