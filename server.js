#!/usr/bin/env node
/**
 * Kimi Code Render Server v6 — Tunnel + WebSocket Fix 🚇
 * - Uses `kimi server run` (no daemon mode — process stays alive)
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
// Use the already-running daemon on 58630 instead of spawning our own
const KIMI_PORT = parseInt(process.env.KIMI_PORT) || 58630;
const RESTART_DELAY_MS = 5000;

// Run setup.js as fallback (ensures config.toml exists, safe to call multiple times)
// Run as child process instead of require to avoid process.exit(0) killing us
try {
  const cp = require('child_process');
  cp.execSync('node ' + path.join(__dirname, 'setup.js'), { timeout: 15000, stdio: 'pipe' });
} catch(e) { /* setup may exit non-zero, that's ok */ }

let debugLog = [];
let daemonAlive = false;
let daemonFailCount = 0; // consecutive health check failures before marking dead
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
// Uses consecutive failure count to avoid flipping daemonAlive on transient errors
function checkDaemon() {
  const sock = new net.Socket();
  sock.setTimeout(3000);
  sock.on('connect', () => {
    sock.destroy();
    const wasDead = !daemonAlive;
    daemonFailCount = 0;
    if (wasDead) {
      log('✅ Daemon health check passed — marking alive');
      // Daemon recovered — restore session index if it was cleared
      try { recoverSessionIndex(); } catch(e) { log(`⚠️ Session index recovery failed: ${e.message}`); }
    }
    daemonAlive = true;
  });
  sock.on('error', () => {
    sock.destroy();
    daemonFailCount++;
    if (daemonFailCount >= 4 && daemonAlive) {
      log(`⚠️ Daemon health check failed ${daemonFailCount}x — marking dead`);
      daemonAlive = false;
    }
  });
  sock.on('timeout', () => {
    sock.destroy();
    daemonFailCount++;
    if (daemonFailCount >= 4 && daemonAlive) {
      log(`⚠️ Daemon health check timed out ${daemonFailCount}x — marking dead`);
      daemonAlive = false;
    }
  });
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
  // First check if an external daemon is already listening on KIMI_PORT
  // This handles both localhost (where daemon runs on :58630) and Render/RHEL environments
  try {
    const sock = new net.Socket();
    sock.setTimeout(2000);
    let externalFound = false;
    sock.on('connect', () => {
      sock.destroy();
      externalFound = true;
      log(`External daemon found on 127.0.0.1:${KIMI_PORT} — skipping spawn`);
      daemonAlive = true;
      setTimeout(checkDaemon, 2000);
    });
    sock.on('error', () => { sock.destroy(); });
    sock.on('timeout', () => { sock.destroy(); });
    sock.connect(KIMI_PORT, '127.0.0.1');
    // Wait up to 2.5s for the check, then proceed
    setTimeout(() => {
      if (!externalFound) {
        log(`No daemon on 127.0.0.1:${KIMI_PORT} — will spawn our own`);
        spawnKimiProcess();
      }
    }, 2500);
    return; // spawned either way via the timeout above
  } catch(e) {
    log(`Daemon detection error: ${e.message} — spawning own`);
  }
  spawnKimiProcess();
}

function spawnKimiProcess() {
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
    '.trycloudflare.com',
    '.onrender.com'
  ].join(',');
  const kimiEnv = {
    ...process.env,
    HOME: process.env.HOME || '/root',
    KIMI_CODE_HOME: KIMI_HOME,
    KIMI_CODE_PASSWORD: FIXED_TOKEN,
    KIMI_CODE_ALLOWED_HOSTS: allowedHosts,
    // Allow CORS origins for WebSocket through Cloudflare tunnel
    KIMI_CODE_CORS_ORIGINS: 'https://kimicode.dpdns.org,https://kimi-code-server.onrender.com',
  };

  // Use `server run` — never daemonizes, process stays alive
  const args = kimiBin === 'npx'
    ? ['@moonshot-ai/kimi-code', 'server', 'run', '--daemon', '--port', String(KIMI_PORT), '--host', '0.0.0.0', '--insecure-no-tls']
    : ['server', 'run', '--daemon', '--port', String(KIMI_PORT), '--host', '0.0.0.0', '--insecure-no-tls'];

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

const CURL_FLAGS = '-s --max-time 60 -H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" -H "Accept: application/json, text/plain, */*" -H "Accept-Language: en-US,en;q=0.9"';
const LOCAL_BACKUP_DIR = path.join(os.tmpdir(), 'kimi-backups');
const LOCAL_BACKUP_MAX = 5;

// ====== FAST COMPRESSION DETECTION (pigz > gzip) ======
// pigz = parallel gzip, uses all CPU cores, ~3x faster than single-thread gzip
// Output is gzip-compatible (same magic bytes), so restore works without changes
let _cachedCompressor = null;
function getBestCompressor() {
  if (_cachedCompressor) return _cachedCompressor;
  // Try pigz first (parallel gzip — uses all CPU cores, ~3x faster)
  try { execSync('which pigz', { stdio: 'ignore' }); _cachedCompressor = 'pigz'; log('🚀 Using pigz (parallel gzip — fast)'); return _cachedCompressor; } catch(e) {}
  // Fallback to gzip
  _cachedCompressor = 'gzip'; log('📦 Using gzip (default — slower)'); return _cachedCompressor;
}
// Returns tar --use-compress-program arg for spawning (no shell, direct args)
function getTarCompressArgs() {
  const c = getBestCompressor();
  if (c === 'pigz') return '--use-compress-program=pigz -1';
  return '--use-compress-program=gzip -1';
}

function pentaractLogin() {
  // Single attempt — no blocking retries (Cloudflare challenge is intermittent)
  // Blocking retries freeze the event loop and cause WebSocket drops
  try {
    const result = execSync(`curl -s --max-time 15 \
      -H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
      -H "Accept: application/json, text/plain, */*" \
      -H "Accept-Language: en-US,en;q=0.9" \
      -X POST "${PENTARACT_URL}/api/auth/login" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      -d "email=${encodeURIComponent(PENTARACT_EMAIL)}&password=${encodeURIComponent(PENTARACT_PASS)}"`, {
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
    const compressFlag = getTarCompressArgs();
    // Quote the compress flag for shell (it contains spaces like "gzip -1")
    execSync(`tar "${compressFlag}" -cf "${tarFile}" -C "${KIMI_HOME}" ${includeArgs} 2>/dev/null`, { timeout: 120000 });
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
    // Detect format: old backups have `.kimi-code/` prefix paths
    const tarList = execSync(`tar -tzf "${backupPath}" 2>/dev/null`, { encoding: 'utf8' });
    const firstPaths = tarList.trim().split('\n').slice(0, 5);
    const hasDotKimiPrefix = firstPaths.some(p => p.startsWith('.kimi-code/'));
    const extractDir = hasDotKimiPrefix ? path.dirname(KIMI_HOME) : KIMI_HOME;
    // Ensure KIMI_HOME exists
    fs.mkdirSync(KIMI_HOME, { recursive: true });
    // Preserve existing config.toml if it has providers
    const existingConfig = fs.existsSync(getConfigPath()) ? fs.readFileSync(getConfigPath(), 'utf8') : '';
    const hasExistingProviders = existingConfig.includes('[providers.');
    if (hasExistingProviders) {
      const tmpExtract = '/tmp/kimi-local-restore-tmp';
      fs.rmSync(tmpExtract, { recursive: true, force: true });
      fs.mkdirSync(tmpExtract, { recursive: true });
      execSync(`tar -xzf "${backupPath}" -C "${tmpExtract}"`, { timeout: 30000 });
      const extractedHome = hasDotKimiPrefix ? path.join(tmpExtract, '.kimi-code') : tmpExtract;
      if (fs.existsSync(extractedHome)) {
        for (const item of fs.readdirSync(extractedHome)) {
          if (item === 'config.toml') continue;
          const src = path.join(extractedHome, item);
          const dst = path.join(KIMI_HOME, item);
          fs.cpSync(src, dst, { recursive: true });
          log(`  Restored: ${item}`);
        }
      } else {
        log(`⚠️ Extracted home not found: ${extractedHome}`);
      }
      fs.rmSync(tmpExtract, { recursive: true, force: true });
    } else {
      execSync(`tar -xzf "${backupPath}" -C "${extractDir}"`, { timeout: 30000 });
    }
    // Fix nested paths and homedir references
    fixNestedSessionPaths(extractDir);
    fixSessionHomedirPaths();
    log('✅ Local restore completed');
    patchWorkspaceRoots();
    ensureWorkspaceMapping();
    regenerateSessionIndex();
    return true;
  } catch (err) {
    log(`❌ Local restore failed: ${err.message}`);
    return false;
  }
}

// ====== PENTARACT REMOTE (STREAMING — no temp file, no curl, zero deps) ======

function performRemoteBackupStreaming(token, includes) {
  return new Promise((resolve, reject) => {
    if (!includes || includes.length === 0) {
      return reject(new Error('No includes to backup'));
    }

    const boundary = '----KimiBackup' + crypto.randomBytes(16).toString('hex');
    const backupName = `kimi-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;

    // Build the non-file parts of the multipart body (known size)
    const pathField = `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n/backups/\r\n`;
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${backupName}"\r\nContent-Type: application/gzip\r\n\r\n`;
    const ending = `\r\n--${boundary}--\r\n`;

    // Spawn tar — use best available compressor (pigz/zstd/gzip)
    // Note: spawn passes args directly (no shell), so NO quotes around filenames
    const compressArg = getTarCompressArgs();
    const tarProc = spawn('tar', [
      compressArg,
      '-cf', '-', '-C', KIMI_HOME, ...includes
    ]);

    const tarStartMs = Date.now();

    tarProc.on('error', (err) => {
      log(`❌ tar spawn error: ${err.message}`);
      reject(err);
    });

    // HTTPS request with chunked transfer (no Content-Length needed for streaming)
    const parsedUrl = new URL(PENTARACT_URL);
    const options = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: `/api/files/${BACKUP_STORAGE_ID}/upload`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Transfer-Encoding': 'chunked',
        'User-Agent': 'KimiCodeBackup/2.0',
      },
      timeout: 60000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const elapsedMs = Date.now() - tarStartMs;
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log(`✅ Streaming upload done in ${elapsedMs}ms (${res.statusCode})`);
          resolve(true);
        } else {
          log(`⚠️ Streaming upload failed: HTTP ${res.statusCode} in ${elapsedMs}ms — ${data.substring(0, 300)}`);
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => {
      log(`❌ Streaming upload error: ${err.message}`);
      reject(err);
    });

    req.on('timeout', () => {
      log('❌ Streaming upload timed out (60s)');
      req.destroy();
      tarProc.kill('SIGTERM');
      reject(new Error('Upload timed out'));
    });

    // Write pre-file multipart fields
    req.write(pathField);
    req.write(fileHeader);

    // Pipe tar stdout directly into the HTTPS request body
    tarProc.stdout.pipe(req, { end: false });

    let tarFailed = false;

    // When tar process finishes, write the ending boundary and close the request
    tarProc.on('close', (code) => {
      if (tarFailed) return;
      if (code !== 0) {
        log(`❌ tar exited with code ${code}`);
        req.destroy();
        reject(new Error(`tar failed with code ${code}`));
        return;
      }
      // Write closing boundary — this signals end of multipart body
      req.write(ending);
      req.end();
    });

    tarProc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg && !msg.includes('tar:')) log(`[tar] ${msg.substring(0, 200)}`);
    });

    // Safety: if tar errors before stdout closes
    tarProc.on('error', (err) => {
      tarFailed = true;
      log(`❌ tar error: ${err.message}`);
      req.destroy();
      reject(err);
    });
  });
}

// Legacy fallback — uses curl (slower but reliable)
function performRemoteBackupCurl(localTarFile) {
  try {
    const token = pentaractLogin();
    execSync(`curl ${CURL_FLAGS} -X POST "${PENTARACT_URL}/api/files/${BACKUP_STORAGE_ID}/upload" \
      -H "Authorization: Bearer ${token}" \
      -F "file=@${localTarFile}" -F "path=/backups/"`, { timeout: 60000, encoding: 'utf8' });
    log(`✅ Pentaract remote backup uploaded (curl fallback)`);
    return true;
  } catch (err) {
    log(`⚠️ Pentaract remote failed: ${err.message}`);
    return false;
  }
}

function performRemoteBackup(localTarFile) {
  return performRemoteBackupCurl(localTarFile);
}

