#!/usr/bin/env node
/**
 * Kimi Code Render Server v2
 * - HTTP server starts IMMEDIATELY ✅
 * - Kimi runs via 'web' command (daemon mode)
 * - daemon keeps running after parent exits — NO restart on code=0
 * - Health check: actually connect to daemon port
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const PORT = parseInt(process.env.PORT) || 10000;
const KIMI_PORT = PORT + 1;

let debugLog = [];
let kimiReady = false;
let kimiSpawned = false;
let healthTimer = null;

function log(m) {
  const line = `[${new Date().toISOString()}] ${m}`;
  debugLog.push(line);
  console.error(line);
}

const STARTING_HTML = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kimi Code</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f0f0f;color:#e0e0e0}div{text-align:center}h2{color:#6c5ce7}.info{color:#888;font-size:13px;margin-top:10px}</style></head><body>
<div><h2>🪐 Kimi Code</h2><p>Loading Kimi Code Interface...</p><p class="info">Server will be ready shortly</p>
<script>setTimeout(()=>location.reload(),3000)</script></div></body></html>`;

// ====== REAL HEALTH CHECK: try connecting to daemon ======
let daemonAlive = false;

function checkDaemon(callback) {
  const sock = new net.Socket();
  sock.setTimeout(3000);
  sock.on('connect', () => {
    sock.destroy();
    daemonAlive = true;
    kimiReady = true;
    if (callback) callback(true);
  });
  sock.on('error', () => {
    sock.destroy();
    daemonAlive = false;
    if (callback) callback(false);
  });
  sock.on('timeout', () => {
    sock.destroy();
    daemonAlive = false;
    if (callback) callback(false);
  });
  sock.connect(KIMI_PORT, '127.0.0.1');
}

// Check daemon every 10 seconds
function startHealthCheck() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(() => {
    checkDaemon((alive) => {
      if (!alive && kimiSpawned) {
        log('Daemon not responding, triggering restart...');
        spawnKimi();
      }
    });
  }, 10000);
}

// ====== KIMI DAEMON SPAWN ======
let kimiSpawnCount = 0;

function spawnKimi() {
  const fs = require('fs');
  kimiSpawnCount++;

  // Check for kimi binary
  const kimiPaths = [
    path.join(__dirname, 'node_modules', '.bin', 'kimi'),
    path.join(__dirname, 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs')
  ];

  let kimiBin = null;
  for (const p of kimiPaths) {
    if (fs.existsSync(p)) {
      kimiBin = p;
      log(`[spawn #${kimiSpawnCount}] Found: ${p}`);
      try { if (fs.lstatSync(p).isSymbolicLink()) log(`  -> ${fs.readlinkSync(p)}`); } catch(e) {}
      break;
    }
  }

  if (!kimiBin) {
    log('[spawn] binary not found, using npx');
    kimiBin = 'npx';
  }

  const args = kimiBin === 'npx'
    ? ['@moonshot-ai/kimi-code', 'web', '--port', String(KIMI_PORT), '--no-open']
    : ['web', '--port', String(KIMI_PORT), '--no-open'];

  log(`[spawn] Running: ${kimiBin} ${args.join(' ')}`);

  // Kill previous process if any
  if (kimiProcess && !kimiProcess.killed) {
    try { kimiProcess.kill('SIGTERM'); } catch(e) {}
  }

  const proc = spawn(kimiBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, HOME: process.env.HOME || '/root'},
    cwd: __dirname,
    shell: kimiBin === 'npx'
  });

  kimiProcess = proc;
  kimiSpawned = true;

  let stdoutBuf = '';
  let stderrBuf = '';

  proc.stdout.on('data', (d) => {
    const text = d.toString();
    stdoutBuf += text;
    process.stdout.write(`[kimi] ${text}`);
    // Daemon is spawned — mark as potentially ready
    // The actual readiness is confirmed by checkDaemon
  });

  proc.stderr.on('data', (d) => {
    const text = d.toString();
    stderrBuf += text;
    const snippet = text.substring(0, 200);
    log(`[kimi:err] ${snippet}`);
    process.stderr.write(`[kimi:err] ${text}`);
  });

  proc.on('error', (err) => {
    log(`[spawn] Error: ${err.message}`);
  });

  proc.on('exit', (code, sig) => {
    log(`[spawn] Exited (code=${code}, signal=${sig})`);
    log(`[spawn] last stdout: ${stdoutBuf.substring(stdoutBuf.length - 200)}`);
    if (stderrBuf) log(`[spawn] last stderr: ${stderrBuf.substring(stderrBuf.length - 300)}`);

    // code=0 is NORMAL — web command exits after spawning daemon
    // Daemon keeps running independently
    if (code === 0) {
      log('[spawn] code=0: daemon started, parent exiting normally');
      // Don't clear kimiReady — daemon should be alive
      // But verify with health check
      setTimeout(() => checkDaemon(), 2000);
      return;
    }

    // Non-zero exit: daemon failed to start — restart
    if (proc === kimiProcess) {
      kimiProcess = null;
    }
    log(`[spawn] Daemon start failed, retrying in 5s...`);
    setTimeout(spawnKimi, 5000);
  });

  // Check daemon after reasonable startup time
  setTimeout(() => checkDaemon(), 5000);
}

// ====== HTTP SERVER ======
const server = http.createServer((req, res) => {
  if (req.url === '/kimi-debug') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end(debugLog.join('\n'));
    return;
  }
  if (req.url === '/health') {
    const alive = daemonAlive;
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({status: alive ? 'healthy' : 'starting', kimi_alive: alive}));
    return;
  }

  // Proxy to daemon if alive
  if (daemonAlive) {
    const opts = {hostname:'127.0.0.1', port:KIMI_PORT, path:req.url, method:req.method,
      headers:{...req.headers, host:`127.0.0.1:${KIMI_PORT}`, connection:'close'}};
    const pr = http.request(opts, (prRes) => {
      res.writeHead(prRes.statusCode, prRes.headers);
      prRes.pipe(res);
    });
    pr.on('error', () => {
      daemonAlive = false;
      res.writeHead(200,{'Content-Type':'text/html'});
      res.end(STARTING_HTML);
    });
    req.pipe(pr);
    return;
  }

  res.writeHead(200, {'Content-Type': 'text/html'});
  res.end(STARTING_HTML);
});

server.listen(PORT, '0.0.0.0', () => {
  log(`Server listening on :${PORT}`);
  startHealthCheck();
  spawnKimi();
});

process.on('SIGTERM', () => {
  if (kimiProcess && !kimiProcess.killed) kimiProcess.kill('SIGTERM');
  if (healthTimer) clearInterval(healthTimer);
  setTimeout(() => process.exit(0), 2000);
});
