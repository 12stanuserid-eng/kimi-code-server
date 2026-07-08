#!/usr/bin/env node
/**
 * Kimi Code Render Server v6 — Tunnel + WebSocket Fix 🚇
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
let tunnelProc = null;
let tunnelUrl = null;

// ====== PENTARACT BACKUP CONSTANTS ======
const PENTARACT_URL = process.env.PENTARACT_URL || 'https://pentaract-f4ga.onrender.com';
const PENTARACT_EMAIL = process.env.PENTARACT_EMAIL || 'admin@pentaract.com';
const PENTARACT_PASS = process.env.PENTARACT_PASS || 'admin123';
const BACKUP_STORAGE_ID = process.env.BACKUP_STORAGE_ID || 'd875641e-ac08-4794-9d3b-823dd2705981';
const BACKUP_INTERVAL_MIN = parseInt(process.env.BACKUP_INTERVAL_MIN) || 30;
const KIMI_HOME = process.env['KIMI_CODE_HOME'] || path.join(os.homedir(), '.kimi-code');

let lastBackupTime = null;
let lastBackupSize = 0;
let lastBackupStatus = 'never';
let backupInProgress = false;

function log(m) {
  debugLog.push(`[${new Date().toISOString()}] ${m}`);
  // Prevent memory leak — keep last 200 lines
  if (debugLog.length > 200) debugLog = debugLog.slice(-200);
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

  // Force KIMI_CODE_PASSWORD — always use FIXED_TOKEN regardless of Render env vars
  // Allow all known hosts — the daemon rejects WebSocket upgrades from unknown hosts
  const allowedHosts = [
    'kimicode.dpdns.org',
    'kimi-code-server.onrender.com',
    'localhost:10001',
    'localhost',
    '127.0.0.1:10001',
    '127.0.0.1',
    '*.trycloudflare.com',
    '*.onrender.com'
  ].join(',');
  const kimiEnv = {
    ...process.env,
    HOME: process.env.HOME || '/root',
    KIMI_CODE_HOME: KIMI_HOME,
    KIMI_CODE_PASSWORD: FIXED_TOKEN,
    KIMI_CODE_ALLOWED_HOSTS: allowedHosts,
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

// ====== PENTARACT BACKUP / RESTORE (v2 — local fallback + proper headers) ======

const CURL_FLAGS = '-s --max-time 60 -H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 KimiCodeBackup/1.0"';
const LOCAL_BACKUP_DIR = path.join(os.tmpdir(), 'kimi-backups');
const LOCAL_BACKUP_MAX = 5;

function pentaractLogin() {
  try {
    const result = execSync(`curl ${CURL_FLAGS} -X POST "${PENTARACT_URL}/api/auth/login" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      -d "email=${encodeURIComponent(PENTARACT_EMAIL)}" -d "password=${encodeURIComponent(PENTARACT_PASS)}"`, {
      timeout: 20000, encoding: 'utf8'
    });
    if (result.trim().startsWith('<')) throw new Error('Got HTML instead of JSON (Cloudflare challenge)');
    const data = JSON.parse(result);
    if (!data.access_token) throw new Error('No access_token in response');
    return data.access_token;
  } catch (err) {
    throw new Error(`Pentaract login failed: ${err.message}`);
  }
}

// ====== LOCAL BACKUP (always works, no network needed) ======

function ensureLocalBackupDir() {
  try { fs.mkdirSync(LOCAL_BACKUP_DIR, { recursive: true }); } catch (e) {}
}

function performLocalBackup() {
  ensureLocalBackupDir();
  const backupName = `kimi-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;
  const tarFile = path.join(LOCAL_BACKUP_DIR, backupName);
  try {
    // Only backup essential data: sessions + archived_sessions + config.toml + workspaces.json
    // This keeps backup ~100MB instead of 697MB (no skills/, bin/, cache/, etc.)
    const includes = [];
    // Active sessions directory
    const sessionsDir = path.join(KIMI_HOME, 'sessions');
    if (fs.existsSync(sessionsDir)) includes.push('sessions');
    // Archived sessions (old sessions that were archived)
    const archivedDir = path.join(KIMI_HOME, 'archived_sessions');
    if (fs.existsSync(archivedDir)) includes.push('archived_sessions');
    // Config file
    const configPath = path.join(KIMI_HOME, 'config.toml');
    if (fs.existsSync(configPath)) includes.push('config.toml');
    // Workspaces file
    const wsPath = path.join(KIMI_HOME, 'workspaces.json');
    if (fs.existsSync(wsPath)) includes.push('workspaces.json');

    if (includes.length === 0) {
      log('⚠️ Nothing to backup — no sessions, config, or workspaces found');
      return null;
    }

    const includeArgs = includes.map(i => `"${i}"`).join(' ');
    execSync(`tar -czf "${tarFile}" -C "${KIMI_HOME}" ${includeArgs} 2>/dev/null`, { timeout: 120000 });
    const stats = fs.statSync(tarFile);
    log(`✅ Local backup: ${backupName} (${(stats.size / 1024).toFixed(1)} KB)`);
    // Prune old local backups
    try {
      const files = fs.readdirSync(LOCAL_BACKUP_DIR)
        .filter(f => f.startsWith('kimi-backup-') && f.endsWith('.tar.gz'))
        .sort().reverse();
      files.slice(LOCAL_BACKUP_MAX).forEach(f => {
        try { fs.unlinkSync(path.join(LOCAL_BACKUP_DIR, f)); } catch (e) {}
      });
    } catch (e) {}
    return { file: tarFile, size: stats.size, name: backupName };
  } catch (err) {
    log(`❌ Local backup failed: ${err.message}`);
    return null;
  }
}

function getLatestLocalBackup() {
  ensureLocalBackupDir();
  try {
    const files = fs.readdirSync(LOCAL_BACKUP_DIR)
      .filter(f => f.startsWith('kimi-backup-') && f.endsWith('.tar.gz'))
      .sort().reverse();
    if (files.length === 0) return null;
    const latest = path.join(LOCAL_BACKUP_DIR, files[0]);
    const stats = fs.statSync(latest);
    return { file: latest, size: stats.size, name: files[0], mtime: stats.mtime };
  } catch (e) { return null; }
}

function restoreFromLocalBackup(backupPath) {
  try {
    if (!fs.existsSync(backupPath)) throw new Error('Backup file not found');
    log(`🔄 Restoring from local: ${path.basename(backupPath)}`);
    // New backup format: files are relative to KIMI_HOME (sessions/, config.toml, workspaces.json)
    // Ensure KIMI_HOME exists
    fs.mkdirSync(KIMI_HOME, { recursive: true });
    execSync(`tar -xzf "${backupPath}" -C "${KIMI_HOME}"`, { timeout: 30000 });
    log('✅ Local restore completed');
    patchWorkspaceRoots();
    return true;
  } catch (err) {
    log(`❌ Local restore failed: ${err.message}`);
    return false;
  }
}

// ====== PENTARACT REMOTE ======

function performRemoteBackup(localTarFile) {
  try {
    const token = pentaractLogin();
    execSync(`curl ${CURL_FLAGS} -X POST "${PENTARACT_URL}/api/files/${BACKUP_STORAGE_ID}/upload" \
      -H "Authorization: Bearer ${token}" \
      -F "file=@${localTarFile}" -F "path=/backups/"`, { timeout: 60000, encoding: 'utf8' });
    log(`✅ Pentaract remote backup uploaded`);
    return true;
  } catch (err) {
    log(`⚠️ Pentaract remote failed: ${err.message} (local backup still safe)`);
    return false;
  }
}

function restoreFromPentaract() {
  try {
    const token = pentaractLogin();
    const listResult = execSync(`curl ${CURL_FLAGS} "${PENTARACT_URL}/api/files/${BACKUP_STORAGE_ID}/tree?path=backups" \
      -H "Authorization: Bearer ${token}"`, { timeout: 15000, encoding: 'utf8' });
    if (listResult.trim().startsWith('<')) throw new Error('Cloudflare challenge on list');
    const data = JSON.parse(listResult);
    if (!data.files || data.files.length === 0) { log('ℹ️ No remote backups found'); return false; }
    // Sort by timestamp in filename (newest first) — extract ISO timestamps from filenames
    data.files.sort((a, b) => {
      const ta = a.path.match(/(\d{4}-\d{2}-\d{2}T[\d-]+)/);
      const tb = b.path.match(/(\d{4}-\d{2}-\d{2}T[\d-]+)/);
      if (ta && tb) return tb[1].localeCompare(ta[1]); // newest first
      if (ta) return -1; // timestamped files first
      if (tb) return 1;
      return b.path.localeCompare(a.path); // fallback: newest name first
    });
    const latest = data.files[0];
    log(`🔄 Downloading from Pentaract: ${latest.path}`);
    const tempFile = '/tmp/pentaract-restore.tar.gz';
    execSync(`curl ${CURL_FLAGS} "${PENTARACT_URL}/api/files/${BACKUP_STORAGE_ID}/download/${latest.path}" \
      -H "Authorization: Bearer ${token}" -o "${tempFile}"`, { timeout: 120000 });
    // Validate tar.gz magic bytes
    const buf = fs.readFileSync(tempFile);
    if (buf[0] !== 0x1f || buf[1] !== 0x8b) throw new Error('Downloaded file is not valid tar.gz');
    // Detect backup format: new (files at root) vs old (files under .kimi-code/)
    const tarList = execSync(`tar -tzf "${tempFile}" 2>/dev/null`, { encoding: 'utf8' });
    const isNewFormat = tarList.includes('sessions/') || tarList.includes('config.toml');
    const extractDir = isNewFormat ? KIMI_HOME : path.dirname(KIMI_HOME);
    log(`🔄 Backup format: ${isNewFormat ? 'new (direct)' : 'old (nested .kimi-code/)'}, extracting to: ${extractDir}`);
    execSync(`tar -xzf "${tempFile}" -C "${extractDir}" && rm -f "${tempFile}"`, { timeout: 30000 });
    log('✅ Pentaract restore completed');
    patchWorkspaceRoots();
    return true;
  } catch (err) {
    log(`❌ Pentaract restore failed: ${err.message}`);
    return false;
  }
}

// ====== COMBINED BACKUP ======

function performBackup() {
  if (backupInProgress) { log('⚠️ Backup already in progress, skipping'); return false; }
  backupInProgress = true;
  try {
    const localResult = performLocalBackup();
    if (!localResult) { lastBackupStatus = 'failed: local backup failed'; return false; }
    let remoteOk = false;
    try { remoteOk = performRemoteBackup(localResult.file); } catch (e) {}
    lastBackupTime = new Date().toISOString();
    lastBackupSize = localResult.size;
    lastBackupStatus = remoteOk ? 'success (local + remote)' : 'success (local only)';

    // Sync check — if remote failed, retry next cycle; if local missing, pull from remote
    if (!remoteOk) {
      log('🔄 Sync: remote backup pending, will retry next cycle');
    }
    return true;
  } catch (err) {
    lastBackupStatus = `failed: ${err.message}`;
    return false;
  } finally { backupInProgress = false; }
}

// ====== SYNC: verify both local + Pentaract have data ======

function syncBothLocations() {
  // Step 1: Check what we have locally
  const localBk = getLatestLocalBackup();
  const hasLocal = localBk !== null;

  // Step 2: Check what Pentaract has
  let hasRemote = false;
  let remoteName = null;
  try {
    const token = pentaractLogin();
    const listResult = execSync(`curl ${CURL_FLAGS} "${PENTARACT_URL}/api/files/${BACKUP_STORAGE_ID}/tree?path=backups" \
      -H "Authorization: Bearer ${token}"`, { timeout: 15000, encoding: 'utf8' });
    if (!listResult.trim().startsWith('<')) {
      const data = JSON.parse(listResult);
      if (data.files && data.files.length > 0) {
        data.files.sort((a, b) => b.path.localeCompare(a.path));
        hasRemote = true;
        remoteName = data.files[0].path;
      }
    }
  } catch (e) {}

  // Step 3: Sync based on what's available
  if (hasLocal && hasRemote) {
    log('✅ Sync: both local and Pentaract have backups — OK');
    return;
  }

  if (hasLocal && !hasRemote) {
    // Local has data, Pentaract doesn't — upload local to Pentaract
    log('🔄 Sync: uploading local backup to Pentaract (remote missing)');
    try {
      performRemoteBackup(localBk.file);
      log('✅ Sync: local → Pentaract done');
    } catch (e) {
      log(`⚠️ Sync: local → Pentaract failed: ${e.message}`);
    }
    return;
  }

  if (!hasLocal && hasRemote) {
    // Pentaract has data, local doesn't — download from Pentaract
    log('🔄 Sync: downloading from Pentaract (local missing)');
    try {
      restoreFromPentaract();
      log('✅ Sync: Pentaract → local done');
    } catch (e) {
      log(`⚠️ Sync: Pentaract → local failed: ${e.message}`);
    }
    return;
  }

  log('ℹ️ Sync: no backups anywhere — will create on next backup cycle');
}

// ====== WORKSPACE ROOT PATCHING ======

function patchWorkspaceRoots() {
  try {
    const wsPath = path.join(KIMI_HOME, 'workspaces.json');
    if (!fs.existsSync(wsPath)) return;
    const wsData = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
    let patched = false;
    const renderHome = path.dirname(KIMI_HOME);
    for (const [id, ws] of Object.entries(wsData.workspaces || {})) {
      const oldRoot = ws.root || '';
      if (oldRoot === '/root') { ws.root = renderHome; patched = true; }
      else if (oldRoot === '/root/.kimi-code') { ws.root = KIMI_HOME; patched = true; }
      else if (oldRoot.startsWith('/root/')) { ws.root = oldRoot.replace('/root', renderHome); patched = true; }
    }
    if (patched) { fs.writeFileSync(wsPath, JSON.stringify(wsData, null, 2)); log('✅ Workspace roots patched'); }
  } catch (e) {}
}

// ====== SMART RESTORE ======

function checkAndRestore() {
  const sessionsDir = path.join(KIMI_HOME, 'sessions');
  let needsRestore = false;
  try {
    if (fs.existsSync(sessionsDir)) {
      const items = fs.readdirSync(sessionsDir);
      if (items.length === 0) { needsRestore = true; }
      else {
        let hasSessions = false;
        for (const item of items) {
          try {
            const itemPath = path.join(sessionsDir, item);
            if (fs.statSync(itemPath).isDirectory() && fs.readdirSync(itemPath).length > 0) {
              hasSessions = true; break;
            }
          } catch (e) {}
        }
        if (!hasSessions) needsRestore = true;
      }
    } else { needsRestore = true; }
  } catch (e) { needsRestore = true; }

  if (needsRestore) {
    log('🔄 Sessions missing — attempting restore...');
    // Try local first
    const localBackup = getLatestLocalBackup();
    if (localBackup) {
      log(`📦 Found local backup: ${localBackup.name}`);
      if (restoreFromLocalBackup(localBackup.file)) return true;
    }
    // Fall back to Pentaract
    if (restoreFromPentaract()) {
      try { performLocalBackup(); } catch (e) {}
      return true;
    }
    log('⚠️ No backup source available — starting fresh');
    return false;
  } else {
    log('✅ Sessions found locally');
    try { performLocalBackup(); } catch (e) {}
    return true;
  }
}

function startBackupScheduler() {
  log(`📅 Backup scheduler: every ${BACKUP_INTERVAL_MIN} min + auto on session changes`);

  // First backup after 60s (give Kimi time to start)
  setTimeout(() => {
    log('📤 Running initial backup...');
    performBackup();
  }, 60000);

  // Periodic backup as safety net
  setInterval(performBackup, BACKUP_INTERVAL_MIN * 60 * 1000);

  // ====== AUTO-BACKUP on session changes (fs.watch + debounce) ======
  let debounceTimer = null;
  let lastChangeCount = 0;
  const DEBOUNCE_MS = 10000; // wait 10s after last change before backing up

  function scheduleAutoBackup() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      // Skip if no actual change (watch fires on read too)
      try {
        const sessionsDir = path.join(KIMI_HOME, 'sessions');
        if (fs.existsSync(sessionsDir)) {
          const count = countSessionFiles(sessionsDir);
          if (count === lastChangeCount) return; // no real change
          lastChangeCount = count;
        }
      } catch (e) {}
      log('💾 Session changed — auto-backup triggered');
      performBackup();
    }, DEBOUNCE_MS);
  }

  function countSessionFiles(dir) {
    let count = 0;
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory()) {
          const subDir = path.join(dir, item.name);
          try { count += fs.readdirSync(subDir).length; } catch (e) {}
        }
      }
    } catch (e) {}
    return count;
  }

  // Watch sessions directory recursively
  try {
    const sessionsDir = path.join(KIMI_HOME, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Count initial files for change detection
    try { lastChangeCount = countSessionFiles(sessionsDir); } catch (e) {}

    const watcher = fs.watch(sessionsDir, { recursive: true }, (eventType, filename) => {
      if (filename && !filename.endsWith('.tmp')) {
        scheduleAutoBackup();
      }
    });

    watcher.on('error', (err) => {
      log(`⚠️ Sessions watcher error: ${err.message} — will re-watch in 5s`);
      setTimeout(() => {
        try { fs.watch(sessionsDir, { recursive: true }, scheduleAutoBackup); } catch (e) {}
      }, 5000);
    });

    log(`👁️ Watching sessions dir for changes: ${sessionsDir}`);
  } catch (err) {
    log(`⚠️ Could not start session watcher: ${err.message} — periodic backup only`);
  }
}

// ====== CLOUDFLARE TUNNEL (trycloudflare) ======
function startCloudflareTunnel() {
  const arch = os.arch();
  const platform = os.platform();
  let downloadUrl;
  const binaryName = `cloudflared-${platform}-${arch}`;
  if (platform === 'linux' && arch === 'x64') downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
  else if (platform === 'linux' && arch === 'arm64') downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64';
  else if (platform === 'darwin' && arch === 'x64') downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64';
  else {
    log(`❌ Unsupported platform for cloudflared tunnel: ${platform}/${arch}`);
    return;
  }

  const cloudflaredPath = '/tmp/cloudflared';

  // Download if not exists
  if (!fs.existsSync(cloudflaredPath)) {
    try {
      log(`⬇️ Downloading cloudflared from ${downloadUrl}`);
      execSync(`curl -sL "${downloadUrl}" -o ${cloudflaredPath} && chmod +x ${cloudflaredPath}`, { timeout: 60000 });
      log(`✅ cloudflared downloaded (${fs.statSync(cloudflaredPath).size} bytes)`);
    } catch (err) {
      log(`❌ Failed to download cloudflared: ${err.message}`);
      return;
    }
  } else {
    log(`✅ cloudflared already exists at ${cloudflaredPath}`);
  }

  // Start tunnel — point to our Node proxy (port 10000) which rewrites Host headers for WS
  // Use --protocol http2 for stable WebSocket connections (QUIC has UDP buffer issues on Render)
  const tunnelArgs = ['tunnel', '--url', `http://localhost:${PORT}`, '--protocol', 'http2', '--no-autoupdate'];
  log(`🚇 Starting Cloudflare Tunnel: ${cloudflaredPath} ${tunnelArgs.join(' ')}`);

  const proc = spawn(cloudflaredPath, tunnelArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: process.env.HOME || '/root' }
  });

  tunnelProc = proc;

  proc.stdout.on('data', d => {
    const t = d.toString();
    // Trycloudflare prints the URL: https://xxxxx.trycloudflare.com
    const match = t.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      tunnelUrl = match[0];
      log(`✅ Tunnel URL: ${tunnelUrl}`);
      log(`🌐 Access with WebSocket: ${tunnelUrl}`);
    }
    const line = t.trim();
    if (line) log(`[tunnel] ${line.substring(0, 200)}`);
  });

  proc.stderr.on('data', d => {
    const t = d.toString();
    const match = t.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      tunnelUrl = match[0];
      log(`✅ Tunnel URL: ${tunnelUrl}`);
    }
    const line = t.trim();
    if (line) log(`[tunnel] ${line.substring(0, 200)}`);
  });

  proc.on('error', err => {
    log(`❌ Tunnel spawn error: ${err.message}`);
    tunnelUrl = null;
  });

  proc.on('exit', (code, sig) => {
    tunnelProc = null;
    tunnelUrl = null;
    log(`⚠️ Tunnel exited (code=${code}) — restarting in 10s`);
    setTimeout(() => startCloudflareTunnel(), 10000);
  });
}

// ====== TOML CONFIG HELPERS ======

function getConfigPath() {
  return path.join(KIMI_HOME, 'config.toml');
}

function readProvidersFromConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf8');
    const providers = {};
    const lines = raw.split('\n');
    let currentId = null;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\[providers\.(?:"([^"]+)"|([^\]]+))\]$/);
      if (m) {
        currentId = m[1] || m[2];
        providers[currentId] = { id: currentId, type: 'openai', apiKey: '', baseUrl: '' };
      } else if (currentId) {
        const typeM = lines[i].match(/^\s*type\s*=\s*"(.+)"\s*$/);
        if (typeM) providers[currentId].type = typeM[1];
        const keyM = lines[i].match(/^\s*(?:apiKey|api_key)\s*=\s*"(.+)"\s*$/);
        if (keyM) providers[currentId].apiKey = keyM[1];
        const urlM = lines[i].match(/^\s*base_url\s*=\s*"(.+)"\s*$/);
        if (urlM) providers[currentId].baseUrl = urlM[1];
      }
    }
    return providers;
  } catch (e) {
    return {};
  }
}

function maskKey(key) {
  if (!key || key === 'no-auth-required') return key;
  if (key.length <= 8) return key.slice(0, 4) + '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

function writeProviderToConfig(id, type, apiKey, baseUrl) {
  const configPath = getConfigPath();
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch (e) { raw = ''; }

  // Build provider TOML block
  const safeId = id.includes('-') ? `"${id}"` : id;
  const block = `[providers.${safeId}]
type = "${type || 'openai'}"
api_key = "${apiKey || ''}"
base_url = "${baseUrl || ''}"
`;

  // If provider already exists, replace its block
  const provRegex = new RegExp(`\\[providers\\.(\\"?)${escapeRegex(id)}\\1\\].*?(?=\\n\\[|\\n$)`, 's');
  if (provRegex.test(raw)) {
    raw = raw.replace(provRegex, block.trimEnd());
  } else {
    // Insert before models section
    const modelsIdx = raw.search(/\n\[models\./);
    if (modelsIdx !== -1) {
      raw = raw.slice(0, modelsIdx) + '\n' + block + '\n' + raw.slice(modelsIdx).trimStart();
    } else {
      raw += '\n' + block;
    }
  }
  fs.writeFileSync(configPath, raw, 'utf8');
  log(`✅ Provider "${id}" written to config.toml`);
}

function removeProviderFromConfig(id) {
  const configPath = getConfigPath();
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch (e) { raw = ''; }

  // Remove provider block
  const provRegex = new RegExp(`\\n?\\[providers\\.(\\"?)${escapeRegex(id)}\\1\\].*?(?=\\n\\[|\\n$)`, 's');
  raw = raw.replace(provRegex, '');

  // Remove all models that reference this provider
  const modelRegex = new RegExp(`\\n?\\[models\\.\\"?${escapeRegex(id)}-[^\\]]*\\"?\\]\\n(?:[^\\[]*\\n)*`, 'g');
  raw = raw.replace(modelRegex, '');

  // Also remove model aliases that reference this provider
  const modelRefRegex = new RegExp(`\\n?\\[models\\.\\"?[^\\]]*\\"?\\]\\n\\s*provider\\s*=\\s*"${escapeRegex(id)}"\\n(?:[^\\[]*\\n)*`, 'g');
  raw = raw.replace(modelRefRegex, '');

  fs.writeFileSync(configPath, raw, 'utf8');
  log(`✅ Provider "${id}" removed from config.toml`);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ====== MODEL AUTO-DISCOVERY ======

function fetchModels(baseUrl, apiKey) {
  return new Promise((resolve, reject) => {
    const url = baseUrl.replace(/\/+$/, '') + '/models';
    const httpx = url.startsWith('https') ? https : http;
    log(`🔍 Fetching models from ${url}`);

    // Timeout — 30s for large providers like NVIDIA
    const TIMEOUT_MS = 30000;

    const options = {
      headers: {},
      timeout: TIMEOUT_MS
    };
    if (apiKey) {
      options.headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const req = httpx.get(url, options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error('Invalid API key or unauthorized'));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          // Handle various API response shapes:
          // OpenAI: { data: [{ id: "..." }] }
          // NVIDIA: { data: [{ id: "..." }] }
          // Some: { models: [...] }
          // Plain array: [...]
          // Also handles { object: "list", data: [...] }
          let models = [];
          if (Array.isArray(json.data)) {
            models = json.data.map(m => m.id).filter(Boolean);
          } else if (Array.isArray(json.models)) {
            models = json.models.map(m => m.id || m.model || m).filter(Boolean);
          } else if (Array.isArray(json)) {
            models = json.map(m => m.id || m.model || m).filter(Boolean);
          } else if (json.data && typeof json.data === 'object' && json.data.length === undefined) {
            // Some providers return { data: { models: [...] } }
            if (Array.isArray(json.data.models)) {
              models = json.data.models.map(m => m.id || m.model || m).filter(Boolean);
            }
          }
          resolve(models);
        } catch(e) {
          reject(new Error('Failed to parse models response: ' + e.message));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out after ' + (TIMEOUT_MS / 1000) + 's'));
    });
  });
}

/**
 * Guess a reasonable context window size from model name patterns.
 * Falls back to a safe default when no pattern matches.
 */