function restoreFromPentaract() {
  try {
    const token = pentaractLogin();
    const listResult = execSync(`curl ${CURL_FLAGS} "${PENTARACT_URL}/api/files/${BACKUP_STORAGE_ID}/tree?path=backups" \
      -H "Authorization: Bearer ${token}"`, { timeout: 15000, encoding: 'utf8' });
    if (listResult.trim().startsWith('<')) throw new Error('Cloudflare challenge on list');
    const data = JSON.parse(listResult);
    if (!data.files || data.files.length === 0) { log('ℹ️ No remote backups found'); return false; }
    // Filter to only tar.gz files — skip tiny (< 3KB = config-only), allow up to 100MB
    const backups = data.files.filter(f => f.path.endsWith('.tar.gz') && f.size > 3000 && f.size < 100000000);
    if (data.files.length > backups.length) log(`⚠️ Filtered out ${data.files.length - backups.length} backup files (size limits)`);
    if (backups.length === 0) { log('ℹ️ No valid backup files found'); return false; }
    // Sort by SIZE DESCENDING (largest first — most sessions, most complete backup)
    // This ensures we pick the clean/full backup (52KB) over partial ones (24KB)
    backups.sort((a, b) => b.size - a.size);
    // Try each backup until one works (some may be deleted from Telegram)
    const tempFile = '/tmp/pentaract-restore.tar.gz';
    for (let i = 0; i < Math.min(backups.length, 20); i++) {
      const bk = backups[i];
      log(`🔄 Trying backup ${i+1}/${Math.min(backups.length, 20)}: ${bk.path} (${(bk.size/1024).toFixed(1)}KB)`);
      try {
        execSync(`curl ${CURL_FLAGS} "${PENTARACT_URL}/api/files/${BACKUP_STORAGE_ID}/download/${bk.path}" \
          -H "Authorization: Bearer ${token}" -o "${tempFile}"`, { timeout: 120000 });
        const buf = fs.readFileSync(tempFile);
        if (buf[0] !== 0x1f || buf[1] !== 0x8b) { log(`⚠️ Not valid tar.gz: ${bk.path}`); continue; }
        // Check if it has sessions
        const tarList = execSync(`tar -tzf "${tempFile}" 2>/dev/null`, { encoding: 'utf8' });
        if (!tarList.includes('sessions/')) { log(`⚠️ No sessions in ${bk.path}, skipping`); continue; }
        // Detect format: old backups have `.kimi-code/` prefix paths
        const firstPaths = tarList.trim().split('\n').slice(0, 5);
        const hasDotKimiPrefix = firstPaths.some(p => p.startsWith('.kimi-code/'));
        const extractDir = hasDotKimiPrefix ? path.dirname(KIMI_HOME) : KIMI_HOME;
        log(`🔄 Restoring from ${bk.path} (format: ${hasDotKimiPrefix ? '.kimi-code prefix' : 'bare'})`);
        // Preserve existing config.toml if it has providers (don't overwrite custom providers)
        const existingConfig = fs.existsSync(getConfigPath()) ? fs.readFileSync(getConfigPath(), 'utf8') : '';
        const hasExistingProviders = existingConfig.includes('[providers.');
        if (hasExistingProviders) {
          // Extract to temp dir, then COPY only items that don't exist locally (NEVER overwrite)
          const tmpExtract = '/tmp/kimi-restore-tmp';
          fs.rmSync(tmpExtract, { recursive: true, force: true });
          fs.mkdirSync(tmpExtract, { recursive: true });
          execSync(`tar -xzf "${tempFile}" -C "${tmpExtract}"`, { timeout: 30000 });
          const extractedHome = hasDotKimiPrefix ? path.join(tmpExtract, '.kimi-code') : tmpExtract;
          let copiedCount = 0;
          if (fs.existsSync(extractedHome)) {
            for (const item of fs.readdirSync(extractedHome)) {
              if (item === 'config.toml') continue; // NEVER touch config
              const src = path.join(extractedHome, item);
              const dst = path.join(KIMI_HOME, item);
              // COPY-ONLY mode: agar local pe pehle se hai to SKIP, nahi hai to COPY karo
              if (item === 'sessions') {
                // Sessions: iterate workspace dirs, copy only new session dirs
                if (fs.existsSync(dst)) {
                  for (const wsName of fs.readdirSync(src)) {
                    const wsSrc = path.join(src, wsName);
                    const wsDst = path.join(dst, wsName);
                    if (!fs.existsSync(wsDst)) {
                      fs.cpSync(wsSrc, wsDst, { recursive: true });
                      copiedCount++;
                      log(`  Copied new workspace: ${wsName}`);
                    } else {
                      // Workspace exists, copy only new session dirs inside
                      for (const sessName of fs.readdirSync(wsSrc)) {
                        const sessSrc = path.join(wsSrc, sessName);
                        const sessDst = path.join(wsDst, sessName);
                        if (!fs.existsSync(sessDst)) {
                          fs.cpSync(sessSrc, sessDst, { recursive: true });
                          copiedCount++;
                          log(`  Copied new session: ${wsName}/${sessName}`);
                        }
                      }
                    }
                  }
                } else {
                  fs.cpSync(src, dst, { recursive: true });
                  copiedCount++;
                  log(`  Copied entire sessions dir`);
                }
              } else if (!fs.existsSync(dst)) {
                // Non-session items: only copy if doesn't exist locally
                fs.cpSync(src, dst, { recursive: true });
                log(`  Copied new: ${item}`);
              } else {
                log(`  Skipped existing: ${item}`);
              }
            }
          }
          fs.rmSync(tmpExtract, { recursive: true, force: true });
          log(`✅ Restore: copied ${copiedCount} new items, existing sessions untouched`);
        } else {
          execSync(`tar -xzf "${tempFile}" -C "${extractDir}"`, { timeout: 30000 });
        }
        try { fs.unlinkSync(tempFile); } catch(e) {}

        // Fix nested .kimi-code paths (old backups with sessions/root/.kimi-code/sessions/...)
        fixNestedSessionPaths(extractDir);

        // Fix homedir paths in state.json files to match current KIMI_HOME
        fixSessionHomedirPaths();

        log(`✅ Pentaract restore completed from ${bk.path}`);
        patchWorkspaceRoots();
        ensureWorkspaceMapping();
        regenerateSessionIndex();
        return true;
      } catch (err) {
        log(`⚠️ Failed to restore from ${bk.path}: ${err.message}`);
        try { fs.unlinkSync(tempFile); } catch(e) {}
      }
    }
    throw new Error('All backup downloads failed or had no sessions');
  } catch (err) {
    log(`❌ Pentaract restore failed: ${err.message}`);
    return false;
  }
}

// Fix old backups where sessions are nested inside sessions/root/.kimi-code/sessions/
function fixNestedSessionPaths(extractDir) {
  try {
    const nestedDir = path.join(KIMI_HOME, 'sessions', 'root', '.kimi-code', 'sessions');
    if (!fs.existsSync(nestedDir)) return; // no nested paths — nothing to fix
    log('🔧 Fixing nested session paths (old backup format)...');
    const wsDirs = fs.readdirSync(nestedDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const ws of wsDirs) {
      const targetWs = path.join(KIMI_HOME, 'sessions', ws.name);
      fs.mkdirSync(targetWs, { recursive: true });
      const srcWs = path.join(nestedDir, ws.name);
      const sessions = fs.readdirSync(srcWs, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const sess of sessions) {
        const targetSess = path.join(targetWs, sess.name);
        if (!fs.existsSync(targetSess)) {
          fs.cpSync(path.join(srcWs, sess.name), targetSess, { recursive: true });
        }
      }
      log(`  Moved ${sessions.length} sessions from nested path → ${ws.name}`);
    }
    // Clean up nested dir
    fs.rmSync(path.join(KIMI_HOME, 'sessions', 'root'), { recursive: true, force: true });
    log('✅ Nested paths fixed');
  } catch (err) {
    log(`⚠️ fixNestedSessionPaths failed: ${err.message}`);
  }
}

// Fix homedir paths in session state.json to match current KIMI_HOME
function fixSessionHomedirPaths() {
  try {
    const sessionsDir = path.join(KIMI_HOME, 'sessions');
    if (!fs.existsSync(sessionsDir)) return;
    let fixed = 0;
    const wsDirs = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const ws of wsDirs) {
      const wsPath = path.join(sessionsDir, ws.name);
      const sessDirs = fs.readdirSync(wsPath, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const sess of sessDirs) {
        const stateFile = path.join(wsPath, sess.name, 'state.json');
        if (!fs.existsSync(stateFile)) continue;
        try {
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          let changed = false;
          if (state.agents) {
            for (const [aid, agent] of Object.entries(state.agents)) {
              if (agent.homedir && !agent.homedir.startsWith(KIMI_HOME)) {
                agent.homedir = agent.homedir.replace(/\/root\/\.kimi-code/g, KIMI_HOME);
                changed = true;
              }
            }
          }
          if (changed) {
            fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
            fixed++;
          }
        } catch(e) {}
      }
    }
    if (fixed > 0) log(`✅ Fixed homedir paths in ${fixed} session state.json files`);
    // Also fix session_index.jsonl — must fix BOTH sessionDir and workDir paths
    const indexPath = path.join(KIMI_HOME, 'session_index.jsonl');
    if (fs.existsSync(indexPath)) {
      const lines = fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean);
      let idxFixed = 0;
      const newLines = lines.map(line => {
        try {
          const entry = JSON.parse(line);
          let changed = false;
          if (entry.sessionDir && !entry.sessionDir.startsWith(KIMI_HOME)) {
            entry.sessionDir = entry.sessionDir.replace(/\/root\/\.kimi-code/g, KIMI_HOME);
            changed = true;
          }
          if (entry.workDir && entry.workDir.startsWith('/root')) {
            const renderHome = path.dirname(KIMI_HOME);
            if (entry.workDir === '/root') {
              entry.workDir = renderHome;
            } else {
              entry.workDir = entry.workDir.replace(/^\/root\//, renderHome + '/');
            }
            changed = true;
          }
          if (changed) idxFixed++;
          return JSON.stringify(entry);
        } catch(e) { return line; }
      });
      if (idxFixed > 0) {
        fs.writeFileSync(indexPath, newLines.join('\n') + '\n');
        log(`✅ Fixed ${idxFixed} session_index.jsonl paths`);
      }
    }
  } catch (err) {
    log(`⚠️ fixSessionHomedirPaths failed: ${err.message}`);
  }
}

// ====== REGENERATE SESSION INDEX ======
// The daemon uses session_index.jsonl to list sessions via the API.
// If it's missing or empty after a restore, the API returns 0 sessions.
// This function rebuilds it from the sessions directory on disk.
//
// CRITICAL: The daemon's readSessionIndex() requires exactly these fields:
//   { sessionId, sessionDir, workDir }
// - sessionDir must be an absolute path inside the sessions/ directory
// - workDir must be an absolute path to the workspace root (NOT workspaceId!)
// - basename(sessionDir) must equal sessionId
function regenerateSessionIndex() {
  try {
    const sessionsDir = path.join(KIMI_HOME, 'sessions');
    const indexPath = path.join(KIMI_HOME, 'session_index.jsonl');
    if (!fs.existsSync(sessionsDir)) {
      log('⚠️ regenerateSessionIndex: sessions dir not found');
      return;
    }

    log('🔧 [regenerateSessionIndex] Starting...');

    // ═══ BACKUP existing session_index.jsonl BEFORE regenerating ═══
    // This ensures we can always recover if something goes wrong
    try {
      const currentIndex = fs.readFileSync(indexPath, 'utf8').trim();
      if (currentIndex.length > 0) {
        fs.writeFileSync(SESSION_INDEX_BACKUP, currentIndex, 'utf8');
        log(`💾 Backed up existing session_index.jsonl before regeneration (${currentIndex.split('\n').length} entries)`);
      }
    } catch(e) {
      log(`⚠️ Could not backup existing session index: ${e.message}`);
    }

    // Read workspaces.json to map bucket IDs → workspace root paths (workDir)
    const wsMap = {}; // bucketId -> workDir (absolute path)
    try {
      const wsPath = path.join(KIMI_HOME, 'workspaces.json');
      if (fs.existsSync(wsPath)) {
        const wsData = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
        for (const [id, ws] of Object.entries(wsData.workspaces || {})) {
          if (ws.root) wsMap[id] = ws.root;
        }
        log(`🔧 [regenerateSessionIndex] Loaded ${Object.keys(wsMap).length} workspace mappings from workspaces.json`);
      } else {
        log('⚠️ [regenerateSessionIndex] workspaces.json not found');
      }
    } catch(e) {
      log(`⚠️ [regenerateSessionIndex] Could not read workspaces.json: ${e.message}`);
    }

    // Detect the current workspace root (CWD of kimi daemon)
    const currentWorkDir = path.dirname(KIMI_HOME); // /opt/render on Render, /root on local

    const entries = [];
    let skipped = 0;
    const wsDirs = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    log(`🔧 [regenerateSessionIndex] Found ${wsDirs.length} workspace directories`);
    for (const ws of wsDirs) {
      const wsPath = path.join(sessionsDir, ws.name);
      // Look up workDir for this bucket — must be absolute path
      let workDir = wsMap[ws.name];
      if (!workDir) {
        // Fallback: try to derive workDir from workspace hash name
        // Format: wd_<dirname>_<hash> → <dirname> is the workspace type
        const parts = ws.name.replace(/^wd_/, '').split('_');
        const wsType = parts[0]; // e.g., 'render', 'tmp', 'root', '.kimi-code'
        // Map known workspace types to actual paths
        if (wsType === 'render' || wsType === 'tmp') {
          workDir = path.join(currentWorkDir, 'project', 'src'); // Render workspace
        } else if (wsType === 'root') {
          workDir = currentWorkDir; // Use currentWorkDir (path.dirname(KIMI_HOME)) — not hardcoded /root
        } else if (wsType === '.kimi-code' || wsType === 'kimi-code') {
          workDir = path.dirname(KIMI_HOME);
        } else {
          workDir = currentWorkDir; // generic fallback
        }
        log(`🔧 [regenerateSessionIndex] No workspaces.json entry for "${ws.name}" — using derived path: ${workDir}`);
      }
      const sessDirs = fs.readdirSync(wsPath, { withFileTypes: true }).filter(d => d.isDirectory());
      log(`🔧 [regenerateSessionIndex] Workspace "${ws.name}" has ${sessDirs.length} sessions`);
      for (const sess of sessDirs) {
        const sessionDir = path.join(wsPath, sess.name);
        // Daemon requires: basename(sessionDir) === sessionId
        // Also requires sessionDir and workDir to be absolute paths
        entries.push({
          sessionId: sess.name,
          sessionDir: sessionDir,
          workDir: workDir,
        });
      }
    }
    // Write entries — daemon expects exactly: {"sessionId":"...","sessionDir":"...","workDir":"..."}
    fs.writeFileSync(indexPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    log(`✅ [regenerateSessionIndex] Regenerated session_index.jsonl with ${entries.length} sessions (workDir mapped for ${Object.keys(wsMap).length} workspaces)`);
  } catch (err) {
    log(`⚠️ [regenerateSessionIndex] failed: ${err.message}`);
  }
}

// ====== SESSION INDEX PROTECTION ======
// Backs up session_index.jsonl before daemon restart, and recovers it if daemon clears it.
const SESSION_INDEX_BACKUP = path.join(KIMI_HOME, 'session_index.jsonl.bak');

function backupSessionIndex() {
  const indexPath = path.join(KIMI_HOME, 'session_index.jsonl');
  try {
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, 'utf8');
      if (content.trim().length > 0) {
        fs.writeFileSync(SESSION_INDEX_BACKUP, content, 'utf8');
        log(`💾 Session index backed up (${content.trim().split('\n').length} sessions)`);
      }
    }
  } catch(e) {
    log(`⚠️ Session index backup failed: ${e.message}`);
  }
}

