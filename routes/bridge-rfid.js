// backend/routes/bridge-rfid.js
// Ponte Serial → HTTP: lê UID de Arduino (MFRC522) e envia pro backend (ardloc)

const { SerialPort, ReadlineParser } = require('serialport');
const axios = require('axios');

const SERIAL_PORT = process.env.SERIAL_PORT || 'COM5';
const BAUD_RATE   = Number(process.env.BAUD_RATE || 115200);
const API_BASE    = process.env.API_BASE || 'http://localhost:3001';
const LEITOR_ID   = process.env.LEITOR_ID || 'PC-MESA01_COM5';
const LEITOR_KEY  = process.env.LEITOR_KEY || 'SEGREDO123';

console.log('[Bridge] Iniciando...');
console.log(`[Bridge] SERIAL_PORT=${SERIAL_PORT} BAUD_RATE=${BAUD_RATE}`);
console.log(`[Bridge] API_BASE=${API_BASE}`);
console.log(`[Bridge] LEITOR_ID=${LEITOR_ID}`);

let port;
let parser;

function listPorts() {
  SerialPort.list().then(list => {
    console.log('[Serial] Portas disponíveis:');
    for (const p of list) {
      console.log(` - ${p.path} | ${p.friendlyName || p.manufacturer || ''}`);
    }
  }).catch(() => {});
}

function openSerial() {
  listPorts();

  port = new SerialPort({ path: SERIAL_PORT, baudRate: BAUD_RATE }, (err) => {
    if (err) {
      console.error('[Serial] Erro ao abrir:', err.message);
      setTimeout(openSerial, 3000);
    }
  });

  parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

  port.on('open', () => {
    console.log(`[Serial] Aberta em ${SERIAL_PORT} @ ${BAUD_RATE}`);
  });

  port.on('error', (e) => {
    console.error('[Serial] Erro:', e.message);
  });

  port.on('close', () => {
    console.warn('[Serial] Fechada. Tentando reabrir em 3s...');
    setTimeout(openSerial, 3000);
  });

  parser.on('data', onSerialLine);
}

let lastUid = '';
let lastAt  = 0;

// Normaliza string -> HEX contínuo (8+ chars)
function extractUid(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // Tenta JSON: {"uid":"04A1B2C3D4"}
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      if (obj && obj.uid) {
        const hex = String(obj.uid).toUpperCase().replace(/[^0-9A-F]/g, '');
        if (hex.length >= 8) return hex;
      }
    } catch {}
  }

  // Tenta linhas tipo: "Card UID: 03 A1 E5 2C" ou "UID: 03A1E52C"
  const m = s.match(/([0-9A-F]{2}(\s|:|-)?){4,10}/i);
  if (m) {
    const hex = m[0].toUpperCase().replace(/[^0-9A-F]/g, '');
    if (hex.length >= 8) return hex;
  }

  return null;
}

async function onSerialLine(line) {
  const raw = (line || '').toString().trim();
  if (!raw) return;

  // Log de debug do que chega da serial (com limite)
  console.log('[Serial<=]', raw.slice(0, 200));

  const uid = extractUid(raw);
  if (!uid) return; // não parece uma linha com UID

  // Debounce 1.5s para não repetir o mesmo UID
  const now = Date.now();
  if (uid === lastUid && (now - lastAt) < 1500) return;
  lastUid = uid; lastAt = now;

  console.log(`[RFID] Tag lida: ${uid}`);

  try {
    const url = `${API_BASE}/api/ardloc/push-uid`;
    const res = await axios.post(url, { uid }, {
      timeout: 8000,
      headers: {
        'Content-Type': 'application/json',
        'x-leitor-codigo': LEITOR_ID,
        'x-leitor-key': LEITOR_KEY,
      },
    });
    console.log('[API]', res.status, JSON.stringify(res.data));
  } catch (err) {
    if (err.response) {
      console.error('[API ERRO]', err.response.status, err.response.data);
    } else {
      console.error('[Bridge ERRO]', err.message);
    }
  }
}

openSerial();