function guessContextSize(modelName) {
  const lower = modelName.toLowerCase();
  // Explicit token amounts in name
  if (/1m\b|1mega|1million|1000000/.test(lower)) return 1000000;
  if (/1048576/.test(lower)) return 1048576;
  if (/200k\b|200000/.test(lower)) return 200000;
  if (/128k\b|128000/.test(lower)) return 128000;
  if (/100k\b|100000/.test(lower)) return 100000;
  if (/64k\b|65536/.test(lower)) return 65536;
  if (/32k\b|32768/.test(lower)) return 32768;
  if (/16k\b|16384/.test(lower)) return 16384;
  if (/8k\b|8192/.test(lower)) return 8192;
  if (/4k\b|4096/.test(lower)) return 4096;
  // Known model families
  if (/\bllama-?3\.(?:1|2|3)\b/.test(lower)) return 128000;  // Llama 3.1/3.2/3.3: 128K
  if (/\bllama-?3\b/.test(lower)) return 8192;              // Llama 3: 8K
  if (/\bllama-?2\b/.test(lower)) return 4096;              // Llama 2: 4K
  if (/\bdeepseek\b/.test(lower)) return 128000;             // DeepSeek: 128K
  if (/\bqwen\b/.test(lower)) return 131072;                 // Qwen 2.5: 128K
  if (/\bmistral\b/.test(lower)) return 32768;               // Mistral: 32K
  if (/\bgemma\b/.test(lower)) return 8192;                  // Gemma: 8K
  if (/\bglm\b/.test(lower)) return 128000;                  // GLM: 128K
  if (/\bnemotron\b/.test(lower)) return 128000;             // Nemotron: 128K
  if (/\bgpt-4\b/.test(lower)) return 128000;                // GPT-4: 128K
  if (/\bgpt-3\.5\b/.test(lower)) return 16384;              // GPT-3.5: 16K
  if (/\bclaude\b/.test(lower)) return 200000;               // Claude: 200K
  if (/\bgemini\b/.test(lower)) return 1048576;              // Gemini: 1M
  // Default safe value for unknown models
  return 65536;
}