function recoverSessionIndex() {
  const indexPath = path.join(KIMI_HOME, 'session_index.jsonl');
  try {
    // Check if session index is missing or empty
    let needsRecovery = false;
    if (!fs.existsSync(indexPath)) {
      needsRecovery = true;
      log('⚠️ session_index.jsonl missing — will recover');
    } else {
      const content = fs.readFileSync(indexPath, 'utf8').trim();
      if (content.length === 0) {
        needsRecovery = true;
        log('⚠️ session_index.jsonl is empty — will recover');
      }
    }

    if (needsRecovery) {
      // First try regenerating from disk
      try {
        regenerateSessionIndex();
        const retryContent = fs.readFileSync(indexPath, 'utf8').trim();
        if (retryContent.length > 0) {
          log('✅ Session index recovered via regenerateSessionIndex()');
          return;
        }
      } catch(e) {
        log(`⚠️ regenerateSessionIndex() for recovery failed: ${e.message}`);
      }

      // Fallback: restore from .bak file
      if (fs.existsSync(SESSION_INDEX_BACKUP)) {
        const bakContent = fs.readFileSync(SESSION_INDEX_BACKUP, 'utf8');
        if (bakContent.trim().length > 0) {
          fs.writeFileSync(indexPath, bakContent, 'utf8');
          log(`✅ Session index restored from backup (${bakContent.trim().split('\n').length} sessions)`);
          return;
        }
      }
      log('⚠️ Session index recovery failed — no backup available');
    }
  } catch(e) {
    log(`⚠️ Session index recovery error: ${e.message}`);
  }
}

// ====== COMBINED BACKUP ======

function performBackup() {
  if (backupInProgress) { log('⚠️ Backup already in progress, skipping'); return false; }
  backupInProgress = true;
  (async () => {
    try {
      // Compute what to backup (same logic as performLocalBackup)
      const includes = [];
      const sessionsDir = path.join(KIMI_HOME, 'sessions');
      if (fs.existsSync(sessionsDir)) includes.push('sessions');
      const archivedDir = path.join(KIMI_HOME, 'archived_sessions');
      if (fs.existsSync(archivedDir)) includes.push('archived_sessions');
      const configPath = path.join(KIMI_HOME, 'config.toml');
      if (fs.existsSync(configPath)) includes.push('config.toml');
      const wsPath = path.join(KIMI_HOME, 'workspaces.json');
      if (fs.existsSync(wsPath)) includes.push('workspaces.json');

      if (includes.length === 0) {
        log('⚠️ Nothing to backup');
        lastBackupStatus = 'nothing to backup';
        return;
      }

      // Strategy 1: Streaming upload (fastest — no temp file, no curl)
      let remoteOk = false;
      let localResult = null;
      try {
        const token = pentaractLogin();
        log('🚀 Starting streaming upload...');
        const streamStart = Date.now();
        remoteOk = await performRemoteBackupStreaming(token, includes);
        const streamMs = Date.now() - streamStart;
        log(`🚀 Streaming upload completed in ${streamMs}ms`);
        // Still create local backup as safety net (async, non-blocking)
        localResult = performLocalBackup();
      } catch (streamErr) {
        log(`⚠️ Streaming upload failed: ${streamErr.message} — trying curl fallback`);
        // Strategy 2: Local backup + curl upload (fallback)
        localResult = performLocalBackup();
        if (localResult) {
          try { remoteOk = performRemoteBackupCurl(localResult.file); } catch (e) {}
        }
      }

      if (!localResult) localResult = getLatestLocalBackup(); // may have been created earlier
      lastBackupTime = new Date().toISOString();
      lastBackupSize = localResult ? localResult.size : 0;
      lastBackupStatus = remoteOk ? 'success (local + remote)' : 'success (local only)';

      if (!remoteOk) {
        log('🔄 Sync: remote backup pending, will retry next cycle');
      }
    } catch (err) {
      lastBackupStatus = `failed: ${err.message}`;
    } finally { backupInProgress = false; }
  })();
  return true; // async — returns immediately
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

// ====== ENSURE WORKSPACE MAPPING ======
// After restore, ensure every workspace hash in sessions/ has a mapping in workspaces.json
function ensureWorkspaceMapping() {
  try {
    const sessionsDir = path.join(KIMI_HOME, 'sessions');
    if (!fs.existsSync(sessionsDir)) return;

    const wsPath = path.join(KIMI_HOME, 'workspaces.json');
    let wsData = { workspaces: {} };
    try {
      if (fs.existsSync(wsPath)) wsData = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
      if (!wsData.workspaces) wsData.workspaces = {};
    } catch(e) {}

    const renderHome = path.dirname(KIMI_HOME); // /opt/render on Render
    const currentWorkDir = path.join(renderHome, 'project', 'src'); // kimi daemon CWD on Render

    let added = 0;
    const wsDirs = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const ws of wsDirs) {
      if (wsData.workspaces[ws.name]) continue; // already mapped

      // Derive workDir from workspace hash name
      const parts = ws.name.replace(/^wd_/, '').split('_');
      const wsType = parts[0];
      let workDir;
      if (wsType === 'render' || wsType === 'tmp') {
        workDir = currentWorkDir;
      } else if (wsType === 'root') {
        workDir = renderHome; // Use renderHome (path.dirname(KIMI_HOME)) — not hardcoded /root
      } else if (wsType === '.kimi-code' || wsType === 'kimi-code') {
        workDir = path.dirname(KIMI_HOME);
      } else {
        workDir = renderHome;
      }

      wsData.workspaces[ws.name] = {
        id: ws.name,
        root: workDir,
        name: ws.name
      };
      added++;
      log(`🔧 Added workspace mapping: ${ws.name} → ${workDir}`);
    }

    if (added > 0) {
      fs.writeFileSync(wsPath, JSON.stringify(wsData, null, 2));
      log(`✅ Added ${added} workspace mappings to workspaces.json`);
    }
  } catch (err) {
    log(`⚠️ ensureWorkspaceMapping failed: ${err.message}`);
  }
}

// ====== SMART RESTORE ======

function checkAndRestore() {
  const sessionsDir = path.join(KIMI_HOME, 'sessions');
  let needsRestore = false;
  let totalSessionCount = 0;
  try {
    if (fs.existsSync(sessionsDir)) {
      const items = fs.readdirSync(sessionsDir);
      if (items.length === 0) { needsRestore = true; }
      else {
        let hasSessions = false;
        for (const item of items) {
          try {
            const itemPath = path.join(sessionsDir, item);
            if (fs.statSync(itemPath).isDirectory()) {
              const sess = fs.readdirSync(itemPath);
              totalSessionCount += sess.length;
              if (sess.length > 0) hasSessions = true;
            }
          } catch (e) {}
        }
        // Only restore if truly empty — existing sessions must NEVER be deleted
        if (!hasSessions) needsRestore = true;
      }
    } else { needsRestore = true; }
  } catch (e) { needsRestore = true; }

  if (needsRestore) {
    log('🔄 Sessions missing — attempting restore...');
    // Try local first (no blocking retries)
    const localBackup = getLatestLocalBackup();
    if (localBackup && localBackup.size >= 1000) {
      log(`📦 Found local backup: ${localBackup.name} (${(localBackup.size/1024).toFixed(1)}KB)`);
      if (restoreFromLocalBackup(localBackup.file)) {
        if (!daemonAlive) {
          log('🔄 Restarting daemon (was dead)...');
          restartKimiDaemon();
        } else {
          log('✅ Restore done, daemon alive — no restart needed');
        }
        return true;
      }
    }
    // Pentaract — single attempt (no blocking retries that freeze event loop)
    log('🔄 Pentaract restore attempt...');
    if (restoreFromPentaract()) {
      try { performLocalBackup(); } catch (e) {}
      if (!daemonAlive) {
        log('🔄 Restarting daemon (was dead)...');
        restartKimiDaemon();
      }
      return true;
    }
    log('⚠️ Restore failed — sessions will be created new');
    return false;
  } else {
    log(`✅ ${totalSessionCount} sessions found locally in ${fs.readdirSync(sessionsDir).length} workspaces, skipping full restore`);
    // ALWAYS regenerate session index to ensure all sessions appear in UI
    const indexPath = path.join(KIMI_HOME, 'session_index.jsonl');
    try {
      log('🔧 Ensuring workspace mapping before session index regeneration...');
      ensureWorkspaceMapping();
      log('🔄 Regenerating session_index.jsonl...');
      regenerateSessionIndex();
      log('✅ Session index regenerated successfully');
    } catch(e) {
      log(`⚠️ Session index regeneration failed: ${e.message}`);
    }
    try { performLocalBackup(); } catch (e) {}
    return true;
  }
}

// ====== DELAYED RESTORE RETRIES ======
// If initial restore fails, retry once after 5min (single attempt, no restart loops)
function scheduleDelayedRestoreAttempts() {
  // Only retry ONCE after 5 minutes — multiple retries cause daemon restart loops
  const RETRY_DELAY = 5 * 60 * 1000; // 5min
  let attempted = false;

  function tryRestore() {
    if (attempted) return; // already tried
    attempted = true;

    // Check if sessions already exist (maybe another restore succeeded)
    const sessionsDir = path.join(KIMI_HOME, 'sessions');
    try {
      if (fs.existsSync(sessionsDir)) {
        const items = fs.readdirSync(sessionsDir);
        for (const item of items) {
          try {
            const itemPath = path.join(sessionsDir, item);
            if (fs.statSync(itemPath).isDirectory() && fs.readdirSync(itemPath).length > 0) {
              log(`✅ Sessions already present — skipping delayed restore`);
              return; // sessions exist, no need to restore
            }
          } catch (e) {}
        }
      }
    } catch (e) {}

    log(`🔄 Delayed restore attempt (single retry after 5min)...`);
    if (restoreFromPentaract()) {
      try { performLocalBackup(); } catch (e) {}
      // Only restart if daemon is dead — don't disrupt active connections
      if (!daemonAlive) {
        log('🔄 Restarting daemon after delayed Pentaract restore...');
        restartKimiDaemon();
      }
      return;
    }
    log('⚠️ Delayed restore failed — sessions will be created fresh');
  }

  log(`📅 Scheduled single delayed restore in ${RETRY_DELAY/1000}s`);
  setTimeout(tryRestore, RETRY_DELAY);
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
  // Use HTTP/1.1 (default) — HTTP/2 blocks WebSocket Upgrade mechanism
  const tunnelArgs = ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'];
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

  // Remove existing models that reference this provider (match both - and _ separators)
  const modelRegex = new RegExp(`\\n?\\[models\\.\\"?${escapeRegex(providerId)}[-_][^\\]]*\\"?\\]\\n(?:[^\\[]*\\n)*`, 'g');
  raw = raw.replace(modelRegex, '');

  // Also remove model aliases that reference this provider
  const modelRefRegex = new RegExp(`\\n?\\[models\\.\\"?[^\\]]*\\"?\\]\\n\\s*provider\\s*=\\s*"${escapeRegex(providerId)}"\\n(?:[^\\[]*\\n)*`, 'g');
  raw = raw.replace(modelRefRegex, '');

  // Add new models — use smart context size detection
  // NOTE: Daemon expects model key = providerId + '_' + sanitized_basename_of_model
  // where basename is the part after the last '/' in the model name.
  let modelBlock = '';
  models.forEach(m => {
    const baseName = m.includes('/') ? m.split('/').pop() : m;
    const safeName = baseName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const ctxSize = guessContextSize(m);
    modelBlock += `\n[models."${providerId}_${safeName}"]\nprovider = "${providerId}"\nmodel = "${m}"\nmax_context_size = ${ctxSize}\n`;
  });

  raw += modelBlock;
  fs.writeFileSync(configPath, raw, 'utf8');
  log(`✅ ${models.length} models written for provider "${providerId}"`);
}

