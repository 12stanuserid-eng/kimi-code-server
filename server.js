#!/usr/bin/env node
/**
 * Kimi Code Render Server v5 — Proper Auth + Always-Alive 💪
 * - Uses `kimi server run --foreground` (no daemon mode — process stays alive)
 * - Forces KIMI_CODE_PASSWORD if not set in env
 * - Auto-restarts Kimi on crash with exponential backoff
 * - Proper daemonAlive tracking
 * - HTTPS keepalive (self-ping via https)
 */

const http = require('http');
const https = require('https');
const { spawn, execSync } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT) || 10000;
const KIMI_PORT = PORT + 1;
const RESTART_DELAY_MS = 5000;

// Run setup.js as fallback (ensures config.toml exists, safe to call multiple times)
try { require('./setup.js'); } catch(e) { console.error('Setup fallback error:', e.message); }

let debugLog = [];
let daemonAlive = false;
let myPublicUrl = null;
let kimiProc = null;
let restartTimer = null;

// ====== PENTARACT BACKUP CONSTANTS ======
const PENTARACT_URL = process.env.PENTARACT_URL || 'https://pentaract-f4ga.onrender.com';
const PENTARACT_EMAIL = process.env.PENTARACT_EMAIL || 'admin@pentaract.com';
const PENTARACT_PASS = process.env.PENTARACT_PASS || 'admin123';
const BACKUP_STORAGE_ID = process.env.BACKUP_STORAGE_ID || 'ad11ad52-b218-4a1d-a661-16655d8bbbf2';
const BACKUP_INTERVAL_MIN = parseInt(process.env.BACKUP_INTERVAL_MIN) || 30;
const KIMI_HOME = process.env['KIMI_CODE_HOME'] || path.join(os.homedir(), '.kimi-code');

let lastBackupTime = null;
let lastBackupSize = 0;
let lastBackupStatus = 'never';

function log(m) {
  debugLog.push(`[${new Date().toISOString()}] ${m}`);
  console.error(m);
}