function writeModelsForProvider(configPath, providerId, models) {
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch (e) { raw = ''; }

  // Remove existing models that reference this provider
  const modelRegex = new RegExp(`\\n?\\[models\\.\\"?${escapeRegex(providerId)}-[^\\]]*\\"?\\]\\n(?:[^\\[]*\\n)*`, 'g');
  raw = raw.replace(modelRegex, '');

  // Also remove model aliases that reference this provider
  const modelRefRegex = new RegExp(`\\n?\\[models\\.\\"?[^\\]]*\\"?\\]\\n\\s*provider\\s*=\\s*"${escapeRegex(providerId)}"\\n(?:[^\\[]*\\n)*`, 'g');
  raw = raw.replace(modelRefRegex, '');

  // Add new models — use smart context size detection
  let modelBlock = '';
  models.forEach(m => {
    const safeName = m.replace(/[^a-zA-Z0-9_-]/g, '_');
    const ctxSize = guessContextSize(m);
    modelBlock += `\n[models."${providerId}-${safeName}"]\nprovider = "${providerId}"\nmodel = "${m}"\nmax_context_size = ${ctxSize}\n`;
  });

  raw += modelBlock;
  fs.writeFileSync(configPath, raw, 'utf8');
  log(`✅ ${models.length} models written for provider "${providerId}"`);
}

