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
    const listResult = execSync(`curl -s "${PENTARACT_URL}/api/files/${BACKUP_STORAGE_ID}/tree?path=backups" \
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

    // Extract to correct KIMI_HOME parent directory
    execSync(`tar -xzf /tmp/restore-kimi.tar.gz -C ${path.dirname(KIMI_HOME)} && rm -f /tmp/restore-kimi.tar.gz`, { timeout: 30000 });

    log('✅ Restore completed successfully');

    // Patch workspace roots in workspaces.json so Kimi doesn't stat inaccessible /root/ paths
    try {
      const wsPath = path.join(KIMI_HOME, 'workspaces.json');
      if (fs.existsSync(wsPath)) {
        const wsData = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
        let patched = false;
        const renderHome = path.dirname(KIMI_HOME); // e.g. /opt/render (user's home on Render)
        for (const [id, ws] of Object.entries(wsData.workspaces || {})) {
          const oldRoot = ws.root || '';
          if (oldRoot === '/root') {
            ws.root = renderHome;
            log(`🔄 Workspace ${id}: root ${oldRoot} -> ${ws.root}`);
            patched = true;
          } else if (oldRoot === '/root/.kimi-code') {
            ws.root = KIMI_HOME;
            log(`🔄 Workspace ${id}: root ${oldRoot} -> ${ws.root}`);
            patched = true;
          } else if (oldRoot.startsWith('/root/')) {
            ws.root = oldRoot.replace('/root', renderHome);
            log(`🔄 Workspace ${id}: root ${oldRoot} -> ${ws.root}`);
            patched = true;
          }
        }
        if (patched) {
          fs.writeFileSync(wsPath, JSON.stringify(wsData, null, 2));
          log('✅ Workspace roots patched for Render environment');
        }
      }
    } catch (e) {
      log(`⚠️ Workspace patch skipped: ${e.message}`);
    }

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
    const list = Object.values(providers).map(p => ({
      id: p.id,
      type: p.type,
      base_url: p.baseUrl,
      has_api_key: !!p.apiKey && p.apiKey !== 'no-auth-required',
      api_key_masked: maskKey(p.apiKey)
    }));
    return res.end(JSON.stringify({ success: true, providers: list }));
  }

  // POST /kimi-admin/providers — add or update a provider
  if (req.url === '/kimi-admin/providers' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.id || !data.base_url) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ success: false, error: 'id and base_url are required' }));
        }
        writeProviderToConfig(data.id, data.type || 'openai', data.api_key || '', data.base_url);
        log(`🔧 Admin API: ${data.id} provider ${readProvidersFromConfig()[data.id] ? 'updated' : 'added'}`);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ success: true, message: `Provider "${data.id}" saved. Restart daemon to apply.` }));
      } catch (e) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
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

  // POST /kimi-admin/restart-daemon — restart the kimi daemon
  if (req.url === '/kimi-admin/restart-daemon' && req.method === 'POST') {
    const ok = restartKimiDaemon();
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({
      success: ok,
      message: ok ? 'Daemon restart initiated (auto-restarts in ~5s)' : 'Daemon not running'
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
          // WebSocket redirect disabled — custom domain works directly with WS proxy below
          const wsRedirect = '';
          const settingsPanelScript = `<script>
(function(){
if(document.getElementById("ks-btn"))return;
var st=document.createElement("style");
st.textContent="#ks-btn{position:fixed;bottom:20px;right:20px;z-index:99999;width:48px;height:48px;border-radius:50%;background:#6c5ce7;color:#fff;border:none;font-size:22px;cursor:pointer;box-shadow:0 4px 16px rgba(108,92,231,0.4);transition:transform .2s}#ks-btn:hover{transform:scale(1.1)}#ks-modal{position:fixed;top:0;left:0;width:100%;height:100%;z-index:99998;background:rgba(0,0,0,0.6);display:none;align-items:center;justify-content:center}#ks-box{background:#1a1a2e;color:#e0e0e0;border-radius:16px;padding:24px;width:90%;max-width:600px;max-height:85vh;overflow-y:auto;box-shadow:0 8px 40px rgba(0,0,0,0.5);font-family:system-ui,sans-serif}#ks-box h2{color:#6c5ce7;margin:0 0 16px}#ks-box label{display:block;margin:8px 0 4px;color:#aaa;font-size:13px}#ks-box input,#ks-box select{width:100%;padding:10px 12px;margin-bottom:8px;border:1px solid #333;border-radius:8px;background:#16213e;color:#e0e0e0;font-size:14px;box-sizing:border-box}#ks-box input:focus,#ks-box select:focus{outline:none;border-color:#6c5ce7}#ks-box button{padding:10px 20px;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;transition:opacity .2s}#ks-box button:hover{opacity:0.85}.ks-p{background:#6c5ce7;color:#fff}.ks-d{background:#e74c3c;color:#fff}.ks-s{padding:6px 12px;font-size:12px;margin-left:8px}.ks-g{background:transparent;color:#aaa;border:1px solid #333!important}#ks-l{display:flex;flex-direction:column;gap:8px;margin:12px 0}.ks-r{border:1px solid #333;border-radius:10px;padding:12px;display:flex;justify-content:space-between;align-items:center}.ks-i{flex:1}.ks-n{font-weight:700;font-size:14px;color:#fff}.ks-dt{font-size:12px;color:#888;margin-top:2px}.ks-k{font-size:11px;color:#666;margin-top:2px}.ks-a{display:flex;gap:4px;flex-shrink:0}#ks-st{font-size:13px;padding:8px 12px;border-radius:8px;margin:8px 0;display:none}.ks-ok{background:#1a3a2e;color:#2ecc71;border:1px solid #2ecc71}.ks-bad{background:#3a1a1a;color:#e74c3c;border:1px solid #e74c3c}.ks-wait{text-align:center;padding:20px;color:#888}.ks-f{display:flex;gap:8px;flex-wrap:wrap}.ks-f button{flex:1}";
document.head.appendChild(st);
var d=document.createElement("div");
d.innerHTML='<button id="ks-btn" title="Provider Settings">⚙️</button><div id="ks-modal"><div id="ks-box"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h2 style="margin:0">Provider Settings</h2><button onclick="ksC()" style="background:none;border:none;color:#888;font-size:22px;cursor:pointer">✖</button></div><div id="ks-st"></div><div id="ks-l"><div class="ks-wait">Loading...</div></div><hr style="border-color:#333;margin:16px 0"><div style="text-align:right;font-size:12px;color:#555" id="ks-em"></div><label>Provider ID</label><input id="ks-id" placeholder="e.g. my-provider"><label>Base URL</label><input id="ks-url" placeholder="https://api.example.com/v1"><label>API Key</label><input id="ks-key" type="password" placeholder="sk-..."><label>Type</label><select id="ks-typ" onchange="ksTp()"><option value="openai">OpenAI Compatible</option><option value="anthropic">Anthropic</option><option value="google">Gemini</option><option value="custom">Custom</option></select><input id="ks-ctyp" placeholder="e.g. ollama, vllm, together" style="display:none;margin-top:-4px"><div class="ks-f"><button class="ks-p" style="flex:2" onclick="ksS()">Save</button><button class="ks-g" onclick="ksCf()" style="flex:1">Clear</button></div><hr style="border-color:#333;margin:16px 0"><div class="ks-f"><button class="ks-p" onclick="ksR()">Restart Daemon</button><button class="ks-g" onclick="ksRef()">Refresh</button><button class="ks-g" onclick="ksC()">Close</button></div></div></div>';document.body.appendChild(d);
window.ksC=function(){document.getElementById("ks-modal").style.display="none";};
document.getElementById("ks-btn").onclick=function(){ksRef();document.getElementById("ks-modal").style.display="flex";};
document.getElementById("ks-modal").onclick=function(e){if(e.target===this)ksC();};
window.ksCf=function(){document.getElementById("ks-id").value="";document.getElementById("ks-url").value="";document.getElementById("ks-key").value="";document.getElementById("ks-typ").value="openai";document.getElementById("ks-em").textContent="";var ct=document.getElementById("ks-ctyp");if(ct){ct.style.display="none";ct.value="";}};
window.ksTp=function(){var t=document.getElementById("ks-typ").value;var ct=document.getElementById("ks-ctyp");if(t==="custom"){ct.style.display="block";ct.focus();}else{ct.style.display="none";ct.value="";}};window.ksSt=function(m,t){var x=document.getElementById("ks-st");x.textContent=m;x.className=t||"ks-ok";x.style.display="block";if(t!=="ks-wait")setTimeout(function(){x.style.display="none";},4000);};
window.ksRef=function(){var l=document.getElementById("ks-l");l.innerHTML='<div class="ks-wait">Loading...</div>';fetch("/kimi-admin/providers").then(function(r){return r.json();}).then(function(d){if(!d.success||!d.providers){l.innerHTML='<div class="ks-bad" style="padding:12px">Failed</div>';return;}if(d.providers.length===0){l.innerHTML='<div style="color:#888;padding:12px;text-align:center">No providers.</div>';return;}l.innerHTML=d.providers.map(function(p){var del=(p.id!=="opencode"&&p.id!=="omniroute")?'<button class="ks-s ks-d" onclick="ksD(\''+p.id+'\')">Del</button>':'';return'<div class="ks-r"><div class="ks-i"><div class="ks-n">'+p.id+'</div><div class="ks-dt">'+p.type+' \u00B7 '+p.base_url+'</div><div class="ks-k">'+(p.has_api_key?'\u2705 '+p.api_key_masked:'\u26A0\uFE0F No key')+'</div></div><div class="ks-a"><button class="ks-s ks-p" onclick="ksE(\''+p.id+'\',\''+p.type+'\',\''+p.base_url.replace(/'/g,"")+'\')">Edit</button>'+del+'</div></div>';}).join('');}).catch(function(e){l.innerHTML='<div class="ks-bad" style="padding:12px">'+e.message+'</div>';});};
window.ksE=function(id,type,url){document.getElementById("ks-id").value=id;document.getElementById("ks-url").value=url;document.getElementById("ks-key").value="";var sel=document.getElementById("ks-typ");var ct=document.getElementById("ks-ctyp");var known=["openai","anthropic","google"];if(known.indexOf(type)===-1){sel.value="custom";ct.value=type;ct.style.display="block";}else{sel.value=type||"openai";ct.style.display="none";ct.value="";}document.getElementById("ks-em").textContent="Editing: "+id+" (leave key blank to keep)";};
window.ksS=function(){var id=document.getElementById("ks-id").value.trim();var url=document.getElementById("ks-url").value.trim();var key=document.getElementById("ks-key").value.trim();var typ=document.getElementById("ks-typ").value;if(typ==="custom"){var ct=document.getElementById("ks-ctyp").value.trim();if(ct)typ=ct;else{ksSt("Enter custom type name","ks-bad");return;}}if(!id||!url){ksSt("ID and URL required","ks-bad");return;}var b=JSON.stringify({id:id,type:typ,base_url:url,api_key:key});fetch("/kimi-admin/providers",{method:"POST",headers:{"Content-Type":"application/json"},body:b}).then(function(r){return r.json();}).then(function(d){if(d.success){ksSt("Saved! Restart to apply.","ks-ok");ksRef();ksCf();}else{ksSt("Error: "+(d.error||"?"),"ks-bad");}}).catch(function(e){ksSt("Error: "+e.message,"ks-bad");});};
window.ksD=function(id){if(!confirm('Delete provider "'+id+'"? This removes its models too.'))return;fetch("/kimi-admin/providers/"+encodeURIComponent(id),{method:"DELETE"}).then(function(r){return r.json();}).then(function(d){if(d.success){ksSt("Deleted!","ks-ok");ksRef();}else{ksSt("Error: "+(d.error||"?"),"ks-bad");}}).catch(function(e){ksSt("Error: "+e.message,"ks-bad");});};
window.ksR=function(){if(!confirm("Restart daemon? Disconnects active chats briefly."))return;ksSt("Restarting...","ks-wait");document.getElementById("ks-st").style.display="block";fetch("/kimi-admin/restart-daemon",{method:"POST"}).then(function(r){return r.json();}).then(function(d){if(d.success){ksSt("Restart initiated! Reconnecting...","ks-ok");setTimeout(ksRef,5000);}else{ksSt(d.message||"Not running","ks-bad");}}).catch(function(e){ksSt("Error: "+e.message,"ks-bad");});};
})();
</script>`;
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
  log('💾 Backups enabled — Pentaract persistence active');
  log('🚇 Cloudflare Tunnel will start in 10s — check /tunnel-url for the URL');
  // Start backup scheduler after 20s (gives Kimi daemon time to initialize)
  setTimeout(() => { checkAndRestore(); startBackupScheduler(); }, 20000);
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