const STARTING_HTML = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kimi Code</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f0f0f;color:#e0e0e0}div{text-align:center}h2{color:#6c5ce7}.info{color:#888;font-size:13px}.loading{display:inline-block;width:20px;height:20px;border:3px solid #333;border-radius:50%;border-top-color:#6c5ce7;animation:spin 1s linear infinite;margin:10px auto}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body>
<div><div class="loading"></div><h2>🪐 Kimi Code</h2><p>Starting Kimi Code Interface...</p><p class="info">Please wait — loading may take 30-60s on first visit</p>
<script>setTimeout(()=>location.reload(),5000)</script></div></body></html>`;

// ====== TCP HEALTH CHECK ======
function checkDaemon() {
  const sock = new net.Socket();
  sock.setTimeout(3000);
  sock.on('connect', () => { sock.destroy(); daemonAlive = true; });
  sock.on('error', () => { sock.destroy(); daemonAlive = false; });
  sock.on('timeout', () => { sock.destroy(); daemonAlive = false; });
  sock.connect(KIMI_PORT, '127.0.0.1');
}

// ====== KEEPALIVE — prevents Render from sleeping ======
function startKeepalive() {
  setInterval(() => {
    if (!myPublicUrl) return;
    // Use https to match Render's real protocol
    const url = myPublicUrl.replace(/^http:/, 'https:') + '/health';
    https.get(url, (res) => {
      log(`🔄 Keepalive ping: ${res.statusCode}`);
      res.resume();
    }).on('error', (e) => {
      log(`⚠️ Keepalive error: ${e.message}`);
    });
  }, 4 * 60 * 1000); // every 4 min
  log('✅ Keepalive enabled (4min interval, HTTPS)');
}

const FIXED_TOKEN = 'VNE1wpc7gqGD1THY-Np6WRPYdU5LlOrk3ICvxsy_N58';

// ====== ENSURE FIXED TOKEN FILE ======
function ensureFixedToken() {
  const kimiHome = process.env['KIMI_CODE_HOME'] || path.join(os.homedir(), '.kimi-code');
  const tokenPath = path.join(kimiHome, 'server.token');
  try { fs.mkdirSync(kimiHome, { recursive: true }); } catch(e) {}
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing === FIXED_TOKEN) {
      log(`🔑 Token file OK: ${tokenPath}`);
      return;
    }
  } catch(e) {}
  // Write fixed token to file
  fs.writeFileSync(tokenPath, FIXED_TOKEN, { mode: 0o600 });
  log(`🔑 Fixed token written: ${tokenPath}`);
}

// ====== START KIMI ======
function startKimi() {
  // Ensure fixed token before starting kimi
  ensureFixedToken();
  // Find kimi binary
  const kimiBin = ['node_modules/.bin/kimi', 'node_modules/@moonshot-ai/kimi-code/dist/main.mjs']
    .map(p => path.join(__dirname, p))
    .find(p => { try { return fs.existsSync(p); } catch(e) { return false; } }) || 'npx';

  // Force KIMI_CODE_PASSWORD — known token for login
  const kimiEnv = {
    ...process.env,
    HOME: process.env.HOME || '/root',
    KIMI_CODE_PASSWORD: process.env.KIMI_CODE_PASSWORD || FIXED_TOKEN,
  };

  // Use `server run --foreground` — never daemonizes, process stays alive
  const args = kimiBin === 'npx'
    ? ['@moonshot-ai/kimi-code', 'server', 'run', '--foreground', '--port', String(KIMI_PORT), '--host', '0.0.0.0', '--insecure-no-tls']
    : ['server', 'run', '--foreground', '--port', String(KIMI_PORT), '--host', '0.0.0.0', '--insecure-no-tls'];

  log(`Starting Kimi: ${kimiBin} ${args.join(' ')}`);
  log(`KIMI_CODE_PASSWORD: ${kimiEnv.KIMI_CODE_PASSWORD ? 'SET ✓' : 'NOT SET'}`);

  const proc = spawn(kimiBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: kimiEnv,
    cwd: __dirname,
    shell: kimiBin === 'npx'
  });

  kimiProc = proc;

  proc.stdout.on('data', d => {
    const t = d.toString();
    process.stdout.write(`[kimi] ${t}`);
    // Capture bearer token from stdout
    if (t.includes('bearer') || t.includes('token') || t.includes('Token') || t.includes('password')) {
      log(`🔑 AUTH: ${t.substring(0, 300).trim()}`);
    }
  });

  proc.stderr.on('data', d => {
    const t = d.toString();
    if (t.length > 5) log(`Kimi: ${t.substring(0, 300).trim()}`);
    process.stderr.write(`[kimi] ${t}`);
    // Capture token from stderr too
    if (t.includes('bearer') || t.includes('token') || t.includes('Token') || t.includes('password')) {
      log(`🔑 AUTH: ${t.substring(0, 300).trim()}`);
    }
  });

  proc.on('error', err => {
    log(`❌ Kimi spawn error: ${err.message}`);
    scheduleRestart();
  });

  proc.on('exit', (code, sig) => {
    kimiProc = null;
    daemonAlive = false;
    log(`⚠️ Kimi exited (code=${code}, signal=${sig}) — will restart in ${RESTART_DELAY_MS/1000}s`);
    scheduleRestart();
  });

  // First health check after 10s
  setTimeout(checkDaemon, 10000);
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    log('🔄 Auto-restarting Kimi...');
    startKimi();
  }, RESTART_DELAY_MS);
}

// ====== PENTARACT BACKUP / RESTORE ======

function pentaractLogin() {
  try {
    const result = execSync(`curl -s -X POST "${PENTARACT_URL}/api/auth/login" \
      -d "email=${encodeURIComponent(PENTARACT_EMAIL)}" -d "password=${encodeURIComponent(PENTARACT_PASS)}"`, {
      timeout: 15000, encoding: 'utf8'
    });
    const data = JSON.parse(result);
    if (!data.access_token) throw new Error('No access_token in response');
    return data.access_token;
  } catch (err) {
    throw new Error(`Pentaract login failed: ${err.message}`);
  }
}

function performBackup() {
  try {
    const token = pentaractLogin();
    const backupName = `kimi-code-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;
    const tarFile = `/tmp/${backupName}`;

    // Create tar.gz of ~/.kimi-code/ (skip logs/cache to keep it small)
    execSync(`tar -czf ${tarFile} --exclude='${KIMI_HOME}/logs' --exclude='${KIMI_HOME}/cache' \
      -C ${path.dirname(KIMI_HOME)} ${path.basename(KIMI_HOME)} 2>/dev/null`, { timeout: 30000 });

    const stats = fs.statSync(tarFile);

    // Upload to Pentaract via curl
    const uploadResult = execSync(`curl -s -X POST "${PENTARACT_URL}/api/files/${BACKUP_STORAGE_ID}/upload" \
      -H "Authorization: Bearer ${token}" \
      -F "file=@${tarFile}" -F "path=/backups/"`, { timeout: 60000, encoding: 'utf8' });

    // Cleanup temp file
    try { fs.unlinkSync(tarFile); } catch (e) {}

    lastBackupTime = new Date().toISOString();
    lastBackupSize = stats.size;
    lastBackupStatus = 'success';
    log(`✅ Backup completed: ${backupName} (${(stats.size / 1024).toFixed(1)} KB)`);
    return true;
  } catch (err) {
    lastBackupStatus = `failed: ${err.message}`;
    log(`❌ Backup failed: ${err.message}`);
    return false;
  }
}

