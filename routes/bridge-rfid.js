// bridge-rfid.js
// Ponte Serial → HTTP: lê UID do Arduino (MFRC522) e envia pro backend

const { SerialPort, ReadlineParser } = require('serialport');
const axios = require('axios');

/**
 * CONFIG por variáveis de ambiente:
 *  SERIAL_PORT  -> "COM3" (Windows) | "/dev/ttyUSB0" ou "/dev/ttyACM0" (Linux)
 *  BAUD_RATE    -> padrão 115200
 *  API_BASE     -> "http://localhost:3001" (dev) | URL do Railway em produção
 *  LEITOR_ID    -> ex: "PC-MESA01_COM3" (DEVE existir no seu mapeamento do backend)
 *  API_KEY      -> mesma chave configurada no backend (process.env.API_KEY_RFID)
 *
 * Obs: Mantive tudo igual; só mudei a URL p/ /api/ardloc/event e o header p/ x-api-key.
 */
const SERIAL_PORT = process.env.SERIAL_PORT || 'COM3';
const BAUD_RATE   = Number(process.env.BAUD_RATE || 115200);
const API_BASE    = process.env.API_BASE || 'http://localhost:3001';
const LEITOR_ID   = process.env.LEITOR_ID || 'PC-MESA01_COM3';
const API_KEY     = process.env.API_KEY || 'SUA_CHAVE_FORTE';

// --- Abre porta serial ---
let port;
let parser;

function openSerial() {
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

// Trata cada linha JSON vinda do Arduino: {"uid":"04A1B2C3D4"}
async function onSerialLine(line) {
  line = (line || '').trim();
  if (!line.startsWith('{')) return; // ignora ruído

  try {
    const payload = JSON.parse(line);
    const uid = String(payload.uid || '').toUpperCase();
    if (!uid) return;

    // Debounce: evita múltiplos posts do mesmo UID em curto intervalo
    const now = Date.now();
    if (uid === lastUid && (now - lastAt) < 1500) return;
    lastUid = uid; lastAt = now;

    console.log(`[RFID] Tag lida: ${uid}`);

    // 👇 Alterado: endpoint de evento e header de API key
    const url = `${API_BASE}/api/ardloc/event`;
    const body = { uid, leitor_id: LEITOR_ID };

    const res = await axios.post(url, body, {
      timeout: 8000,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY, // <- agora valida no middleware do backend
      },
    });

    console.log('[API]', res.status, res.data);
  } catch (err) {
    if (err.response) {
      console.error('[API ERRO]', err.response.status, err.response.data);
    } else {
      console.error('[Bridge ERRO]', err.message);
    }
  }
}

// Inicializa
openSerial();
