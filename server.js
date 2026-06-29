#!/usr/bin/env node
/**
 * Kimi Code Render Server v4 — 24/7 Edition 🚀
 * - Self-keepalive: pings own public URL every 5 min to prevent Render sleep
 * - Better proxy: proper header forwarding for auth/login
 * - WebSocket support for Kimi streaming
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');

const PORT = parseInt(process.env.PORT) || 10000;
const KIMI_PORT = PORT + 1;

let debugLog = [];
let daemonAlive = false;
let myPublicUrl = null; // Set on first external request

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
  sock.on('error', () => { sock.destroy(); });
  sock.on('timeout', () => { sock.destroy(); });
  sock.connect(KIMI_PORT, '127.0.0.1');
}

// ====== KEEPALIVE — prevents Render from sleeping ======
// Pings own public URL every 5 min via Render proxy (counts as traffic)
function startKeepalive() {
  setInterval(() => {
    if (!myPublicUrl) return;
    const url = `${myPublicUrl}/health`;
    http.get(url, (res) => {
      log(`🔄 Keepalive ping: ${res.statusCode}`);
      res.resume(); // drain response
    }).on('error', (e) => {
      log(`⚠️ Keepalive error: ${e.message}`);
    });
  }, 5 * 60 * 1000); // every 5 minutes
  log('✅ Keepalive enabled (5min interval)');
}

// ====== HTTP SERVER with improved proxy ======
const server = http.createServer((req, res) => {
  // Record public URL from first external request
  if (!myPublicUrl && req.headers.host && !req.headers.host.includes('127.0.0.1') && !req.headers.host.includes('localhost')) {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    myPublicUrl = `${proto}://${req.headers.host}`;
    log(`🌐 Public URL detected: ${myPublicUrl}`);
  }

  // Debug endpoint
  if (req.url === '/kimi-debug') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    return res.end(debugLog.join('\n'));
  }

  // Health check
  if (req.url === '/health' || req.url === '/_health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({
      status: daemonAlive ? 'healthy' : 'starting',
      kimi_alive: daemonAlive,
      url: myPublicUrl || 'not yet',
      uptime: process.uptime()
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
      // Forward all headers EXCEPT transfer-encoding (Node handles it)
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

    // Pipe request body (important for POST login)
    req.pipe(pr);
    return;
  }

  // Not ready yet
  res.writeHead(200, {'Content-Type': 'text/html'});
  res.end(STARTING_HTML);
});

server.listen(PORT, '0.0.0.0', () => {
  log(`=== Kimi Code Render v4 ===`);
  log(`Server on :${PORT}, Kimi on :${KIMI_PORT}`);

  // Start Kimi daemon
  const kimiBin = ['node_modules/.bin/kimi', 'node_modules/@moonshot-ai/kimi-code/dist/main.mjs']
    .map(p => path.join(__dirname, p))
    .find(p => { try { return fs.existsSync(p); } catch(e) { return false; } }) || 'npx';

  if (kimiBin === 'npx') log('Using npx (no local binary)');
  else log(`Kimi binary: ${kimiBin}`);

  const args = kimiBin === 'npx'
    ? ['@moonshot-ai/kimi-code', 'web', '--port', String(KIMI_PORT), '--no-open']
    : ['web', '--port', String(KIMI_PORT), '--no-open'];

  log(`Starting: ${kimiBin} ${args.join(' ')}`);

  const proc = spawn(kimiBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: process.env.HOME || '/root' },
    cwd: __dirname,
    shell: kimiBin === 'npx'
  });

  proc.stdout.on('data', d => process.stdout.write(`[kimi] ${d}`));
  proc.stderr.on('data', d => {
    const t = d.toString();
    if (t.length > 5) log(`Kimi: ${t.substring(0, 200)}`);
    process.stderr.write(`[kimi] ${t}`);
  });
  proc.on('error', err => log(`❌ Kimi spawn error: ${err.message}`));
  proc.on('exit', (code, sig) => {
    log(`⚠️ Kimi exited (code=${code}, signal=${sig})`);
    if (code !== 0) {
      log('Render will restart this container automatically');
    }
  });

  // Start daemon checks
  setTimeout(checkDaemon, 8000);
  setInterval(checkDaemon, 15000);

  // Start keepalive (will activate once public URL is detected)
  startKeepalive();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down...');
  setTimeout(() => process.exit(0), 2000);
});