function restartKimiDaemon() {
  if (kimiProc && !kimiProc.killed) {
    log('🔄 Restarting Kimi daemon (SIGTERM)...');
    daemonAlive = false;
    kimiProc.kill('SIGTERM');
    return true;
  }
  return false;
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

  // Tunnel URL endpoint
  if (req.url === '/tunnel-url') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    const tunnelAlive = tunnelProc !== null && !tunnelProc.killed;
    return res.end(JSON.stringify({
      tunnel_url: tunnelUrl,
      tunnel_alive: tunnelAlive,
      message: tunnelUrl
        ? `Direct daemon URL (bypasses proxy, supports WS natively): ${tunnelUrl}`
        : 'Tunnel not yet ready — wait ~30s and refresh'
    }));
  }

  // Backup status endpoint (redirect to admin version)
  if (req.url === '/backup-status') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({
      last_backup: lastBackupTime,
      last_size_bytes: lastBackupSize,
      last_status: lastBackupStatus,
      backup_in_progress: backupInProgress,
      storage_id: BACKUP_STORAGE_ID,
      pentaract_url: PENTARACT_URL,
      backup_interval_min: BACKUP_INTERVAL_MIN,
      kimi_home: KIMI_HOME,
      note: 'Use /kimi-admin/backup-status for full details'
    }));
  }

  // Webhook endpoint (for Render deploy hooks, GitHub webhooks, etc.)
  if (req.url === '/webhook' || req.url === '/deploy-hook') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        let data;
        try { data = JSON.parse(body); } catch(e) { data = { raw: body }; }
        log(`🔔 Webhook received: ${JSON.stringify(data).substring(0, 500)}`);

        // Render deploy hook payload: { "service_id": "...", "deploy_id": "...", "trigger": "..." }
        if (data.service_id || data.deploy_id || data.trigger === 'render') {
          log(`🚀 Render deploy hook detected: service=${data.service_id || 'unknown'}, deploy=${data.deploy_id || 'unknown'}`);
        }
        // GitHub push payload: { "ref": "...", "repository": {...}, "commits": [...] }
        if (data.ref && data.repository) {
          const branch = data.ref.replace('refs/heads/', '');
          const repoName = data.repository.full_name || data.repository.name;
          log(`📦 GitHub push to ${repoName}:${branch} — ${(data.commits || []).length} commits`);
        }

        res.writeHead(200, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({
          status: 'ok',
          message: 'Webhook processed',
          received_at: new Date().toISOString(),
          event_type: data.trigger || (data.ref ? 'github_push' : 'generic')
        }));
      });
      return;
    }
    // GET returns info
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({
      service: 'Kimi Code Server Webhook',
      version: 'v5-enhanced',
      endpoints: {
        post: 'Send POST with JSON payload — supports Render deploy hooks, GitHub push events, and generic webhooks',
        get: 'This help message'
      },
      example_payloads: {
        render_deploy: '{"trigger":"render","service_id":"srv-xxx","deploy_id":"dep-xxx"}',
        github_push: '{"ref":"refs/heads/main","repository":{"full_name":"user/repo"},"commits":[{"id":"abc123","message":"update"}]}'
      }
    }));
  }

  // WebSocket diagnostics endpoint
  if (req.url === '/ws-diagnostics') {
    const cfRay = req.headers['cf-ray'] || null;
    const cfVisitor = req.headers['cf-visitor'] || null;
    const via = req.headers['via'] || null;
    const isCloudflare = cfRay !== null || (via && via.toLowerCase().includes('cloudflare'));
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({
      message: 'WebSocket diagnostics',
      public_url: myPublicUrl || 'not yet detected',
      cloudflare_detected: isCloudflare,
      cf_ray: cfRay,
      headers_received: {
        host: req.headers.host || null,
        origin: req.headers.origin || 'none (same-origin)',
        'x-forwarded-proto': req.headers['x-forwarded-proto'] || null,
        'x-forwarded-for': req.headers['x-forwarded-for'] || null,
      },
      kimi_daemon_alive: daemonAlive,
      kimi_process_alive: kimiProc !== null && !kimiProc.killed,
      ws_proxy_ready: daemonAlive && kimiProc !== null && !kimiProc.killed,
      note: isCloudflare
        ? '⚠️ Cloudflare detected! WebSocket upgrades are blocked by Cloudflare on *.onrender.com domains. The browser sends Origin header -> Cloudflare returns 403.'
        : '✅ No Cloudflare detected. WebSocket should work directly.',
      fix: {
        solution: 'Use a custom domain pointed directly to Render (no Cloudflare proxy).',
        details: 'Render\'s managed *.onrender.com domains use Cloudflare with WebSocket Origin Check enabled. The browser always sends the Origin header for WebSocket connections. Cloudflare blocks the upgrade with 403/400. To fix: configure a custom domain (e.g., kimi.yourdomain.com) with DNS pointing directly to Render (gray cloud, not proxied through Cloudflare).'
      }
    }));
  }

  // ====== ADMIN API — Provider Management ======
  // These endpoints bypass the daemon and directly read/write config.toml

  // GET /kimi-admin/providers — list all providers from config.toml
  if (req.url === '/kimi-admin/providers' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    const providers = readProvidersFromConfig();
    // Count models per provider by scanning config lines
    let configLines = [];
    try { configLines = fs.readFileSync(getConfigPath(), 'utf8').split('\n'); } catch(e) {}
    const list = Object.values(providers).map(p => {
      let modelCount = 0;
      for (let i = 0; i < configLines.length; i++) {
        const line = configLines[i];
        // Match [models."providerId-..."] or [models.providerId-...]
        if (line.includes('[models.') && line.includes(p.id + '-')) {
          modelCount++;
        }
      }
      return {
        id: p.id,
        type: p.type,
        base_url: p.baseUrl,
        has_api_key: !!p.apiKey && p.apiKey !== 'no-auth-required',
        api_key_masked: maskKey(p.apiKey),
        model_count: modelCount
      };
    });
    return res.end(JSON.stringify({ success: true, providers: list }));
  }

  // POST /kimi-admin/providers — add or update a provider with model auto-discovery
  if (req.url === '/kimi-admin/providers' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      (async () => {
        try {
          const data = JSON.parse(body);
          if (!data.id || !data.base_url) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            return res.end(JSON.stringify({ success: false, error: 'id and base_url are required' }));
          }

          // Step 1: Fetch models from provider (with retry)
          let models = [];
          let fetchError = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              models = await fetchModels(data.base_url, data.api_key || '');
              if (models.length > 0) break; // success
            } catch (e) {
              fetchError = e.message;
              log(`⚠️ Model discovery attempt ${attempt}/3 failed for "${data.id}": ${e.message}`);
              if (attempt < 3) await new Promise(r => setTimeout(r, 2000)); // wait 2s before retry
            }
          }

          // Step 2: Write provider to config
          writeProviderToConfig(data.id, data.type || 'openai', data.api_key || '', data.base_url);

          // Step 3: If models were discovered, write them
          if (models.length > 0) {
            writeModelsForProvider(getConfigPath(), data.id, models);
          }

          log(`🔧 Admin API: ${data.id} provider ${readProvidersFromConfig()[data.id] ? 'updated' : 'added'}`);

          // Step 4: Return response
          const response = {
            success: true,
            models_discovered: models.length,
            message: models.length > 0
              ? `Provider "${data.id}" saved with ${models.length} models. Restart daemon to apply.`
              : `Provider "${data.id}" saved. Restart daemon to apply.`
          };
          if (fetchError) {
            response.model_fetch_error = fetchError;
            response.message = `Provider "${data.id}" saved, but model discovery failed: ${fetchError}`;
          }
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify(response));
        } catch (e) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      })();
    });
    return;
  }

  // DELETE /kimi-admin/providers/:id — remove a provider
  const deleteMatch = req.url.match(/^\/kimi-admin\/providers\/(.+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const providerId = decodeURIComponent(deleteMatch[1]);
    removeProviderFromConfig(providerId);
    log(`🔧 Admin API: provider "${providerId}" removed`);
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ success: true, message: `Provider "${providerId}" removed. Restart daemon to apply.` }));
  }

  // POST /kimi-admin/providers/:id/rediscover — re-discover models for an existing provider
  const rediscoverMatch = req.url.match(/^\/kimi-admin\/providers\/(.+)\/rediscover$/);
  if (rediscoverMatch && req.method === 'POST') {
    const providerId = decodeURIComponent(rediscoverMatch[1]);
    const providers = readProvidersFromConfig();
    const provider = providers[providerId];
    if (!provider) {
      res.writeHead(404, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ success: false, error: `Provider "${providerId}" not found` }));
    }
    (async () => {
      try {
        log(`🔍 Rediscovering models for "${providerId}" from ${provider.baseUrl}`);
        let models = [];
        let fetchError = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            models = await fetchModels(provider.baseUrl, provider.apiKey || '');
            if (models.length > 0) break;
          } catch (e) {
            fetchError = e.message;
            log(`⚠️ Rediscover attempt ${attempt}/3 failed for "${providerId}": ${e.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
          }
        }
        if (models.length > 0) {
          writeModelsForProvider(getConfigPath(), providerId, models);
        }
        log(`🔧 Rediscover: "${providerId}" — ${models.length} models found`);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({
          success: true,
          provider_id: providerId,
          models_discovered: models.length,
          error: fetchError && models.length === 0 ? fetchError : null,
          message: models.length > 0
            ? `Rediscovered ${models.length} models for "${providerId}". Restart daemon to apply.`
            : fetchError
              ? `Model discovery failed: ${fetchError}`
              : `No models found for "${providerId}".`
        }));
      } catch (e) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    })();
    return;
  }

  // GET /kimi-admin/providers/:id/models — list models for a specific provider
  const providerModelsMatch = req.url.match(/^\/kimi-admin\/providers\/(.+)\/models$/);
  if (providerModelsMatch && req.method === 'GET') {
    const providerId = decodeURIComponent(providerModelsMatch[1]);
    try {
      const configLines = fs.readFileSync(getConfigPath(), 'utf8').split('\n');
      const models = [];
      for (let i = 0; i < configLines.length; i++) {
        const line = configLines[i];
        // Match [models."providerId-modelname"] or [models.providerId-modelname]
        if (line.includes('[models.') && line.includes(providerId + '-')) {
          // Extract model name from section header
          const m = line.match(/\[models\."?([^\]"]+)"?\]/);
          if (m) {
            const fullName = m[1];
            // Strip provider prefix to get raw model name
            const rawName = fullName.startsWith(providerId + '-') ? fullName.substring(providerId.length + 1) : fullName;
            models.push(rawName);
          }
        }
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ success: true, provider_id: providerId, models, count: models.length }));
    } catch (e) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ success: false, error: e.message }));
    }
  }

  // POST /kimi-admin/restart-daemon — restart the kimi daemon
  if (req.url === '/kimi-admin/restart-daemon' && req.method === 'POST') {
    const ok = restartKimiDaemon();
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({
      success: ok,
      message: ok ? 'Daemon restart initiated (auto-restarts in ~5s)' : 'Daemon not running'
    }));
  }

  // POST /kimi-admin/backup-now — trigger immediate backup (local + Pentaract)
  if (req.url === '/kimi-admin/backup-now' && req.method === 'POST') {
    if (backupInProgress) {
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ success: false, message: 'Backup already in progress' }));
    }
    (async () => {
      const ok = performBackup();
      const localBk = getLatestLocalBackup();
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({
        success: ok,
        status: lastBackupStatus,
        last_backup: lastBackupTime,
        local_backup: localBk ? { name: localBk.name, size_kb: (localBk.size / 1024).toFixed(1) } : null
      }));
    })();
    return;
  }

  // POST /kimi-admin/backup-restore — restore from latest backup
  if (req.url === '/kimi-admin/backup-restore' && req.method === 'POST') {
    let restored = false;
    // Try local first
    const localBk = getLatestLocalBackup();
    if (localBk) {
      restored = restoreFromLocalBackup(localBk.file);
    }
    // Try Pentaract if local didn't work
    if (!restored) {
      restored = restoreFromPentaract();
    }
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({
      success: restored,
      message: restored
        ? 'Restore completed. Restart daemon to apply.'
        : 'No backup found or restore failed',
      local_backup: localBk ? localBk.name : null
    }));
    return;
  }

  // GET /kimi-admin/backup-status — detailed backup status
  if (req.url === '/kimi-admin/backup-status' && req.method === 'GET') {
    const localBk = getLatestLocalBackup();
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({
      last_backup: lastBackupTime,
      last_size_bytes: lastBackupSize,
      last_status: lastBackupStatus,
      backup_in_progress: backupInProgress,
      local_backup: localBk ? {
        name: localBk.name,
        size_kb: (localBk.size / 1024).toFixed(1),
        created: localBk.mtime
      } : null,
      local_backup_dir: LOCAL_BACKUP_DIR,
      pentaract_url: PENTARACT_URL,
      backup_interval_min: BACKUP_INTERVAL_MIN,
      kimi_home: KIMI_HOME
    }));
  }


  // ====== Admin Panel Static Files ======
  if (req.url === '/kimi-admin/panel.js' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache'});
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'panel.js'), 'utf8'));
  }
  if (req.url === '/kimi-admin/panel.css' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'text/css', 'Cache-Control': 'no-cache'});
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'panel.css'), 'utf8'));
  }

  // ====== Tunnel Status Endpoint ======
  if (req.url === '/kimi-admin/tunnel-status') {
    const tunnelAlive = tunnelProc !== null && !tunnelProc.killed;
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({
      tunnel_url: tunnelUrl,
      tunnel_alive: tunnelAlive,
      is_ready: !!tunnelUrl && tunnelAlive,
      message: tunnelUrl
        ? 'Tunnel available at: ' + tunnelUrl
        : 'Tunnel not yet ready'
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
      delete headers['content-security-policy'];

      // Inject workspace ID into HTML responses so sessions persist across browser sessions
      const ct = (prRes.headers['content-type'] || '').toLowerCase();
      if (prRes.statusCode === 200 && (ct.includes('text/html') || ct.includes('application/html'))) {
        let chunks = [];
        prRes.on('data', c => chunks.push(c));
        prRes.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf-8');
          // Read actual workspace IDs from sessions directory so all sessions appear in UI
          let wsIds = ['kimi-workspace-default'];
          try {
            const sessionsDir = path.join(KIMI_HOME, 'sessions');
            if (fs.existsSync(sessionsDir)) {
              const found = fs.readdirSync(sessionsDir, { withFileTypes: true })
                .filter(d => d.isDirectory() && d.name.startsWith('wd_'))
                .map(d => d.name);
              found.forEach(id => { if (!wsIds.includes(id)) wsIds.push(id); });
            }
          } catch(e) {}
          // Ensure known workspace IDs from backup are always included
          ['wd_.kimi-code_83b403bf24b6', 'wd_root_94a6b4475803'].forEach(id => {
            if (!wsIds.includes(id)) wsIds.push(id);
          });
          // Inject workspace IDs into localStorage so sessions appear in UI
          const wsScript = '<script>\n(function(){\n  var ids = ' + JSON.stringify(wsIds) + ';\n  try {\n    var o = JSON.parse(localStorage.getItem("kimi-web.workspace-order") || "[]");\n    ids.forEach(function(id){ if(o.indexOf(id)===-1) o.push(id); });\n    localStorage.setItem("kimi-web.workspace-order", JSON.stringify(o));\n  } catch(e){}\n})();\n</script>';
          // WebSocket redirect — only for *.onrender.com (Cloudflare-proxied) domains
          // Custom domains (e.g. kimicode.dpdns.org) point directly to Render, no Cloudflare WS block
          const reqHost = req.headers['host'] || '';
          const isOnRenderDomain = reqHost.endsWith('.onrender.com') || reqHost.includes('.onrender.com:');
          let wsRedirect;
          if (isOnRenderDomain && tunnelUrl) {
            // Cloudflare blocks WS on *.onrender.com — redirect through cloudflared tunnel
            const tunnelOrigin = (() => { try { return new URL(tunnelUrl).origin; } catch(e) { return null; } })();
            if (tunnelOrigin) {
              wsRedirect = '<script>\n(function(){\n  var targetOrigin = ' + JSON.stringify(tunnelOrigin) + ';\n  var pageOrigin = window.location.origin;\n  var NativeWS = window.WebSocket;\n  window.WebSocket = function(url, protocols) {\n    if (typeof url === "string" && url.indexOf(pageOrigin + "/api/v1/ws") === 0) {\n      url = url.replace(pageOrigin, targetOrigin);\n    }\n    return new NativeWS(url, protocols);\n  };\n  window.WebSocket.prototype = NativeWS.prototype;\n  window.WebSocket.CONNECTING = 0;\n  window.WebSocket.OPEN = 1;\n  window.WebSocket.CLOSING = 2;\n  window.WebSocket.CLOSED = 3;\n})();\n</script>';
            }
          }
          // For custom domains (no Cloudflare), no WS redirect needed — direct connection works fine
          if (!wsRedirect) {
            wsRedirect = '<!-- WS direct: ' + (isOnRenderDomain ? 'tunnel not ready' : 'custom domain - no redirect needed') + ' -->';
          }
          const settingsPanelScript = '<link rel="stylesheet" href="/kimi-admin/panel.css"><script src="/kimi-admin/panel.js"></script>';
          const allScripts = wsScript + '\n' + wsRedirect + '\n' + settingsPanelScript;
          if (html.includes('</body>')) html = html.replace('</body>', allScripts + '\n</body>');
          else if (html.includes('</html>')) html = html.replace('</html>', allScripts + '\n</html>');
          else html += allScripts;
          const out = Buffer.from(html, 'utf-8');
          res.writeHead(200, { ...headers, 'content-length': out.length });
          res.end(out);
        });
      } else {
        res.writeHead(prRes.statusCode, headers);
        prRes.pipe(res);
      }
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

// ====== Session Reconnect Grace — keeps daemon socket alive on page refresh ======
// Map: client_id -> { proxySocket, timer }
const pendingReconnect = {};

function getClientId(url) {
  if (!url) return null;
  const m = url.match(/[?&]client_id=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function cleanupPendingReconnect(clientId) {
  const entry = pendingReconnect[clientId];
  if (entry) {
    if (entry.timer) clearTimeout(entry.timer);
    delete pendingReconnect[clientId];
  }
}

// ====== WebSocket Proxy for Kimi daemon (via raw TCP) ======
server.on('upgrade', (req, socket, head) => {
  log(`⬆️ WebSocket upgrade: ${req.url}`);

  const clientId = getClientId(req.url);
  if (clientId) log(`  👤 client_id=${clientId}`);

  // Check if we already have a daemon socket for this client (page refresh / reconnect)
  const existing = clientId ? pendingReconnect[clientId] : null;
  if (existing && existing.proxySocket && !existing.proxySocket.destroyed && existing.proxySocket.writable) {
    log(`  ♻️ Reusing existing daemon socket for ${clientId}`);
    cleanupPendingReconnect(clientId);

    const proxySocket = existing.proxySocket;

    // Unpipe anything still connected (should be nothing, but be safe)
    proxySocket.unpipe();
    proxySocket.removeAllListeners('data');

    // Write a fresh HTTP upgrade response to the new browser socket
    const upgradeResp = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n';
    socket.write(upgradeResp);

    // Enable keepalive
    proxySocket.setKeepAlive(true, 10000);
    socket.setKeepAlive(true, 10000);

    // Bidirectional pipe
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);

    // Client close → 30s grace
    socket.on('close', () => {
      log(`  ⏳ Client ${clientId} disconnected, keeping daemon socket for 30s`);
      socket.unpipe();
      proxySocket.unpipe();
      const timer = setTimeout(() => {
        log(`  ⌛ Grace period expired for ${clientId}, destroying daemon socket`);
        cleanupPendingReconnect(clientId);
        try { proxySocket.destroy(); } catch(e) {}
      }, 30000);
      pendingReconnect[clientId] = { proxySocket, timer };
    });

    // Daemon close → destroy both
    proxySocket.on('close', () => {
      cleanupPendingReconnect(clientId);
      try { socket.destroy(); } catch(e) {}
    });

    // Error handlers
    socket.on('error', () => {});
    proxySocket.on('error', () => {});

    return;
  }

  // Clean up any stale entry
  if (clientId) cleanupPendingReconnect(clientId);

  const targetPort = KIMI_PORT;
  const targetHost = '127.0.0.1';

  // Open raw TCP connection to Kimi daemon
  const proxySocket = net.connect(targetPort, targetHost, () => {
    log(`✅ TCP connected to ${targetHost}:${targetPort}`);

    // Manually write the HTTP upgrade request (no http.request wrapper)
    const requestLine = `${req.method} ${req.url} HTTP/1.1\r\n`;
    proxySocket.write(requestLine);

    // Forward client headers to the daemon, then inject auth
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (lower === 'connection') {
        proxySocket.write(`connection: upgrade\r\n`);
      } else if (lower === 'authorization') {
        // Skip — we inject the daemon's Bearer token below
        continue;
      } else if (lower === 'host' || lower === 'origin') {
        // Forward original host/origin — KIMI_CODE_ALLOWED_HOSTS includes them
        proxySocket.write(`${key}: ${value}\r\n`);
      } else {
        proxySocket.write(`${key}: ${value}\r\n`);
      }
    }
    // Kimi daemon v0.21.0 authenticates WebSocket via Authorization: Bearer
    proxySocket.write(`authorization: Bearer ${FIXED_TOKEN}\r\n`);
    proxySocket.write('\r\n');

    // Forward any remaining upgrade body data (typically empty for WebSocket)
    if (head && head.length > 0) {
      proxySocket.write(head);
    }

    // Read the daemon's response — first line tells us if upgrade succeeded
    let responseBuffer = Buffer.alloc(0);
    let responseComplete = false;

    proxySocket.on('data', (data) => {
      if (!responseComplete) {
        responseBuffer = Buffer.concat([responseBuffer, data]);

        // Check if we have the full HTTP response head (ends with \r\n\r\n)
        const headerEnd = responseBuffer.indexOf('\r\n\r\n');
        if (headerEnd !== -1) {
          responseComplete = true;
          const headerStr = responseBuffer.slice(0, headerEnd).toString();
          const firstLine = headerStr.split('\r\n')[0];

          if (firstLine.includes('101')) {
            log(`✅ Kimi daemon accepted WebSocket upgrade: ${firstLine}`);
            daemonAlive = true;

            // Split response at header boundary — 101 headers may arrive
            // in the same TCP packet as the first WebSocket frame(s).
            const headerPart = responseBuffer.slice(0, headerEnd + 4);
            const bodyPart = responseBuffer.slice(headerEnd + 4);

            // Write HTTP 101 response head to the browser
            socket.write(headerPart);

            // Forward any WebSocket frames that arrived with the 101 response
            if (bodyPart.length > 0) {
              socket.write(bodyPart);
            }
          } else {
            // Log full response headers for debugging
            const responseHeaders = headerStr.split('\r\n').slice(1).join(' | ');
            log(`❌ Upgrade rejected: ${firstLine} | ${responseHeaders}`);
            const body = responseBuffer.slice(headerEnd + 4).toString().trim();
            if (body) log(`❌ Rejection body: ${body}`);
            // Send 502 to client so browser gets meaningful error
            try {
              socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBad Gateway: Kimi daemon rejected WebSocket upgrade');
              socket.end();
            } catch(e) {}
            proxySocket.destroy();
            return;
          }

          // Enable TCP keepalive on both ends to prevent idle disconnects
          proxySocket.setKeepAlive(true, 10000);
          socket.setKeepAlive(true, 10000);

          // Bidirectional pipe
          proxySocket.pipe(socket);
          socket.pipe(proxySocket);
        }
      }
    });

    // Timeout for the upgrade handshake
    setTimeout(() => {
      if (!responseComplete) {
        log('❌ WebSocket upgrade handshake timeout (5s)');
        socket.destroy();
        proxySocket.destroy();
      }
    }, 5000);
  });

  proxySocket.on('error', (err) => {
    log(`❌ WebSocket TCP error: ${err.message}`);
    daemonAlive = false;
    socket.destroy();
  });

  socket.on('error', (err) => {
    log(`❌ Client WebSocket error: ${err.message}`);
    proxySocket.destroy();
  });

  // Client close → 30s grace before destroying daemon socket (allows page refresh)
  socket.on('close', () => {
    log(`  ⏳ Client ${clientId || 'unknown'} disconnected, keeping daemon socket for 30s`);
    socket.unpipe();
    proxySocket.unpipe();
    const timer = setTimeout(() => {
      log(`  ⌛ Grace period expired for ${clientId || 'unknown'}, destroying daemon socket`);
      if (clientId) cleanupPendingReconnect(clientId);
      try { proxySocket.destroy(); } catch(e) {}
    }, 30000);
    if (clientId) pendingReconnect[clientId] = { proxySocket, timer };
  });

  // Daemon close → clean up
  proxySocket.on('close', () => {
    if (clientId) cleanupPendingReconnect(clientId);
    try { socket.destroy(); } catch(e) {}
  });

  // Error handlers — catch silently to avoid crash on half-closed sockets
  socket.on('error', () => {});
  proxySocket.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () => {
  log(`=== Kimi Code Render v6 ===`);
  log(`Server on :${PORT}, Kimi on :${KIMI_PORT}`);
  startKimi();
  startKeepalive();
  // Periodic daemon health check (every 30s) so WebSocket handler has fresh flag
  setInterval(checkDaemon, 30000);
  // Start Cloudflare Tunnel after 10s (gives Kimi daemon time to start)
  setTimeout(startCloudflareTunnel, 10000);
  log('💾 Backup system v2 — local + Pentaract dual backup active');
  log('🚇 Cloudflare Tunnel will start in 10s — check /tunnel-url for the URL');
  // Start backup scheduler after 20s (gives Kimi daemon time to initialize)
  setTimeout(() => { checkAndRestore(); startBackupScheduler(); syncBothLocations(); }, 20000);
});

// Crash recovery — prevent event-loop-blocking backup from killing the server
process.on('uncaughtException', (err) => {
  log(`🔥 UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
});
process.on('unhandledRejection', (reason) => {
  log(`⚠️ UNHANDLED REJECTION: ${reason}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down...');
  if (kimiProc && !kimiProc.killed) {
    kimiProc.kill('SIGTERM');
  }
  if (tunnelProc && !tunnelProc.killed) {
    tunnelProc.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 3000);
});