function restoreLatestBackup() {
  try {
    const token = pentaractLogin();

    // List backup files
    const listResult = execSync(`curl -s "${PENTARACT_URL}/api/files/${BACKUP_STORAGE_ID}/tree?path=/backups/" \
      -H "Authorization: Bearer ${token}"`, { timeout: 15000, encoding: 'utf8' });
    const data = JSON.parse(listResult);

    if (!data.files || data.files.length === 0) {
      log('ℹ️ No backups found on Pentaract, skipping restore');
      return false;
    }

    // Sort by path descending to get latest backup
    data.files.sort((a, b) => b.path.localeCompare(a.path));
    const latest = data.files[0];

    log(`🔄 Restoring from: ${latest.path} (${(latest.size / 1024).toFixed(1)} KB)`);

    // Download backup (path already has slashes for FastAPI's {path:path} capture)
    execSync(`curl -s "${PENTARACT_URL}/api/files/${BACKUP_STORAGE_ID}/download/${latest.path}" \
      -H "Authorization: Bearer ${token}" -o /tmp/restore-kimi.tar.gz`, { timeout: 120000 });

    // Extract to root (tar preserves paths from ~/.kimi-code/)
    execSync(`tar -xzf /tmp/restore-kimi.tar.gz -C / && rm -f /tmp/restore-kimi.tar.gz`, { timeout: 30000 });

    log('✅ Restore completed successfully');
    return true;
  } catch (err) {
    log(`❌ Restore failed: ${err.message}`);
    return false;
  }
}

function checkAndRestore() {
  const sessionsDir = path.join(KIMI_HOME, 'sessions');
  let needsRestore = false;
  try {
    if (fs.existsSync(sessionsDir)) {
      const items = fs.readdirSync(sessionsDir);
      if (items.length === 0) needsRestore = true;
    } else {
      needsRestore = true;
    }
  } catch (e) {
    needsRestore = true;
  }
  if (needsRestore) {
    log('🔍 Sessions data missing, attempting restore from Pentaract...');
    restoreLatestBackup();
  } else {
    log('✅ Sessions data found locally, no restore needed');
  }
}

