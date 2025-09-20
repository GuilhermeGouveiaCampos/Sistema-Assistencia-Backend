// backend/routes/bridge-rfid.js
// Ponte Serial → HTTP: lê UID do Arduino (MFRC522) e envia pro backend

const { SerialPort, ReadlineParser } = require('serialport');
const axios = require('axios');

const SERIAL_PORT = process.env.SERIAL_PORT || 'COM5';
const BAUD_RATE   = Number(process.env.BAUD_RATE || 9600);
const API_BASE    = (process.env.API_BASE || 'http://localhost:3001').replace(/\/+$/, '');
const LEITOR_ID   = process.env.LEITOR_ID || 'PC-MESA01_COM5';
const LEITOR_KEY  = process.env.LEITOR_KEY || 'SEGREDO123';
const BRIDGE_MODE = (process.env.BRIDGE_MODE || 'EVENT').toUpperCase(); // EVENT | PUSH

console.log('[Bridge] Iniciando...');
console.log(`[Bridge] SERIAL_PORT=${SERIAL_PORT} BAUD_RATE=${BAUD_RATE}`);
console.log(`[Bridge] API_BASE=${API_BASE}`);
console.log(`[Bridge] LEITOR_ID=${LEITOR_ID}`);
console.log(`[Bridge] BRIDGE_MODE=${BRIDGE_MODE}`);

let port;
let parser;

function listPorts() {
  if (typeof SerialPort.list === 'function') {
    SerialPort.list()
      .then(list => {
        console.log('[Serial] Portas disponíveis:');
        for (const p of list) {
          const name = p.friendlyName || p.manufacturer || '';
          console.log(` - ${p.path} | ${name}`);
        }
      })
      .catch(() => {});
  }
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

// Extrai UID de várias formas e normaliza para HEX contínuo (>= 8 chars)
function extractUid(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // JSON: {"uid":"04A1B2C3D4"}
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      if (obj && obj.uid) {
        const hex = String(obj.uid).toUpperCase().replace(/[^0-9A-F]/g, '');
        if (hex.length >= 8) return hex;
      }
    } catch {}
  }

  // Linhas tipo: "Card UID: 03 A1 E5 2C" ou "UID: 03A1E52C"
  const m = s.match(/([0-9A-F]{2}(\s|:|-)?){4,10}/i);
  if (m) {
    const hex = m[0].toUpperCase().replace(/[^0-9A-F]/g, '');
    if (hex.length >= 8) return hex;
  }
  return null;
}

async function enviarUid(uid) {
  try {
    if (BRIDGE_MODE === 'EVENT') {
      const url = `${API_BASE}/api/ardloc/event`;
      const body = { uid }; // autenticação é via headers
      const headers = {
        'Content-Type': 'application/json',
        'x-leitor-codigo': LEITOR_ID,
        'x-leitor-key': LEITOR_KEY,
      };
      console.log('[Bridge→API EVENT] POST', url, { body, headers });
      const res = await axios.post(url, body, { timeout: 8000, headers });
      console.log('[API EVENT ←]', res.status, res.data);
    } else {
      const url = `${API_BASE}/api/ardloc/push-uid`;
      const body = { uid };
      const headers = {
        'Content-Type': 'application/json',
        'x-leitor-codigo': LEITOR_ID,
        'x-leitor-key': LEITOR_KEY,
      };
      console.log('[Bridge→API PUSH] POST', url, { body, headers });
      const res = await axios.post(url, body, { timeout: 8000, headers });
      console.log('[API PUSH ←]', res.status, res.data);
    }
  } catch (err) {
    if (err.response) {
      console.error('[API ERRO]', err.response.status, err.response.data);
    } else {
      console.error('[Bridge ERRO]', err.message);
    }
  }
}

async function onSerialLine(line) {
  const raw = (line || '').toString().trim();
  if (!raw) return;

  console.log('[Serial<=]', raw.slice(0, 200));

  const uid = extractUid(raw);
  if (!uid) return;

  const now = Date.now();
  if (uid === lastUid && (now - lastAt) < 1500) return;
  lastUid = uid; lastAt = now;

  console.log(`[RFID] Tag lida: ${uid}`);
  await enviarUid(uid);
}

openSerial();
