#!/usr/bin/env node
/**
 * Kimi Code Render Server v3
 * - Proxy on PORT, Kimi on KIMI_PORT (daemon mode)
 * - No restart loop — Render handles container restarts
 * - Starting page (200 OK) until Kimi is ready
 * - Real TCP health check for daemon liveness
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const PORT = parseInt(process.env.PORT) || 10000;
const KIMI_PORT = PORT + 1;

let debugLog = [];
let daemonAlive = false;
let healthTimer = null;

function log(m) {
  debugLog.push(`[${new Date().toISOString()}] ${m}`);
  console.error(m);
}

const STARTING_HTML = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kimi Code</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f0f0f;color:#e0e0e0}div{text-align:center}h2{color:#6c5ce7}.info{color:#888;font-size:13px;margin-top:10px}</style></head><body>
<div><h2>🪐 Kimi Code</h2><p>Loading Kimi Code Interface...</p><p class="info">Server will be ready shortly</p>
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

// ====== HTTP SERVER ======
const server = http.createServer((req, res) => {
  if (req.url === '/kimi-debug') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    return res.end(debugLog.join('\n'));
  }
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({
      status: daemonAlive ? 'healthy' : 'starting',
      kimi_alive: daemonAlive
    }));
  }
  // Proxy to Kimi daemon
  if (daemonAlive) {
    const opts = {hostname:'127.0.0.1', port:KIMI_PORT, path:req.url, method:req.method,
      headers:{...req.headers, host:`127.0.0.1:${KIMI_PORT}`, connection:'close'}};
    const pr = http.request(opts, (prRes) => {
      const headers = {...prRes.headers};
      delete headers['transfer-encoding'];
      res.writeHead(prRes.statusCode, headers);
      prRes.pipe(res);
    });
    pr.on('error', () => { daemonAlive = false;
      res.writeHead(200,{'Content-Type':'text/html'}); res.end(STARTING_HTML); });
    return req.pipe(pr);
  }
  res.writeHead(200, {'Content-Type': 'text/html'});
  res.end(STARTING_HTML);
});

server.listen(PORT, '0.0.0.0', () => {
  log(`Server on :${PORT}, Kimi on :${KIMI_PORT}`);

  // Start Kimi daemon
  const fs = require('fs');
  const kimiBin = ['node_modules/.bin/kimi','node_modules/@moonshot-ai/kimi-code/dist/main.mjs']
    .map(p => path.join(__dirname, p)).find(p => { try { return fs.existsSync(p); } catch(e){return false;} }) || 'npx';

  if (kimiBin === 'npx') log('Using npx (no local binary found)');
  else log(`Kimi: ${kimiBin}`);

  const args = kimiBin === 'npx'
    ? ['@moonshot-ai/kimi-code', 'web', '--port', String(KIMI_PORT), '--no-open']
    : ['web', '--port', String(KIMI_PORT), '--no-open'];

  log(`Starting: ${kimiBin} ${args.join(' ')}`);

  const proc = spawn(kimiBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, HOME: process.env.HOME || '/root'},
    cwd: __dirname,
    shell: kimiBin === 'npx'
  });

  proc.stdout.on('data', d => process.stdout.write(`[kimi] ${d}`));
  proc.stderr.on('data', d => {
    const t = d.toString();
    log(`Kimi stderr: ${t.substring(0,200)}`);
    process.stderr.write(`[kimi:err] ${t}`);
  });
  proc.on('error', err => log(`Kimi error: ${err.message}`));
  proc.on('exit', (code, sig) => {
    log(`Kimi exited (code=${code}, signal=${sig})`);
    // code=0: daemon spawned successfully (web command exits after starting daemon)
    // Daemon keeps running — no restart needed
    if (code !== 0) {
      log('Non-zero exit — Render will restart this container');
    }
  });

  // Check daemon after startup grace period
  setTimeout(checkDaemon, 8000);
  setInterval(checkDaemon, 15000);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  if (healthTimer) clearInterval(healthTimer);
  setTimeout(() => process.exit(0), 2000);
});