function startBackupScheduler() {
  log(`📅 Backup scheduler: every ${BACKUP_INTERVAL_MIN} minutes`);
  // First backup after 2 minutes (give Kimi time to start)
  setTimeout(() => {
    log('📤 Running initial backup...');
    performBackup();
  }, 120000);
  // Periodic backup
  setInterval(performBackup, BACKUP_INTERVAL_MIN * 60 * 1000);
}

// ====== HTTP SERVER ======
const server = http.createServer((req, res) => {
  // Record public URL from first external request
  if (!myPublicUrl && req.headers.host && !req.headers.host.includes('127.0.0.1') && !req.headers.host.includes('localhost')) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    myPublicUrl = `${proto}://${req.headers.host}`;
    log(`🌐 Public URL: ${myPublicUrl}`);
    // Fire an early keepalive ping to register the URL
    if (myPublicUrl) {
      const url = myPublicUrl + '/health';
      https.get(url, (res) => { res.resume(); }).on('error', () => {});
    }
  }

  // Debug endpoint
  if (req.url === '/kimi-debug') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    return res.end(debugLog.join('\n'));
  }

  // Health check
  if (req.url === '/health' || req.url === '/_health') {
    checkDaemon(); // fresh check on health endpoint
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({
      status: daemonAlive ? 'healthy' : 'starting',
      kimi_alive: daemonAlive,
      url: myPublicUrl || 'not yet',
      uptime: process.uptime(),
      kimi_process_alive: kimiProc !== null && !kimiProc.killed
    }));
  }

  // Backup status endpoint
  if (req.url === '/backup-status') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({
      last_backup: lastBackupTime,
      last_size_bytes: lastBackupSize,
      last_status: lastBackupStatus,
      storage_id: BACKUP_STORAGE_ID,
      pentaract_url: PENTARACT_URL,
      backup_interval_min: BACKUP_INTERVAL_MIN,
      kimi_home: KIMI_HOME
    }));
  }

  // Proxy to Kimi daemon
  if (daemonAlive) {
    const opts = {
      hostname: '127.0.0.1',
      port: KIMI_PORT,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${KIMI_PORT}`,
        'connection': 'close'
      }
    };

    const pr = http.request(opts, (prRes) => {
      const headers = { ...prRes.headers };
      delete headers['transfer-encoding'];
      res.writeHead(prRes.statusCode, headers);
      prRes.pipe(res);
    });

    pr.on('error', () => {
      daemonAlive = false;
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(STARTING_HTML);
    });

    req.pipe(pr);
    return;
  }

  // Not ready yet
  res.writeHead(200, {'Content-Type': 'text/html'});
  res.end(STARTING_HTML);
});

// ====== WebSocket Proxy for Kimi daemon (raw TCP tunnel) ======
server.on('upgrade', (req, socket, head) => {
  if (!daemonAlive) { socket.destroy(); return; }

  // Build the exact HTTP upgrade request to forward (override host)
  let reqLine = `${req.method} ${req.url} HTTP/1.1\r\n`;
  for (const [k, v] of Object.entries(req.headers)) {
    if (k !== 'host') reqLine += `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`;
  }
  reqLine += `host: 127.0.0.1:${KIMI_PORT}\r\n\r\n`;

  const proxySocket = net.connect(KIMI_PORT, '127.0.0.1', () => {
    proxySocket.write(reqLine);
    if (head && head.length) proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxySocket.on('error', () => { socket.destroy(); });
  socket.on('error', () => { proxySocket.destroy(); });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`=== Kimi Code Render v5 ===`);
  log(`Server on :${PORT}, Kimi on :${KIMI_PORT}`);
  startKimi();
  startKeepalive();
  // Check for restore after Kimi starts, then begin backups
  setTimeout(() => {
    checkAndRestore();
    startBackupScheduler();
  }, 20000); // 20s delay to let Kimi initialize
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down...');
  if (kimiProc && !kimiProc.killed) {
    kimiProc.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 3000);
});