let lastRestartTime = 0;
const RESTART_DEBOUNCE_MS = 8000; // minimum 8s between restarts

function restartKimiDaemon() {
  const now = Date.now();
  if (now - lastRestartTime < RESTART_DEBOUNCE_MS) {
    log(`⏸️ Restart debounce — skipping (${Math.round((RESTART_DEBOUNCE_MS - (now - lastRestartTime)) / 1000)}s remaining)`);
    return false;
  }
  lastRestartTime = now;

  // Always regenerate session_index.jsonl before restart so daemon picks up latest sessions
  try { ensureWorkspaceMapping(); regenerateSessionIndex(); } catch(e) {}
  // Also save a backup copy of session_index.jsonl so we can recover if daemon clears it
  try { backupSessionIndex(); } catch(e) {}

  // Case 1: We spawned the daemon — kill old process and spawn new one directly
  if (kimiProc && !kimiProc.killed) {
    log('🔄 Restarting Kimi daemon (kill + respawn)...');
    daemonAlive = false;
    // Remove listeners so the exit handler doesn't call scheduleRestart (we're respawning now)
    try { kimiProc.removeAllListeners('exit'); } catch(e) {}
    try { kimiProc.kill('SIGTERM'); } catch(e) {}
    // Wait briefly for port to be released, then spawn fresh
    setTimeout(() => { spawnKimiProcess(); }, 2000);
    return true;
  }

  // Case 2: External daemon — use 'kimi server kill' (only works when daemon is installed)
  // This is primarily for the localhost setup where daemon is managed externally
  try {
    // Try to find kimi binary (npm or system)
    const kimiBin = (() => {
      try { return execSync('which kimi 2>/dev/null', { encoding: 'utf8', timeout: 3000 }).trim(); } catch(e) {}
      const p = path.join(__dirname, 'node_modules', '.bin', 'kimi');
      try { if (fs.existsSync(p)) return p; } catch(e) {}
      return 'npx --yes @moonshot-ai/kimi-code';
    })();
    log(`🔄 Restarting external daemon on ${KIMI_PORT} via '${kimiBin} server kill'...`);
    if (kimiBin.startsWith('npx')) {
      execSync(`${kimiBin} server kill`, { timeout: 15000, stdio: 'pipe' });
    } else {
      execSync(`"${kimiBin}" server kill`, { timeout: 15000, stdio: 'pipe' });
    }
    log('✅ kimi server kill sent — will wait for daemon to restart');
    daemonAlive = false;
    setTimeout(checkDaemon, 5000);
    return true;
  } catch (e) {
    log(`⚠️ 'kimi server kill' failed: ${e.message}`);
    // If we can't kill via command, try spawning our own daemon
    log('🔄 Falling back to spawning our own kimi daemon...');
    spawnKimiProcess();
    return true;
  }
}

