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
  console.error(line); // stderr -> Render logs
}

const STARTING_HTML = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kimi Code</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f0f0f;color:#e0e0e0}div{text-align:center}h2{color:#6c5ce7}.info{color:#888;font-size:13px;margin-top:10px}</style></head><body>
<div><h2>🪐 Kimi Code</h2><p>Loading Kimi Code Interface...</p><p class="info">Server will be ready shortly</p>
<script>setTimeout(()=>location.reload(),3000)</script></div></body></html>`;

// ====== HTTP SERVER - starts IMMEDIATELY ======
const server = http.createServer((req, res) => {
  // Debug endpoint shows full debug log
  if (req.url === '/kimi-debug') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end(debugLog.join('\n'));
    return;
  }
  // Health
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({status: kimiReady ? 'healthy' : 'starting', kimi_alive: kimiReady}));
    return;
  }
  // If Kimi is ready, proxy
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
  // Starting page
  res.writeHead(200, {'Content-Type': 'text/html'});
  res.end(STARTING_HTML);
});

server.listen(PORT, '0.0.0.0', () => {
  log(`Server listening on :${PORT}`);
  
  // === ASYNC: Find and start Kimi (non-blocking) ===
  setImmediate(() => {
    try {
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
      
      const args = kimiBin === 'npx'
        ? ['@moonshot-ai/kimi-code', 'server', 'run', '--foreground', '--port', String(KIMI_PORT), '--host', '0.0.0.0']
        : ['server', 'run', '--foreground', '--port', String(KIMI_PORT), '--host', '0.0.0.0'];
      
      log(`Starting: ${kimiBin} ${args.join(' ')}`);
      
      kimiProcess = spawn(kimiBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {...process.env, HOME: process.env.HOME || '/root'},
        cwd: __dirname,
        shell: kimiBin === 'npx'
      });
      
      kimiProcess.stdout.on('data', (d) => {
        const text = d.toString();
        process.stdout.write(`[kimi] ${text}`);
        if (text.includes('Kimi server') || text.includes('ready') || text.includes('http')) {
          kimiReady = true;
          log('Kimi is READY!');
        }
      });
      
      kimiProcess.stderr.on('data', (d) => {
        process.stderr.write(`[kimi:err] ${d}`);
        const text = d.toString();
        if (text.includes('Kimi server') || text.includes('ready') || text.includes('http')) {
          kimiReady = true;
          log('Kimi is READY!');
        }
      });
      
      kimiProcess.on('error', (err) => {
        log(`Kimi error: ${err.message}`);
        setTimeout(() => { kimiReady = false; }, 3000);
      });
      
      kimiProcess.on('exit', (code, sig) => {
        log(`Kimi exited (code=${code}, signal=${sig})`);
        kimiReady = false;
        // Don't restart - Render will restart the whole container
        // This gives us a fresh state
      });
      
    } catch(err) {
      log(`Setup error: ${err.message}\n${err.stack}`);
    }
  });
});

// Graceful
process.on('SIGTERM', () => {
  if (kimiProcess) kimiProcess.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000);
});
