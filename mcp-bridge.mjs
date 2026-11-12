import { spawn } from 'child_process';
import fs from 'fs';
import readline from 'readline';
import Database from 'better-sqlite3';

const SERVER_DIR = 'C:/Projects/freellmapi/server';
const DB_PATH = 'C:/Projects/freellmapi/server/data/freeapi.db';
const MCP_URL = 'http://127.0.0.1:3001/mcp';

// 1. Get unified token from SQLite
let token = '';
try {
  const db = new Database(DB_PATH);
  const row = db.prepare("SELECT value FROM settings WHERE key='unified_api_key'").get();
  token = row?.value || '';
  db.close();
} catch (e) {
  console.error('[mcp-bridge] Failed to read token from DB:', e.message);
}

// 2. Ensure FreeLLMAPI HTTP server is listening.
// Cold boot (disk cache empty, Defender scanning node_modules) can take far longer
// than the ~2.6s warm start, so wait up to READY_TIMEOUT_MS before giving up.
const READY_TIMEOUT_MS = 45000;
const LOG_PATH = 'C:/Projects/freellmapi/server/data/server.log';

async function isUp() {
  try {
    await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
      signal: AbortSignal.timeout(1000)
    });
    return true; // any HTTP response means the port is open
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await isUp()) return;
  console.error('[mcp-bridge] FreeLLMAPI server not running, launching in background...');
  const log = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: SERVER_DIR,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log]
  });
  child.unref();
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    if (await isUp()) {
      console.error('[mcp-bridge] FreeLLMAPI server is ready.');
      return;
    }
  }
  console.error(`[mcp-bridge] Server not ready after ${READY_TIMEOUT_MS / 1000}s, see ${LOG_PATH}`);
}

// Forward one JSON-RPC message, retrying while the port is briefly unreachable.
async function forward(body) {
  let lastErr;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await fetch(MCP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body
      });
      return await res.text();
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

const ready = ensureServer();

let pending = 0;
let stdinEnded = false;

function checkExit() {
  if (stdinEnded && pending === 0) {
    process.exit(0);
  }
}

// 3. Stdio JSON-RPC proxy
const rl = readline.createInterface({
  input: process.stdin,
  terminal: false
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  pending++;
  try {
    await ready;
    const data = await forward(trimmed);
    // Notifications get an empty 202 body; JSON-RPC forbids replying to them.
    if (data.trim()) process.stdout.write(data.trim() + '\n');
  } catch (err) {
    console.error('[mcp-bridge] Request failed:', err.message);
    try {
      const parsed = JSON.parse(trimmed);
      const errResp = {
        jsonrpc: '2.0',
        id: parsed.id ?? null,
        error: { code: -32000, message: 'FreeLLMAPI bridge error: ' + err.message }
      };
      process.stdout.write(JSON.stringify(errResp) + '\n');
    } catch {}
  } finally {
    pending--;
    checkExit();
  }
});

process.stdin.on('end', () => {
  stdinEnded = true;
  checkExit();
});
