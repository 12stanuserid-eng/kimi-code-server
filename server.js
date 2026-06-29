#!/usr/bin/env node
/**
 * Kimi Code Render Server
 * - HTTP server starts IMMEDIATELY (Render health check passes)
 * - Debug info at /kimi-debug
 * - Proxy to Kimi on KIMI_PORT when ready
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = parseInt(process.env.PORT) || 10000;
const KIMI_PORT = PORT + 1;

let debugLog = [];
let kimiReady = false;
let kimiProcess = null;

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

// ====== HTTP SERVER - starts IMMEDIATELY ======
const server = http.createServer((req, res) => {
  if (req.url === '/kimi-debug') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end(debugLog.join('\n'));
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({status: kimiReady ? 'healthy' : 'starting', kimi_alive: kimiReady}));
    return;
  }
  if (kimiReady && kimiProcess && !kimiProcess.killed) {
    const opts = {hostname:'127.0.0.1', port:KIMI_PORT, path:req.url, method:req.method,
      headers:{...req.headers, host:`127.0.0.1:${KIMI_PORT}`, connection:'close'}};
    const pr = http.request(opts, (prRes) => {
      res.writeHead(prRes.statusCode, prRes.headers);
      prRes.pipe(res);
    });
    pr.on('error', () => { res.writeHead(200,{'Content-Type':'text/html'}); res.end(STARTING_HTML); });
    req.pipe(pr);
    return;
  }
  res.writeHead(200, {'Content-Type': 'text/html'});
  res.end(STARTING_HTML);
});

// ====== KIMI STARTUP ======
function startKimi() {
  const fs = require('fs');
  const binDir = path.join(__dirname, 'node_modules', '.bin');

  // Check for kimi binary
  const kimiPaths = [
    path.join(__dirname, 'node_modules', '.bin', 'kimi'),
    path.join(__dirname, 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs')
  ];

  let kimiBin = null;
  for (const p of kimiPaths) {
    if (fs.existsSync(p)) {
      kimiBin = p;
      log(`Found kimi: ${p}`);
      try {
        if (fs.lstatSync(p).isSymbolicLink()) log(`  -> ${fs.readlinkSync(p)}`);
      } catch(e) {}
      break;
    }
  }

  if (!kimiBin) {
    log('kimi binary not found - using npx');
    kimiBin = 'npx';
  }

  // Use 'web' command — runs in background (daemon mode)
  const args = kimiBin === 'npx'
    ? ['@moonshot-ai/kimi-code', 'web', '--port', String(KIMI_PORT), '--host', '0.0.0.0', '--no-open']
    : ['web', '--port', String(KIMI_PORT), '--host', '0.0.0.0', '--no-open'];

  log(`Starting: ${kimiBin} ${args.join(' ')}`);

  kimiProcess = spawn(kimiBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, HOME: process.env.HOME || '/root'},
    cwd: __dirname,
    shell: kimiBin === 'npx'
  });

  let stdoutBuf = '';
  let stderrBuf = '';

  kimiProcess.stdout.on('data', (d) => {
    const text = d.toString();
    stdoutBuf += text;
    process.stdout.write(`[kimi] ${text}`);
    // Check for ready signals
    if (text.includes('Kimi server') || text.includes('ready') || text.includes('http') || text.includes('healthy') || text.includes('listening')) {
      if (!kimiReady) {
        kimiReady = true;
        log('Kimi is READY!');
      }
    }
  });

  kimiProcess.stderr.on('data', (d) => {
    const text = d.toString();
    stderrBuf += text;
    log(`Kimi stderr: ${text.substring(0, 200)}`);
    process.stderr.write(`[kimi:err] ${text}`);
    if (text.includes('Kimi server') || text.includes('ready') || text.includes('http') || text.includes('healthy') || text.includes('listening')) {
      if (!kimiReady) {
        kimiReady = true;
        log('Kimi is READY!');
      }
    }
  });

  kimiProcess.on('error', (err) => {
    log(`Kimi error: ${err.message}`);
  });

  kimiProcess.on('exit', (code, sig) => {
    log(`Kimi exited (code=${code}, signal=${sig})`);
    log(`Kimi last stdout: ${stdoutBuf.substring(stdoutBuf.length - 300)}`);
    log(`Kimi last stderr: ${stderrBuf.substring(stderrBuf.length - 500)}`);
    kimiReady = false;
    kimiProcess = null;
    // Restart after delay
    log('Scheduling restart in 5s...');
    setTimeout(startKimi, 5000);
  });
}

server.listen(PORT, '0.0.0.0', () => {
  log(`Server listening on :${PORT}`);
  // Start Kimi after server is up (non-blocking)
  setImmediate(startKimi);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  if (kimiProcess) kimiProcess.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000);
});
