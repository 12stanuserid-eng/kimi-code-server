#!/usr/bin/env node
/**
 * Kimi Code — Proxy Server for Render
 * - Proxy listens on PORT (Render's port), immediate 200 for health checks
 * - Kimi runs on KIMI_PORT (PORT+1) in foreground mode
 * - Smart proxy: returns "starting" page (200 OK) until Kimi is ready
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT) || 10000;
const KIMI_PORT = PORT + 1;
const HOME = process.env.HOME || '/root';
const KIMI_DIR = path.join(HOME, '.kimi-code');
const CONFIG_PATH = path.join(KIMI_DIR, 'config.toml');
const LOG_DIR = path.join(KIMI_DIR, 'logs');

[KIMI_DIR, LOG_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// "Starting page" HTML — shows until Kimi is ready
const STARTING_PAGE = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kimi Code — Starting...</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f0f0f;color:#e0e0e0}div{text-align:center}.spinner{width:40px;height:40px;border:4px solid #333;border-top:4px solid #6c5ce7;border-radius:50%;animation:spin .8s linear infinite;margin:20px auto}@keyframes spin{to{transform:rotate(360deg)}}h2{color:#6c5ce7}p{color:#888;font-size:14px}</style></head><body>
<div class="spinner"></div><h2>Kimi Code</h2><p>Server is starting... please wait a moment.</p>
<script>setTimeout(()=>location.reload(),5000)</script></body></html>`;

// ====== KIMI PROCESS ======
let kimiReady = false;
let kimiProcess = null;
let restartCount = 0;

function startKimi() {
  const kimiBin = path.join(__dirname, 'node_modules', '.bin', 'kimi');
  const binExists = fs.existsSync(kimiBin);
  
  const cmd = binExists ? kimiBin : 'npx';
  const args = binExists
    ? ['server', 'run', '--foreground', '--port', String(KIMI_PORT), '--host', '0.0.0.0']
    : ['@moonshot-ai/kimi-code', 'server', 'run', '--foreground', '--port', String(KIMI_PORT), '--host', '0.0.0.0'];

  console.log(`[kimi] Starting: ${cmd} ${args.join(' ')}`);
  
  kimiReady = false;
  
  kimiProcess = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME },
    cwd: __dirname,
    shell: !binExists
  });

  kimiProcess.stdout.on('data', (d) => {
    const text = d.toString();
    process.stdout.write(`[kimi] ${text}`);
    // Kimi prints a ready banner when healthy
    if (text.includes('Kimi server') || text.includes('ready') || text.includes('health') || text.includes('http')) {
      kimiReady = true;
      console.log('[proxy] Kimi is READY!');
    }
  });
  kimiProcess.stderr.on('data', (d) => process.stderr.write(`[kimi:err] ${d}`));

  kimiProcess.on('error', (err) => {
    console.error(`[kimi] error: ${err.message}`);
    kimiReady = false;
    setTimeout(startKimi, 3000);
  });
  kimiProcess.on('exit', (code, signal) => {
    console.log(`[kimi] exited (${code}, ${signal})`);
    kimiReady = false;
    restartCount++;
    setTimeout(startKimi, Math.min(10000, 3000 * Math.min(restartCount, 5)));
  });
}

// ====== PROXY ======
function handleRequest(req, res) {
  // /health endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      status: kimiReady ? 'healthy' : 'starting',
      kimi_alive: kimiReady,
      restarts: restartCount,
      uptime: process.uptime()
    }));
    return;
  }

  // If Kimi is ready, proxy to it
  if (kimiReady) {
    const opts = {
      hostname: '127.0.0.1',
      port: KIMI_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${KIMI_PORT}`, connection: 'close' }
    };
    const proxyReq = http.request(opts, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end(STARTING_PAGE);
    });
    req.pipe(proxyReq);
    return;
  }

  // Kimi not ready — show starting page with 200 OK
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(STARTING_PAGE);
}

// ====== MAIN ======
const server = http.createServer(handleRequest);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[proxy] listening on :${PORT}`);
  console.log(`[proxy] Kimi on :${KIMI_PORT}`);
  startKimi();
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`[server] ${signal}, shutting down...`);
  if (kimiProcess) kimiProcess.kill('SIGTERM');
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