// ====== AUTO-DISCOVER MODELS ON STARTUP ======
// After restore, providers may exist in config.toml but with 0 models.
// This function auto-discovers models for any provider with 0 models,
// so the model selector works without manually clicking "Rediscover".
async function autoDiscoverModelsOnStartup() {
  log('🔍 Auto-discover: checking providers for missing models...');
  const providers = readProvidersFromConfig();
  const providerIds = Object.keys(providers);

  if (providerIds.length === 0) {
    log('🔍 Auto-discover: no providers found in config.toml — skipping');
    return;
  }

  // Count models per provider from config.toml
  let configLines = [];
  try { configLines = fs.readFileSync(getConfigPath(), 'utf8').split('\n'); } catch(e) {}
  const modelCounts = {};
  for (const pid of providerIds) {
    modelCounts[pid] = 0;
    for (const line of configLines) {
      if (line.includes('[models.') && line.includes(pid + '-')) {
        modelCounts[pid]++;
      }
    }
  }

  const needsDiscovery = providerIds.filter(pid => modelCounts[pid] === 0);
  if (needsDiscovery.length === 0) {
    log(`🔍 Auto-discover: all ${providerIds.length} providers already have models — nothing to do`);
    return;
  }

  log(`🔍 Auto-discover: ${needsDiscovery.length}/${providerIds.length} providers need model discovery`);
  let anyAdded = false;

  for (const pid of needsDiscovery) {
    const p = providers[pid];
    if (!p.baseUrl) {
      log(`⚠️ Auto-discover: "${pid}" has no base_url — skipping`);
      continue;
    }
    try {
      log(`🔍 Auto-discover: fetching models for "${pid}" from ${p.baseUrl}`);
      const models = await fetchModels(p.baseUrl, p.apiKey || '');
      if (models && models.length > 0) {
        writeModelsForProvider(getConfigPath(), pid, models);
        log(`✅ Auto-discover: "${pid}" — ${models.length} models discovered and saved`);
        anyAdded = true;
      } else {
        log(`⚠️ Auto-discover: "${pid}" — 0 models returned from API`);
      }
    } catch (e) {
      log(`⚠️ Auto-discover: "${pid}" failed — ${e.message}`);
    }
  }

  if (anyAdded) {
    log('🔄 Auto-discover: restarting daemon to pick up new models...');
    restartKimiDaemon();
  }
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

  // ====== ADMIN UI PAGE — Provider Management ======
  // GET /kimi-admin or /kimi-admin/ — full HTML page for managing providers
  if ((req.url === '/kimi-admin' || req.url === '/kimi-admin/') && req.method === 'GET') {
    const providers = readProvidersFromConfig();
    let configLines = [];
    try { configLines = fs.readFileSync(getConfigPath(), 'utf8').split('\n'); } catch(e) {}
    const list = Object.values(providers).map(p => {
      let modelCount = 0;
      for (let i = 0; i < configLines.length; i++) {
        const line = configLines[i];
        if (line.includes('[models.') && line.includes(p.id + '-')) modelCount++;
      }
      return {
        id: p.id, type: p.type, base_url: p.baseUrl,
        has_api_key: !!p.apiKey && p.apiKey !== 'no-auth-required',
        api_key_masked: maskKey(p.apiKey), model_count: modelCount
      };
    });
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kimi Code — Provider Management</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f0f;color:#e0e0e0;min-height:100vh}
.container{max-width:900px;margin:0 auto;padding:24px}
h1{font-size:24px;font-weight:600;margin-bottom:4px;color:#fff}
.sub{color:#888;font-size:14px;margin-bottom:24px}
.card{background:#1a1a2e;border:1px solid #2a2a3e;border-radius:12px;padding:20px;margin-bottom:16px}
.card h2{font-size:16px;font-weight:500;margin-bottom:12px;color:#6c5ce7}
.providers-list{display:grid;gap:8px}
.provider-item{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#252540;border-radius:8px;cursor:pointer;transition:background 0.15s}
.provider-item:hover{background:#2d2d50}
.provider-name{font-weight:500;color:#fff}
.provider-meta{color:#888;font-size:12px}
.provider-models{color:#6c5ce7;font-size:12px;font-weight:500}
.add-btn{display:inline-flex;align-items:center;gap:6px;background:#6c5ce7;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-size:14px;font-weight:500;cursor:pointer;transition:background 0.15s;margin-top:8px}
.add-btn:hover{background:#5a4bd1}
.form-group{margin-bottom:14px}
.form-group label{display:block;font-size:13px;color:#aaa;margin-bottom:4px;font-weight:500}
.form-group input{width:100%;padding:10px 12px;background#1e1e38;border:1px solid #333;border-radius:8px;color:#fff;font-size:14px;outline:none}
.form-group input:focus{border-color:#6c5ce7}
.btn-row{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
.btn{background:#6c5ce7;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:500;cursor:pointer;transition:all 0.15s}
.btn:hover{background:#5a4bd1}
.btn-danger{background:#e74c3c}
.btn-danger:hover{background:#c0392b}
.btn-secondary{background:#333}
.btn-secondary:hover{background:#444}
.modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:100000;align-items:center;justify-content:center}
.modal.active{display:flex}
.modal-content{background:#1a1a2e;border:1px solid #2a2a3e;border-radius:16px;padding:24px;width:90%;max-width:500px;max-height:80vh;overflow-y:auto}
.modal-content h2{margin-bottom:16px;color:#fff;font-size:18px}
.model-list{max-height:200px;overflow-y:auto;background:#1e1e30;border-radius:8px;padding:8px;margin-top:8px}
.model-tag{display:inline-block;background:#252540;color:#ccc;padding:3px 8px;border-radius:4px;font-size:11px;margin:2px}
.toast{position:fixed;bottom:80px;right:20px;background:#1a1a2e;border:1px solid #333;color:#e0e0e0;padding:12px 20px;border-radius:10px;font-size:13px;z-index:200000;opacity:0;transition:opacity 0.3s}
.toast.show{opacity:1}
.hidden{display:none}
.spinner{display:inline-block;width:16px;height:16px;border:2px solid #333;border-radius:50%;border-top-color:#6c5ce7;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
.empty-state{text-align:center;padding:30px;color:#666;font-size:14px}
</style>
</head>
<body>
<div class="container">
  <h1>🔧 Provider Management</h1>
  <div class="sub">Manage AI model providers for Kimi Code</div>
  <div class="card">
    <h2>Installed Providers</h2>
    <div id="providerList" class="providers-list"><div class="empty-state">Loading...</div></div>
    <button class="add-btn" onclick="showAddForm()">+ Add Provider</button>
  </div>
  <div id="addForm" class="hidden card">
    <h2>Add New Provider</h2>
    <div class="form-group"><label>Provider ID (unique, e.g. "my-provider")</label><input id="newId" placeholder="my-provider"></div>
    <div class="form-group"><label>Base URL</label><input id="newUrl" placeholder="https://api.example.com/v1"></div>
    <div class="form-group"><label>API Key (optional)</label><input id="newKey" placeholder="sk-..."></div>
    <div class="form-group"><label>Type</label><input id="newType" value="openai" placeholder="openai"></div>
    <div class="btn-row">
      <button class="btn" onclick="saveProvider()">Save & Discover Models</button>
      <button class="btn-secondary" onclick="hideAddForm()">Cancel</button>
    </div>
  </div>
  <div class="card">
    <h2>Actions</h2>
    <div class="btn-row">
      <button class="btn" onclick="restartDaemon()">🔄 Restart Daemon</button>
      <button class="btn" onclick="backupNow()">💾 Backup Now</button>
      <button class="btn" onclick="restoreFrom('pentaract')">📥 Restore from Pentaract</button>
      <button class="btn" onclick="location.href='/'">← Back to Chat</button>
    </div>
    <div id="actionStatus" style="margin-top:8px;font-size:12px;color:#888"></div>
  </div>
</div>

<div id="modelsModal" class="modal" onclick="if(event.target===this)closeModal()">
  <div class="modal-content">
    <h2 id="modalTitle">Models</h2>
    <div id="modalModels" class="model-list"></div>
    <div class="btn-row"><button class="btn" onclick="closeModal()">Close</button></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const API = '/kimi-admin';
function $(id){return document.getElementById(id)}
function pLog(m){console.log('[KimiAdmin]',m)}

function showToast(msg,isErr){
  const t=$('toast');t.textContent=msg;t.className='toast show';
  if(isErr) t.style.borderColor='#e74c3c'; else t.style.borderColor='#333';
  setTimeout(()=>{t.className='toast'},3000);
}

async function loadProviders(){
  try{
    const r=await fetch(API+'/providers');
    const d=await r.json();
    if(!d.success) throw new Error(d.error||'Failed');
    renderProviders(d.providers);
  }catch(e){pLog('loadProviders error:'+e.message);showToast('Error loading providers: '+e.message,true)}
}

function renderProviders(providers){
  const list=$('providerList');
  if(!providers||providers.length===0){
    list.innerHTML='<div class="empty-state">No providers configured yet. Click "+ Add Provider" to add one.</div>';
    return;
  }
  list.innerHTML=providers.map(p=>\`<div class="provider-item" onclick="showProviderDetail('\${p.id}')">
    <div>
      <div class="provider-name">\${p.id}</div>
      <div class="provider-meta">\${p.type} · \${p.base_url}</div>
    </div>
    <div style="text-align:right">
      <div class="provider-models">\${p.model_count||0} models</div>
      <div class="provider-meta">\${p.has_api_key?'🔑 Key set':'⚠️ No key'}</div>
    </div>
  </div>\`).join('');
}

async function showProviderDetail(id){
  try{
    const r=await fetch(API+'/providers/'+encodeURIComponent(id)+'/models');
    const d=await r.json();
    $('modalTitle').textContent='Models — '+id;
    $('modalModels').innerHTML=d.models&&d.models.length>0
      ? d.models.map(m=>\`<span class="model-tag">\${m}</span>\`).join('')
      : '<div style="color:#666;font-size:13px">No models found. Click Rediscover.</div>';
    $('modelsModal').className='modal active';
    $('modalModels').innerHTML+=(
      '<div class="btn-row" style="margin-top:12px">'+
      '<button class="btn" onclick="rediscover(\''+id+'\')">🔄 Rediscover Models</button>'+
      '<button class="btn btn-danger" onclick="deleteProvider(\''+id+'\')">🗑 Delete Provider</button>'+
      '</div>'
    );
  }catch(e){showToast('Error: '+e.message,true)}
}

function closeModal(){$('modelsModal').className='modal'}

function showAddForm(){$('addForm').className='card';$('newId').focus()}
function hideAddForm(){$('addForm').className='hidden card'}

async function saveProvider(){
  const id=$('newId').value.trim(),url=$('newUrl').value.trim(),key=$('newKey').value.trim(),type=$('newType').value.trim()||'openai';
  if(!id||!url){showToast('Provider ID and Base URL are required',true);return}
  const btn=event.target;btn.disabled=true;btn.innerHTML='<span class="spinner"></span>Saving...';
  try{
    const r=await fetch(API+'/providers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,base_url:url,api_key:key,type})});
    const d=await r.json();
    if(!d.success) throw new Error(d.error||'Failed to save');
    showToast(d.message||'Saved!');
    hideAddForm();
    $('newId').value='';$('newUrl').value='';$('newKey').value='';
    setTimeout(loadProviders,2000);
  }catch(e){showToast('Error: '+e.message,true)}
  finally{btn.disabled=false;btn.innerHTML='Save & Discover Models'}
}

async function rediscover(id){
  const btn=event.target;btn.disabled=true;btn.innerHTML='<span class="spinner"></span>Discovering...';
  try{
    const r=await fetch(API+'/providers/'+encodeURIComponent(id)+'/rediscover',{method:'POST'});
    const d=await r.json();
    showToast(d.message||'Done!');
    setTimeout(()=>showProviderDetail(id),2000);
  }catch(e){showToast('Error: '+e.message,true)}
  finally{btn.disabled=false;btn.innerHTML='🔄 Rediscover Models'}
}

async function deleteProvider(id){
  if(!confirm('Delete provider "'+id+'"?'))return;
  try{
    const r=await fetch(API+'/providers/'+encodeURIComponent(id),{method:'DELETE'});
    const d=await r.json();
    showToast(d.message||'Deleted!');
    closeModal();
    setTimeout(loadProviders,1000);
  }catch(e){showToast('Error: '+e.message,true)}
}

async function restartDaemon(){
  try{
    const r=await fetch(API+'/restart-daemon',{method:'POST'});
    const d=await r.json();
    showToast(d.message||'Restarting...');
  }catch(e){showToast('Error: '+e.message,true)}
}

async function backupNow(){
  try{
    const r=await fetch(API+'/backup-now',{method:'POST'});
    const d=await r.json();
    showToast(d.message||(d.success?'Backup done!':'Backup failed'));
  }catch(e){showToast('Error: '+e.message,true)}
}

async function restoreFrom(src){
  $('actionStatus').textContent='Restoring from '+src+'...';
  try{
    const r=await fetch(API+'/backup-restore?source='+src,{method:'POST'});
    const d=await r.json();
    $('actionStatus').textContent=d.message||'Restore '+(d.success?'done':'failed');
  }catch(e){$('actionStatus').textContent='Error: '+e.message}
}

loadProviders();
</script>
</body>
</html>`;
    res.writeHead(200, {'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(html)});
    return res.end(html);
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

          // Step 4: Restart daemon now to pick up config changes
          const restarted = restartKimiDaemon();
          log(`🔄 Auto-restart after provider "${data.id}" save: ${restarted ? 'initiated' : 'debounced'}`);

          // Step 5: Return response
          const response = {
            success: true,
            models_discovered: models.length,
            daemon_restarting: restarted,
            message: models.length > 0
              ? `Provider "${data.id}" saved with ${models.length} models. ${restarted ? 'Daemon restarting.' : 'Changes apply on next restart.'}`
              : `Provider "${data.id}" saved. ${restarted ? 'Daemon restarting.' : 'Changes apply on next restart.'}`
          };
          if (fetchError) {
            response.model_fetch_error = fetchError;
            response.message = `Provider "${data.id}" saved, but model discovery failed: ${fetchError}. ${restarted ? 'Daemon restarting.' : ''}`;
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
    const restarted = restartKimiDaemon();
    log(`🔄 Auto-restart after provider "${providerId}" delete: ${restarted ? 'initiated' : 'debounced'}`);
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ success: true, daemon_restarting: restarted, message: `Provider "${providerId}" removed. ${restarted ? 'Daemon restarting.' : 'Changes apply on next restart.'}` }));
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
        // Restart daemon now (not delayed) so config takes effect
        // The restartKimiDaemon() has its own 8s debounce to prevent flapping
        const restarted = restartKimiDaemon();
        log(`🔄 Auto-restart after rediscover "${providerId}": ${restarted ? 'initiated' : 'debounced'}`);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({
          success: true,
          provider_id: providerId,
          models_discovered: models.length,
          daemon_restarting: restarted,
          error: fetchError && models.length === 0 ? fetchError : null,
          message: models.length > 0
            ? `Rediscovered ${models.length} models for "${providerId}". ${restarted ? 'Daemon restarting.' : 'Daemon was recently restarted — changes apply on next restart.'}`
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

  // GET /kimi-admin/pg-info — PostgreSQL connection info
  if (req.url === '/kimi-admin/pg-info' && req.method === 'GET') {
    const pgInfo = {
      success: true,
      database: 'kimi_postgres',
      user: 'kimi_postgres_user',
      host: 'dpg-d98sd9jtqb8s739mee80-a.oregon-postgres.render.com',
      port: 5432,
      internal_host: 'dpg-d98sd9jtqb8s739mee80-a',
      external_connection_string: 'postgresql://kimi_postgres_user:TXIdRdDqyyHVfDoxXIVRUGDYGLTCzMoL@dpg-d98sd9jtqb8s739mee80-a.oregon-postgres.render.com:5432/kimi_postgres',
      internal_connection_string: 'postgresql://kimi_postgres_user:TXIdRdDqyyHVfDoxXIVRUGDYGLTCzMoL@dpg-d98sd9jtqb8s739mee80-a/kimi_postgres',
      psql_command: 'PGPASSWORD=TXIdRdDqyyHVfDoxXIVRUGDYGLTCzMoL psql -h dpg-d98sd9jtqb8s739mee80-a.oregon-postgres.render.com -p 5432 -U kimi_postgres_user -d kimi_postgres',
      note: 'External connections require SSL (sslmode=require). Free tier may need IP allowlist.',
      created_at: '2026-07-11',
      plan: 'free (1GB, expires 2026-08-10)'
    };
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify(pgInfo, null, 2));
  }

  // POST /kimi-admin/pg-test — test PostgreSQL connection from within Render
  if (req.url === '/kimi-admin/pg-test' && req.method === 'POST') {
    const { spawn } = require('child_process');
    const testQuery = "SELECT current_database() as db, version() as ver, now() as time";
    const child = spawn('psql', [
      '-h', 'dpg-d98sd9jtqb8s739mee80-a',
      '-U', 'kimi_postgres_user',
      '-d', 'kimi_postgres',
      '-c', testQuery,
      '-t', '-A'
    ], {
      env: { ...process.env, PGPASSWORD: 'TXIdRdDqyyHVfDoxXIVRUGDYGLTCzMoL' },
      timeout: 10000
    });
    let output = '';
    child.stdout.on('data', d => output += d);
    child.stderr.on('data', d => output += d);
    child.on('close', (code) => {
      res.writeHead(code === 0 ? 200 : 500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({
        success: code === 0,
        exit_code: code,
        output: output.trim(),
        message: code === 0 ? 'PostgreSQL connection OK' : 'Connection failed'
      }));
    });
    child.on('error', (e) => {
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ success: false, error: e.message }));
    });
    return;
  }

  // POST /kimi-admin/backup-restore — restore from latest backup
  // Optional query: ?source=pentaract (force Pentaract) or ?source=local (force local)
  if (req.url.startsWith('/kimi-admin/backup-restore') && req.method === 'POST') {
    let restored = false;
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const source = urlObj.searchParams.get('source') || 'auto';
    const localBk = getLatestLocalBackup();

    if (source === 'local') {
      // Force local only
      if (localBk) restored = restoreFromLocalBackup(localBk.file);
    } else if (source === 'pentaract') {
      // Force Pentaract only
      restored = restoreFromPentaract();
    } else {
      // Auto: try local first (any size — even config-only backups are useful)
      if (localBk && localBk.size >= 1000) {
        restored = restoreFromLocalBackup(localBk.file);
      }
      if (!restored) {
        restored = restoreFromPentaract();
      }
    }

    // After restore, always regenerate session index and restart daemon
    if (restored) {
      try { ensureWorkspaceMapping(); } catch(e) {}
      try { regenerateSessionIndex(); } catch(e) {}
      try { restartKimiDaemon(); } catch(e) {}
    }

    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({
      success: restored,
      message: restored
        ? 'Restore completed. Daemon restarting.'
        : 'No backup found or restore failed',
      source_used: source === 'pentaract' ? 'pentaract' : (source === 'local' ? 'local' : (localBk && localBk.size >= 5000 ? 'local' : 'pentaract')),
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


  // ====== Chat UI Static Files (new SPA) ======
  if (req.url === '/kimi-admin/chat-ui.js' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache'});
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'chat-ui.js'), 'utf8'));
  }
  if (req.url === '/kimi-admin/chat-ui.css' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'text/css', 'Cache-Control': 'no-cache'});
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'chat-ui.css'), 'utf8'));
  }
  if (req.url === '/kimi-admin/chat-ui.html' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-cache'});
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'chat-ui.html'), 'utf8'));
  }
  // ====== Admin Panel Static Files (backward compat) ======
  if (req.url === '/kimi-admin/panel.js' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache'});
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'panel.js'), 'utf8'));
  }
  if (req.url === '/kimi-admin/panel.css' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'text/css', 'Cache-Control': 'no-cache'});
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'panel.css'), 'utf8'));
  }

  // ====== PWA Manifest ======
  if (req.url === '/kimi-admin/manifest.json' && req.method === 'GET') {
    const manifest = {
      name: 'Kimi Code',
      short_name: 'Kimi Code',
      description: 'AI-powered coding assistant',
      start_url: '/',
      display: 'standalone',
      background_color: '#0d1117',
      theme_color: '#0d1117',
      icons: [{
        src: '/favicon.ico',
        sizes: '64x64',
        type: 'image/x-icon'
      }]
    };
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify(manifest));
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
        'connection': 'close',
        'authorization': `Bearer ${FIXED_TOKEN}`  // Inject daemon auth token for API auth
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
          // Inject workspace IDs into localStorage so sessions persist in UI
          const wsIdsJson = JSON.stringify(wsIds);
          const wsScript = '<script>\n(function(){\n' +
'  var targetIds = ' + wsIdsJson + ';\n' +
'  function injectWorkspaceIds() {\n' +
'    try {\n' +
'      var o = JSON.parse(localStorage.getItem("kimi-web.workspace-order") || "[]");\n' +
'      var changed = false;\n' +
'      targetIds.forEach(function(id){ if(o.indexOf(id)===-1){ o.push(id); changed=true; } });\n' +
'      if (changed) localStorage.setItem("kimi-web.workspace-order", JSON.stringify(o));\n' +
'      // Also ensure kimi-web.workspaces has these IDs\n' +
'      var ws = JSON.parse(localStorage.getItem("kimi-web.workspaces") || "{}");\n' +
'      targetIds.forEach(function(id){ if(!ws[id]){ ws[id]={id:id,name:id.replace(/^wd_/,\\"\\").substring(0,20)}; } });\n' +
'      localStorage.setItem("kimi-web.workspaces", JSON.stringify(ws));\n' +
'    } catch(e){}\n' +
'  }\n' +
'  injectWorkspaceIds();\n' +
'  setInterval(injectWorkspaceIds, 30000);\n' +
'  document.addEventListener("visibilitychange", function(){ if(!document.hidden) injectWorkspaceIds(); });\n' +
'})();\n' +
'</script>';
          // WebSocket redirect — always use tunnel when available for reliable WS connections
          // Cloudflare (and some reverse proxies) block WS upgrades; tunnel bypasses this
          const tunnelOrigin = (() => { try { return tunnelUrl ? new URL(tunnelUrl).origin : null; } catch(e) { return null; } })();
          let wsRedirect;
          if (tunnelOrigin) {
            wsRedirect = '<script>\n(function(){\n  var targetOrigin = ' + JSON.stringify(tunnelOrigin) + ';\n  var pageOrigin = window.location.origin;\n  if (targetOrigin === pageOrigin) return;\n  var NativeWS = window.WebSocket;\n  window.WebSocket = function(url, protocols) {\n    if (typeof url === "string" && (url.startsWith(pageOrigin + "/api/v1/ws") || url.startsWith("/api/v1/ws"))) {\n      var wsPath = url.includes("/api/v1/ws") ? url.substring(url.indexOf("/api/v1/ws")) : url;\n      url = targetOrigin + wsPath;\n    }\n    return new NativeWS(url, protocols);\n  };\n  window.WebSocket.prototype = NativeWS.prototype;\n  window.WebSocket.CONNECTING = 0;\n  window.WebSocket.OPEN = 1;\n  window.WebSocket.CLOSING = 2;\n  window.WebSocket.CLOSED = 3;\n})();\n</script>';
          } else {
            wsRedirect = '<!-- WS direct: tunnel not available -->';
          }
          // Provider manager — robust multi-strategy provider panel + floating modal
          const providerScript = '<script>\n(function(){\n' +
'  var PROVIDER_DEBUG = false;\n' +
'  function pLog() { if (PROVIDER_DEBUG) console.log.apply(console, arguments); }\n' +
'\n' +
'  // ====== STRATEGY 1: Try Vue internal ref (Pn, or other minified names) ======\n' +
'  function tryVueRef(comp, refNames) {\n' +
'    if (!comp || !comp.setupState) return false;\n' +
'    for (var k = 0; k < refNames.length; k++) {\n' +
'      var ref = comp.setupState[refNames[k]];\n' +
'      if (ref !== void 0) {\n' +
'        if (ref.value !== null && ref.value !== false) {\n' +
'          ref.value = true;\n' +
'          return true;\n' +
'        }\n' +
'      }\n' +
'    }\n' +
'    return false;\n' +
'  }\n' +
'\n' +
'  function walkVueTree(comp, refNames) {\n' +
'    function walk(c) {\n' +
'      if (!c) return false;\n' +
'      if (tryVueRef(c, refNames)) return true;\n' +
'      if (c.subTree) {\n' +
'        if (c.subTree.component && walk(c.subTree.component)) return true;\n' +
'        if (c.subTree.children) {\n' +
'          for (var i = 0; i < c.subTree.children.length; i++) {\n' +
'            var child = c.subTree.children[i];\n' +
'            if (child && child.component && walk(child.component)) return true;\n' +
'          }\n' +
'        }\n' +
'      }\n' +
'      return false;\n' +
'    }\n' +
'    var el = document.querySelector("#app");\n' +
'    if (!el || !el.__vue_app__) return false;\n' +
'    return walk(el.__vue_app__._instance);\n' +
'  }\n' +
'\n' +
'  // Try known Vue ref names for provider/settings panel\n' +
'  function openProvidersVue() {\n' +
'    try {\n' +
'      // Try current known ref names (Pn, showProviders, showProviderPanel, etc.)\n' +
'      var refNames = ["Pn","showProviders","showProviderPanel","_showProviders","showProviderManager","providerPanelVisible","providersVisible"];\n' +
'      if (walkVueTree(null, refNames)) { pLog("openProviders: Vue ref worked"); return true; }\n' +
'      // Try to find and click settings gear button first\n' +
'      var gearBtns = document.querySelectorAll(\'button[aria-label*="Settings"], button[aria-label*="settings"], .settings-btn, [data-settings], svg[class*="gear"], svg[class*="cog"]\');\n' +
'      for (var i = 0; i < gearBtns.length; i++) {\n' +
'        var btn = gearBtns[i].tagName === "SVG" ? gearBtns[i].closest("button") || gearBtns[i].parentElement : gearBtns[i];\n' +
'        if (btn && btn.tagName === "BUTTON") { btn.click(); pLog("openProviders: clicked settings gear"); return true; }\n' +
'      }\n' +
'      // Try the combo: trigger settings via keyboard shortcut?\n' +
'      pLog("openProviders: Vue ref approach failed");\n' +
'    } catch(e) { console.warn("openProviders error:", e); }\n' +
'    return false;\n' +
'  }\n' +
'\n' +
'  // ====== STRATEGY 2: Full provider management modal (no Vue deps) ======\n' +
'  var provModal = null;\n' +
'  var provModalStyle = null;\n' +
'\n' +
'  function createProviderModal() {\n' +
'    if (provModal) { provModal.style.display = "flex"; return; }\n' +
'    // Inject CSS\n' +
'    if (!provModalStyle) {\n' +
'      provModalStyle = document.createElement("style");\n' +
'      provModalStyle.textContent = \'\\\n' +
'#kimi-prov-modal {\\\n' +
'  position:fixed;top:0;left:0;right:0;bottom:0;z-index:999999;\\\n' +
'  background:rgba(0,0,0,0.7);display:none;align-items:center;justify-content:center;\\\n' +
'  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;\\\n' +
'}\\\n' +
'#kimi-prov-modal.open { display:flex; }\\\n' +
'.kimi-prov-panel {\\\n' +
'  background:#1a1a2e;border-radius:16px;padding:24px;width:90%;max-width:720px;\\\n' +
'  max-height:85vh;overflow-y:auto;color:#e0e0e0;box-shadow:0 8px 40px rgba(0,0,0,0.5);\\\n' +
'  border:1px solid #2a2a4a;\\\n' +
'}\\\n' +
'.kimi-prov-panel h2 { margin:0 0 16px 0; font-size:20px; color:#fff; display:flex; align-items:center; gap:8px; }\\\n' +
'.kimi-prov-panel h2 span { background:#6c5ce7; padding:2px 10px; border-radius:10px; font-size:12px; }\\\n' +
'.kimi-prov-close { float:right; background:none; border:none; color:#888; font-size:24px; cursor:pointer; padding:0 4px; }\\\n' +
'.kimi-prov-close:hover { color:#fff; }\\\n' +
'.kimi-prov-card {\\\n' +
'  background:#16213e;border-radius:10px;padding:12px 16px;margin-bottom:8px;\\\n' +
'  display:flex;align-items:center;justify-content:space-between;gap:12px;\\\n' +
'  border:1px solid #1e2d50;\\\n' +
'}\\\n' +
'.kimi-prov-card .info { flex:1; min-width:0; }\\\n' +
'.kimi-prov-card .name { font-weight:600; color:#fff; font-size:14px; }\\\n' +
'.kimi-prov-card .meta { font-size:11px; color:#888; margin-top:2px; }\\\n' +
'.kimi-prov-card .actions { display:flex; gap:6px; flex-shrink:0; }\\\n' +
'.kimi-prov-btn {\\\n' +
'  padding:5px 12px;border-radius:6px;border:none;font-size:12px;\\\n' +
'  cursor:pointer;font-weight:500;transition:all 0.2s;\\\n' +
'}\\\n' +
'.kimi-prov-btn.primary { background:#6c5ce7; color:#fff; }\\\n' +
'.kimi-prov-btn.primary:hover { background:#5a4bd1; }\\\n' +
'.kimi-prov-btn.danger { background:#e74c3c; color:#fff; }\\\n' +
'.kimi-prov-btn.danger:hover { background:#c0392b; }\\\n' +
'.kimi-prov-btn.secondary { background:#2a2a4a; color:#ccc; }\\\n' +
'.kimi-prov-btn.secondary:hover { background:#3a3a5a; }\\\n' +
'.kimi-prov-btn.sm { padding:3px 8px; font-size:11px; }\\\n' +
'.kimi-prov-btn:disabled { opacity:0.5; cursor:not-allowed; }\\\n' +
'.kimi-prov-add {\\\n' +
'  background:#16213e;border-radius:10px;padding:16px;margin-top:12px;\\\n' +
'  border:1px dashed #2a2a4a;\\\n' +
'}\\\n' +
'.kimi-prov-add h3 { margin:0 0 10px 0; font-size:14px; color:#aaa; }\\\n' +
'.kimi-prov-add input,\\\n' +
'.kimi-prov-add select {\\\n' +
'  width:100%;padding:8px 12px;margin-bottom:8px;border-radius:6px;\\\n' +
'  border:1px solid #2a2a4a;background:#0d1117;color:#e0e0e0;font-size:13px;\\\n' +
'  box-sizing:border-box;\\\n' +
'}\\\n' +
'.kimi-prov-add input:focus,\\\n' +
'.kimi-prov-add select:focus { outline:none; border-color:#6c5ce7; }\\\n' +
'.kimi-prov-add .row { display:flex; gap:8px; }\\\n' +
'.kimi-prov-add .row input { flex:1; }\\\n' +
'.kimi-prov-status { padding:8px 12px; border-radius:6px; margin:8px 0; font-size:12px; display:none; }\\\n' +
'.kimi-prov-status.error { display:block; background:#2d1515; color:#e74c3c; border:1px solid #3d2020; }\\\n' +
'.kimi-prov-status.success { display:block; background:#152d1a; color:#2ecc71; border:1px solid #1a3d22; }\\\n' +
'.kimi-prov-status.info { display:block; background:#15202d; color:#3498db; border:1px solid #1a2a3d; }\\\n' +
'.kimi-prov-badge { display:inline-block; padding:1px 8px; border-radius:8px; font-size:10px; font-weight:600; }\\\n' +
'.kimi-prov-badge.ok { background:#1a3d22; color:#2ecc71; }\\\n' +
'.kimi-prov-badge.warn { background:#3d3515; color:#f39c12; }\\\n' +
'.kimi-prov-badge.err { background:#3d1515; color:#e74c3c; }\\\n' +
'.kimi-prov-spinner { display:inline-block; width:12px; height:12px; border:2px solid #6c5ce7; border-radius:50%; border-top-color:transparent; animation:kimi-spin 0.6s linear infinite; vertical-align:middle; margin-right:6px; }\\\n' +
'@keyframes kimi-spin { to { transform:rotate(360deg); } }\\\n' +
'\'; document.head.appendChild(provModalStyle);\n' +
'    }\n' +
'    // Modal HTML\n' +
'    provModal = document.createElement("div");\n' +
'    provModal.id = "kimi-prov-modal";\n' +
'    provModal.innerHTML = \'\\\n' +
'<div class="kimi-prov-panel">\\\n' +
'  <h2><span>&#9881;</span> Manage Providers <span id="kimi-prov-count">0</span><button class="kimi-prov-close" onclick="document.getElementById(\\\'kimi-prov-modal\\\').style.display=\\\'none\\\'">&times;</button></h2>\\\n' +
'  <div id="kimi-prov-status" class="kimi-prov-status"></div>\\\n' +
'  <div id="kimi-prov-list"></div>\\\n' +
'  <div class="kimi-prov-add">\\\n' +
'    <h3>+ Add New Provider</h3>\\\n' +
'    <div class="row"><input id="kimi-prov-new-id" placeholder="Provider ID (e.g. my-provider)" /><input id="kimi-prov-new-type" placeholder="Type (openai)" value="openai" /></div>\\\n' +
'    <div class="row"><input id="kimi-prov-new-url" placeholder="Base URL (e.g. https://api.example.com/v1)" /><input id="kimi-prov-new-key" placeholder="API Key (leave blank if public)" /></div>\\\n' +
'    <button class="kimi-prov-btn primary" onclick="addNewProvider()">Add Provider &amp; Discover Models</button>\\\n' +
'  </div>\\\n' +
'  <div style="margin-top:10px;font-size:11px;color:#555;text-align:center">\\\n' +
'    Config: <code>/root/.kimi-code/config.toml</code>&nbsp;&middot;&nbsp;Daemon auto-restarts on changes\\\n' +
'  </div>\\\n' +
'</div>\';\n' +
'    document.body.appendChild(provModal);\n' +
'  }\n' +
'\n' +
'  function setProvStatus(msg, type) {\n' +
'    var el = document.getElementById("kimi-prov-status");\n' +
'    if (!el) return;\n' +
'    el.textContent = msg;\n' +
'    el.className = "kimi-prov-status " + (type || "info");\n' +
'  }\n' +
'\n' +
'  function reloadProviders() {\n' +
'    var listEl = document.getElementById("kimi-prov-list");\n' +
'    var countEl = document.getElementById("kimi-prov-count");\n' +
'    if (!listEl) return;\n' +
'    listEl.innerHTML = \'<div style="text-align:center;padding:20px;color:#888"><div class="kimi-prov-spinner"></div> Loading providers...</div>\';\n' +
'    fetch("/kimi-admin/providers").then(function(r) { return r.json(); }).then(function(data) {\n' +
'      if (!data.success || !data.providers) { listEl.innerHTML = \'<div style="color:#e74c3c;padding:10px">Failed to load providers</div>\'; return; }\n' +
'      var provs = data.providers;\n' +
'      if (countEl) countEl.textContent = provs.length;\n' +
'      if (provs.length === 0) { listEl.innerHTML = \'<div style="color:#888;padding:20px;text-align:center">No providers configured. Add one below.</div>\'; return; }\n' +
'      var html = "";\n' +
'      for (var i = 0; i < provs.length; i++) {\n' +
'        var p = provs[i];\n' +
'        var badgeClass = p.model_count > 0 ? "ok" : "warn";\n' +
'        var badgeText = p.model_count + " model" + (p.model_count !== 1 ? "s" : "");\n' +
'        if (p.model_count === 0) badgeText = "no models";\n' +
'        var statusDot = p.has_api_key ? \'<span style="color:#2ecc71">&#9679;</span>\' : \'<span style="color:#f39c12">&#9679;</span>\';\n' +
'        html += \'<div class="kimi-prov-card"><div class="info"><div class="name">\' + statusDot + \' \' + escHtml(p.id) + \'</div><div class="meta">\' + escHtml(p.base_url || "") + \' | <span class="kimi-prov-badge \' + badgeClass + \'">\' + badgeText + \'</span></div></div><div class="actions">\' +\n' +
'          \'<button class="kimi-prov-btn secondary sm" onclick="rediscoverProvider(\\\'\' + p.id + \'\\\')">Rediscover</button>\' +\n' +
'          \'<button class="kimi-prov-btn danger sm" onclick="deleteProvider(\\\'\' + p.id + \'\\\')">Delete</button></div></div>\';\n' +
'      }\n' +
'      listEl.innerHTML = html;\n' +
'    }).catch(function(err) {\n' +
'      listEl.innerHTML = \'<div style="color:#e74c3c;padding:10px">Error: \' + err.message + \'</div>\';\n' +
'    });\n' +
'  }\n' +
'\n' +
'  function escHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }\n' +
'\n' +
'  // Wait for daemon to be healthy, then reload the page\n' +
'  function waitForDaemonThenReload(maxTries) {\n' +
'    if (maxTries === void 0) maxTries = 15;\n' +
'    var tries = 0;\n' +
'    function check() {\n' +
'      tries++;\n' +
'      setProvStatus("Waiting for daemon to restart (" + tries + "/" + maxTries + ")", "info");\n' +
'      fetch("/health").then(function(r){ return r.json(); }).then(function(data){\n' +
'        if (data.kimi_alive) {\n' +
'          setProvStatus("Daemon ready, reloading...", "success");\n' +
'          setTimeout(function(){ location.reload(); }, 500);\n' +
'        } else {\n' +
'          retryOrFail();\n' +
'        }\n' +
'      }).catch(function(){ retryOrFail(); });\n' +
'    }\n' +
'    function retryOrFail() {\n' +
'      if (tries >= maxTries) {\n' +
'        setProvStatus("Daemon not ready after " + maxTries + " tries. Please refresh manually.", "error");\n' +
'      } else {\n' +
'        setTimeout(check, 3000);\n' +
'      }\n' +
'    }\n' +
'    check();\n' +
'  }\n' +
'\n' +
'  // Helper: fetch a URL and wait for daemon health\n' +
'  function waitForDaemonFetch(url, opts, statusMsg, cb) {\n' +
'    setProvStatus(statusMsg + "...", "info");\n' +
'    fetch(url, opts).then(function(r) { return r.json(); }).then(function(data) {\n' +
'      if (data.success) {\n' +
'        setProvStatus(statusMsg + " done. " + (data.daemon_restarting ? "Daemon restarting." : ""), "success");\n' +
'        if (cb) cb(data);\n' +
'      } else {\n' +
'        setProvStatus("Error: " + (data.error || "unknown error"), "error");\n' +
'        if (cb) cb(null);\n' +
'      }\n' +
'    }).catch(function(err) {\n' +
'      setProvStatus("Network error: " + err.message, "error");\n' +
'      if (cb) cb(null);\n' +
'    });\n' +
'  }\n' +
'\n' +
'  function addNewProvider() {\n' +
'    var id = document.getElementById("kimi-prov-new-id").value.trim();\n' +
'    var type = document.getElementById("kimi-prov-new-type").value.trim() || "openai";\n' +
'    var url = document.getElementById("kimi-prov-new-url").value.trim();\n' +
'    var key = document.getElementById("kimi-prov-new-key").value.trim();\n' +
'    if (!id || !url) { setProvStatus("Provider ID and Base URL are required", "error"); return; }\n' +
'    var btnEl = document.querySelector(".kimi-prov-add .kimi-prov-btn.primary");\n' +
'    if (btnEl) { btnEl.disabled = true; btnEl.textContent = "Adding..."; }\n' +
'    setProvStatus("Adding provider \\"" + id + "\\" and discovering models...", "info");\n' +
'    fetch("/kimi-admin/providers", {\n' +
'      method: "POST",\n' +
'      headers: {"Content-Type": "application/json"},\n' +
'      body: JSON.stringify({id: id, type: type, base_url: url, api_key: key})\n' +
'    }).then(function(r) { return r.json(); }).then(function(data) {\n' +
'      if (data.success) {\n' +
'        var msg = "Provider \\"" + id + "\\" added successfully";\n' +
'        if (data.models_discovered > 0) msg += " with " + data.models_discovered + " models";\n' +
'        if (data.model_fetch_error) msg += " (model discovery warning: " + data.model_fetch_error + ")";\n' +
'        setProvStatus(msg, "success");\n' +
'        document.getElementById("kimi-prov-new-id").value = "";\n' +
'        document.getElementById("kimi-prov-new-url").value = "";\n' +
'        document.getElementById("kimi-prov-new-key").value = "";\n' +
'        reloadProviders();\n' +
'        // Wait for daemon restart then reload\n' +
'        waitForDaemonThenReload();\n' +
'      } else {\n' +
'        setProvStatus("Error: " + (data.error || "unknown error"), "error");\n' +
'      }\n' +
'    }).catch(function(err) {\n' +
'      setProvStatus("Network error: " + err.message, "error");\n' +
'    }).finally(function() {\n' +
'      if (btnEl) { btnEl.disabled = false; btnEl.textContent = "Add Provider & Discover Models"; }\n' +
'    });\n' +
'  }\n' + +
'\n' +
'  function rediscoverProvider(providerId) {\n' +
'    setProvStatus("Rediscovering models for \\"" + providerId + "\\"...", "info");\n' +
'    fetch("/kimi-admin/providers/" + encodeURIComponent(providerId) + "/rediscover", {\n' +
'      method: "POST"\n' +
'    }).then(function(r) { return r.json(); }).then(function(data) {\n' +
'      if (data.success) {\n' +
'        setProvStatus("Rediscovered " + data.models_discovered + " models for \\"" + providerId + "\\". " + (data.daemon_restarting ? "Daemon restarting." : ""), "success");\n' +
'        reloadProviders();\n' +
'        waitForDaemonThenReload();\n' +
'      } else {\n' +
'        setProvStatus("Error: " + (data.error || "unknown error"), "error");\n' +
'      }\n' +
'    }).catch(function(err) {\n' +
'      setProvStatus("Network error: " + err.message, "error");\n' +
'    });\n' +
'  }\n' +
'\n' +
'  function deleteProvider(providerId) {\n' +
'    if (!confirm("Delete provider \\"" + providerId + "\\" and all its models?")) return;\n' +
'    setProvStatus("Deleting provider \\"" + providerId + "\\"...", "info");\n' +
'    fetch("/kimi-admin/providers/" + encodeURIComponent(providerId), {\n' +
'      method: "DELETE"\n' +
'    }).then(function(r) { return r.json(); }).then(function(data) {\n' +
'      if (data.success) {\n' +
'        setProvStatus("Provider \\"" + providerId + "\\" deleted. " + (data.daemon_restarting ? "Daemon restarting." : ""), "success");\n' +
'        reloadProviders();\n' +
'        waitForDaemonThenReload();\n' +
'      } else {\n' +
'        setProvStatus("Error: " + (data.error || "unknown error"), "error");\n' +
'      }\n' +
'    }).catch(function(err) {\n' +
'      setProvStatus("Network error: " + err.message, "error");\n' +
'    });\n' +
'  }\n' +
'\n' +
'  function openProvidersFull() {\n' +
'    createProviderModal();\n' +
'    provModal.style.display = "flex";\n' +
'    reloadProviders();\n' +
'    setProvStatus("", "");\n' +
'  }\n' +
'\n' +
'  // ====== Open providers (try Vue first, fall back to modal) ======\n' +
'  window.openProviderSettings = function() {\n' +
'    if (!openProvidersVue()) {\n' +
'      pLog("openProviders: Vue approach failed, opening modal");\n' +
'      openProvidersFull();\n' +
'    }\n' +
'  };\n' +
'\n' +
'  // ====== Intercept /provider command ======\n' +
'  window.addEventListener("keydown", function(e) {\n' +
'    if (e.key === "Enter") {\n' +
'      var t = e.target;\n' +
'      if (t && t.tagName === "TEXTAREA" && t.value.trim() === "/provider") {\n' +
'        e.preventDefault();\n' +
'        e.stopPropagation();\n' +
'        t.value = "";\n' +
'        window.openProviderSettings();\n' +
'      }\n' +
'    }\n' +
'  }, true);\n' +
'\n' +
'  // ====== Inject "Manage Providers" button in settings menu ======\n' +
'  var provBtnInjected = false;\n' +
'  var floatingBtn = null;\n' +
'  var injectionAttempts = 0;\n' +
'  var MAX_INJECTION_ATTEMPTS = 200;\n' +
'\n' +
'  function injectProvidersButton() {\n' +
'    if (provBtnInjected) return;\n' +
'    injectionAttempts++;\n' +
'    if (injectionAttempts > MAX_INJECTION_ATTEMPTS) { provBtnInjected = true; return; }\n' +
'\n' +
'    // Strategy 1: Find any element with Sign Out / Logout text (case-insensitive)\n' +
'    var allElements = document.querySelectorAll("button, [role=button], a, span, div, li");\n' +
'    for (var i = 0; i < allElements.length; i++) {\n' +
'      var el = allElements[i];\n' +
'      var txt = (el.textContent || "").trim().toLowerCase();\n' +
'      var isSignOut = txt.indexOf("sign out") !== -1 || txt === "signout" || txt === "sign_out" ||\n' +
'                     txt.indexOf("logout") !== -1 || txt === "log out";\n' +
'      if (!isSignOut) continue;\n' +
'      var parent = el.parentElement;\n' +
'      if (!parent || parent.querySelector(".kimi-prov-injected-btn")) continue;\n' +
'      var container = parent;\n' +
'      for (var w = 0; w < 5; w++) {\n' +
'        if (container.children && container.children.length >= 2) break;\n' +
'        var p = container.parentElement;\n' +
'        if (!p || p === document.body) break;\n' +
'        container = p;\n' +
'      }\n' +
'      var nb = document.createElement("button");\n' +
'      nb.type = "button";\n' +
'      nb.className = "act kimi-prov-injected-btn";\n' +
'      nb.textContent = "Providers";\n' +
'      Object.assign(nb.style, {\n' +
'        cursor:"pointer",width:"100%",textAlign:"left",fontSize:"13px",fontWeight:"500",\n' +
'        background:"transparent",color:"var(--accent-color,#6c5ce7)",\n' +
'        border:"none",padding:"6px 12px"\n' +
'      });\n' +
'      nb.onmouseover = function(){this.style.background="rgba(108,92,231,0.1)";};\n' +
'      nb.onmouseout = function(){this.style.background="transparent";};\n' +
'      nb.onclick = function(ev){ev.preventDefault();ev.stopPropagation();window.openProviderSettings();};\n' +
'      container.insertBefore(nb, el);\n' +
'      provBtnInjected = true;\n' +
'      pLog("Providers button injected near sign-out");\n' +
'      ensureFloatingButton();\n' +
'      return;\n' +
'    }\n' +
'\n' +
'    // Strategy 2: Find gear/cog SVG icons (settings button)\n' +
'    if (!provBtnInjected) {\n' +
'      var svgs = document.querySelectorAll("svg");\n' +
'      for (var i = 0; i < svgs.length; i++) {\n' +
'        var svg = svgs[i];\n' +
'        var btn = svg.closest("button") || (svg.parentElement ? svg.parentElement.closest("button") : null);\n' +
'        if (!btn) continue;\n' +
'        var parent = btn.parentElement;\n' +
'        if (!parent || parent.querySelector(".kimi-prov-injected-btn")) continue;\n' +
'        var nb = document.createElement("button");\n' +
'        nb.type = "button";\n' +
'        nb.className = "kimi-prov-injected-btn";\n' +
'        nb.textContent = "Providers";\n' +
'        Object.assign(nb.style, {\n' +
'          cursor:"pointer",marginLeft:"4px",fontSize:"11px",fontWeight:"500",\n' +
'          background:"var(--accent-color,#6c5ce7)",color:"#fff",\n' +
'          border:"none",borderRadius:"6px",padding:"2px 8px"\n' +
'        });\n' +
'        nb.onclick = function(ev){ev.preventDefault();ev.stopPropagation();window.openProviderSettings();};\n' +
'        parent.insertBefore(nb, btn.nextSibling);\n' +
'        provBtnInjected = true;\n' +
'        pLog("Providers button injected near gear icon");\n' +
'        ensureFloatingButton();\n' +
'        break;\n' +
'      }\n' +
'    }\n' +
'\n' +
'    // Strategy 3: Find sidebar navigation and inject there\n' +
'    if (!provBtnInjected) {\n' +
'      var sidebars = document.querySelectorAll("nav, aside, [class*=sidebar], [class*=nav], [class*=menu]");\n' +
'      for (var i = 0; i < sidebars.length; i++) {\n' +
'        var sb = sidebars[i];\n' +
'        if (sb.querySelector(".kimi-prov-injected-btn")) continue;\n' +
'        var links = sb.querySelectorAll("a, button, [role=button]");\n' +
'        if (links.length >= 2) {\n' +
'          var nb = document.createElement("button");\n' +
'          nb.type = "button";\n' +
'          nb.className = "kimi-prov-injected-btn";\n' +
'          nb.textContent = "⚙ Providers";\n' +
'          Object.assign(nb.style, {\n' +
'            cursor:"pointer",width:"100%",textAlign:"left",fontSize:"13px",fontWeight:"500",\n' +
'            background:"transparent",color:"var(--accent-color,#6c5ce7)",\n' +
'            border:"none",padding:"10px 16px",borderRadius:"6px"\n' +
'          });\n' +
'          nb.onmouseover = function(){this.style.background="rgba(108,92,231,0.1)";};\n' +
'          nb.onmouseout = function(){this.style.background="transparent";};\n' +
'          nb.onclick = function(ev){ev.preventDefault();ev.stopPropagation();window.openProviderSettings();};\n' +
'          sb.insertBefore(nb, links[0]);\n' +
'          provBtnInjected = true;\n' +
'          pLog("Providers button injected in sidebar");\n' +
'          ensureFloatingButton();\n' +
'          return;\n' +
'        }\n' +
'      }\n' +
'    }\n' +
'\n' +
'    // Strategy 4: Inject into any dropdown/modal/settings panel that appears\n' +
'    if (!provBtnInjected) {\n' +
'      var panels = document.querySelectorAll("[class*=dropdown], [class*=menu], [class*=panel], [class*=dialog], [class*=popover], [role=menu], [role=dialog]");\n' +
'      for (var i = 0; i < panels.length; i++) {\n' +
'        var panel = panels[i];\n' +
'        if (panel.querySelector(".kimi-prov-injected-btn")) continue;\n' +
'        var panelLinks = panel.querySelectorAll("button, a, [role=button]");\n' +
'        if (panelLinks.length > 0 && !panel.closest(".kimi-prov-injected-btn")) {\n' +
'          var sep = document.createElement("hr");\n' +
'          sep.style.cssText = "border:none;border-top:1px solid #333;margin:4px 0";\n' +
'          var nb = document.createElement("button");\n' +
'          nb.type = "button";\n' +
'          nb.className = "kimi-prov-injected-btn";\n' +
'          nb.textContent = "Providers";\n' +
'          Object.assign(nb.style, {\n' +
'            cursor:"pointer",width:"100%",textAlign:"left",fontSize:"13px",fontWeight:"500",\n' +
'            background:"transparent",color:"var(--accent-color,#6c5ce7)",\n' +
'            border:"none",padding:"6px 12px",borderRadius:"4px"\n' +
'          });\n' +
'          nb.onmouseover = function(){this.style.background="rgba(108,92,231,0.1)";};\n' +
'          nb.onmouseout = function(){this.style.background="transparent";};\n' +
'          nb.onclick = function(ev){ev.preventDefault();ev.stopPropagation();window.openProviderSettings();};\n' +
'          panel.insertBefore(sep, panelLinks[0]);\n' +
'          panel.insertBefore(nb, panelLinks[0]);\n' +
'          provBtnInjected = true;\n' +
'          pLog("Providers button injected in menu panel");\n' +
'          ensureFloatingButton();\n' +
'          return;\n' +
'        }\n' +
'      }\n' +
'    }\n' +
'\n' +
'    ensureFloatingButton();\n' +
'  }\n' +
'\n' +
'  function ensureFloatingButton() {\n' +
'    if (floatingBtn && document.body.contains(floatingBtn)) return;\n' +
'    floatingBtn = document.createElement("button");\n' +
'    floatingBtn.id = "kimi-floating-prov-btn";\n' +
'    floatingBtn.title = "Manage Providers (Ctrl+Shift+P)";\n' +
'    floatingBtn.innerHTML = \'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>\';\n' +
'    Object.assign(floatingBtn.style, {\n' +
'      position:"fixed",bottom:"76px",right:"20px",zIndex:"2147483647",\n' +
'      width:"44px",height:"44px",borderRadius:"50%",\n' +
'      background:"#6c5ce7",color:"#fff",border:"none",\n' +
'      cursor:"pointer",boxShadow:"0 2px 12px rgba(108,92,231,0.5)",\n' +
'      display:"flex",alignItems:"center",justifyContent:"center",\n' +
'      transition:"all 0.2s",opacity:"0.9"\n' +
'    });\n' +
'    floatingBtn.onmouseover = function(){this.style.transform="scale(1.1)";this.style.boxShadow="0 4px 20px rgba(108,92,231,0.7)";};\n' +
'    floatingBtn.onmouseout = function(){this.style.transform="scale(1)";this.style.boxShadow="0 2px 12px rgba(108,92,231,0.5)";};\n' +
'    floatingBtn.onclick = function(){window.openProviderSettings();};\n' +
'    if (document.body) {\n' +
'      document.body.appendChild(floatingBtn);\n' +
'    } else {\n' +
'      document.addEventListener("DOMContentLoaded", function(){document.body.appendChild(floatingBtn);});\n' +
'    }\n' +
'  }\n' +
'\n' +
'  // ====== Keyboard shortcut: Ctrl+Shift+P ======\n' +
'  document.addEventListener("keydown", function(e) {\n' +
'    if (e.ctrlKey && e.shiftKey && (e.key === "p" || e.key === "P")) {\n' +
'      e.preventDefault();\n' +
'      window.openProviderSettings();\n' +
'    }\n' +
'  });\n' +
'\n' +
'  // MutationObserver for dynamic settings panel — check every DOM change\n' +
'  var obs = new MutationObserver(function(){injectProvidersButton();});\n' +
'  if (document.body) {\n' +
'    obs.observe(document.body, {childList:true, subtree:true, attributes:false});\n' +
'  } else {\n' +
'    document.addEventListener("DOMContentLoaded", function(){obs.observe(document.body, {childList:true, subtree:true, attributes:false});});\n' +
'  }\n' +
'  var injectTimer = setInterval(function(){\n' +
'    injectProvidersButton();\n' +
'    if (provBtnInjected) clearInterval(injectTimer);\n' +
'  }, 1000);\n' +
'  // Show floating button immediately\n' +
'  ensureFloatingButton();\n' +
'\n' +
'  // Also expose to window for debugging\n' +
'  window.__kimiProviders = {\n' +
'    open: window.openProviderSettings,\n' +
'    reload: reloadProviders,\n' +
'    modal: openProvidersFull\n' +
'  };\n' +
'  pLog("Provider injection initialized — watching DOM");\n' +
'})();\n' +
'</script>';
          // WS redirect, workspace scripts, and provider fix — original Kimi Code UI preserved
          const allScripts = wsScript + '\n' + wsRedirect + '\n' + providerScript;
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

    pr.on('error', (err) => {
      daemonAlive = false;
      log(`⚠️ Proxy error: ${err.message}`);
      // For API requests, return JSON error instead of HTML
      if (req.url && req.url.startsWith('/api/')) {
        res.writeHead(503, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({
          code: 50001,
          msg: 'Kimi daemon is restarting. Please try again in a few seconds.',
          data: null,
          request_id: req.headers['x-request-id'] || null
        }));
      } else {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(STARTING_HTML);
      }
    });

    req.pipe(pr);
    return;
  }

  // Not ready yet — serve HTML for page requests, JSON for API requests
  if (req.url && req.url.startsWith('/api/')) {
    res.writeHead(503, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({
      code: 50001,
      msg: 'Kimi daemon is starting up. Please try again in a few seconds.',
      data: null,
      request_id: req.headers['x-request-id'] || null
    }));
  } else {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(STARTING_HTML);
  }
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
// Track active WS connections to close old ones on reconnection
const activeWsConnections = {};

server.on('upgrade', (req, socket, head) => {
  log(`⬆️ WebSocket upgrade: ${req.url}`);

  const clientId = getClientId(req.url);
  if (clientId) log(`  👤 client_id=${clientId}`);

  // === IMPORTANT: Close any existing WS connection for this client before opening new one ===
  // This prevents multiple TCP sockets to the daemon from the same browser tab,
  // which causes "WebSocket error" and daemon connection pool exhaustion.
  if (clientId && activeWsConnections[clientId]) {
    log(`  🔄 Closing old connection for ${clientId} before opening new one`);
    try {
      const old = activeWsConnections[clientId];
      if (old.timer) clearTimeout(old.timer);
      if (old.proxySocket && !old.proxySocket.destroyed) {
        old.proxySocket.unpipe();
        old.proxySocket.removeAllListeners();
        old.proxySocket.destroy();
      }
      if (old.clientSocket && !old.clientSocket.destroyed) {
        old.clientSocket.unpipe();
        old.clientSocket.removeAllListeners();
        old.clientSocket.destroy();
      }
    } catch(e) {}
    delete activeWsConnections[clientId];
  }

  // Clean up any stale pending reconnect entry
  if (clientId) cleanupPendingReconnect(clientId);

  const targetPort = KIMI_PORT;
  const targetHost = '127.0.0.1';

  // Open fresh raw TCP connection to Kimi daemon — always a new connection
  const proxySocket = net.connect(targetPort, targetHost, () => {
    log(`✅ WS TCP connected to ${targetHost}:${targetPort}`);

    // Manually write the HTTP upgrade request (no http.request wrapper)
    const requestLine = `${req.method} ${req.url} HTTP/1.1\r\n`;
    proxySocket.write(requestLine);

    // Forward client headers to the daemon, then inject auth
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (lower === 'connection') {
        proxySocket.write(`connection: upgrade\r\n`);
      } else if (lower === 'authorization') {
        continue; // we inject the daemon's Bearer token below
      } else if (lower === 'host' || lower === 'origin') {
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
            log(`✅ Daemon accepted WebSocket upgrade: ${firstLine}`);
            daemonAlive = true;

            // Split response at header boundary
            const headerPart = responseBuffer.slice(0, headerEnd + 4);
            const bodyPart = responseBuffer.slice(headerEnd + 4);

            // Write HTTP 101 response head to the browser
            socket.write(headerPart);

            // Forward any WebSocket frames that arrived with the 101 response
            if (bodyPart.length > 0) {
              socket.write(bodyPart);
            }
          } else {
            const responseHeaders = headerStr.split('\r\n').slice(1).join(' | ');
            log(`❌ Upgrade rejected: ${firstLine} | ${responseHeaders}`);
            const body = responseBuffer.slice(headerEnd + 4).toString().trim();
            if (body) log(`❌ Rejection body: ${body}`);
            try {
              socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBad Gateway: Kimi daemon rejected WebSocket upgrade');
              socket.end();
            } catch(e) {}
            if (clientId) delete activeWsConnections[clientId];
            proxySocket.destroy();
            return;
          }

          // Enable TCP keepalive on both ends
          proxySocket.setKeepAlive(true, 10000);
          socket.setKeepAlive(true, 10000);

          // Track this connection so we can close it on reconnection
          if (clientId) {
            activeWsConnections[clientId] = { proxySocket, clientSocket: socket, timer: null };
          }

          // Bidirectional pipe (data frames after upgrade)
          proxySocket.pipe(socket);
          socket.pipe(proxySocket);
        }
      }
    });

    // Timeout for the upgrade handshake (15s to handle daemon being slow to start)
    const handshakeTimer = setTimeout(() => {
      if (!responseComplete) {
        log('❌ WebSocket upgrade handshake timeout (15s)');
        if (clientId) delete activeWsConnections[clientId];
        try { socket.destroy(); } catch(e) {}
        try { proxySocket.destroy(); } catch(e) {}
      }
    }, 15000);
    // Store timer so reconnect can cancel it
    if (clientId) {
      if (!activeWsConnections[clientId]) activeWsConnections[clientId] = {};
      activeWsConnections[clientId].timer = handshakeTimer;
    }
  });

  proxySocket.on('error', (err) => {
    // ECONNREFUSED means daemon isn't ready yet — retry gracefully
    if (err.code === 'ECONNREFUSED' || err.message.includes('ECONNREFUSED')) {
      log(`⏳ Daemon not ready (ECONNREFUSED) — browser will auto-reconnect`);
      daemonAlive = false;
      if (clientId) {
        delete activeWsConnections[clientId];
        // Browser's built-in WS reconnection will retry automatically
      }
      try { socket.destroy(); } catch(e) {}
      return;
    }
    log(`❌ WebSocket TCP error: ${err.message}`);
    daemonAlive = false;
    if (clientId) delete activeWsConnections[clientId];
    try { socket.destroy(); } catch(e) {}
  });

  socket.on('error', (err) => {
    // Only log if we haven't already started cleaning up
    if (clientId && activeWsConnections[clientId]) {
      log(`❌ Client WS error (${clientId}): ${err.message}`);
      delete activeWsConnections[clientId];
    }
    try { proxySocket.destroy(); } catch(e) {}
  });

  // Client close — clean up tracked connection immediately (no 30s grace)
  // On page refresh, browser first closes old WS then opens new one.
  // The new WS upgrade handler (above) will close this old entry via clientId match.
  socket.on('close', () => {
    if (clientId) {
      if (activeWsConnections[clientId]) {
        // Leave it tracked — the 'close' handler above this one will clean it
        // when a new WS upgrade comes in with the same clientId.
      } else {
        cleanupPendingReconnect(clientId);
      }
    }
    try {
      proxySocket.unpipe();
      proxySocket.destroy();
    } catch(e) {}
  });

  // Daemon close — clean up
  proxySocket.on('close', () => {
    if (clientId) {
      delete activeWsConnections[clientId];
      cleanupPendingReconnect(clientId);
    }
    try { socket.destroy(); } catch(e) {}
  });
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
  setTimeout(() => {
    // Ensure workspace mappings exist before restore/index regeneration
    try { ensureWorkspaceMapping(); } catch(e) {}
    const restored = checkAndRestore();
    startBackupScheduler();
    syncBothLocations();
    // If restore failed, schedule delayed retries (Cloudflare challenge may be temporary)
    if (!restored) {
      scheduleDelayedRestoreAttempts();
    }
    // Auto-discover models for providers with 0 models (runs after restore)
    // Delay 30s to let daemon fully initialize after restore/restart
    setTimeout(() => { autoDiscoverModelsOnStartup().catch(e => log(`⚠️ Auto-discover error: ${e.message}`)); }, 30000);
  }, 20000);
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

