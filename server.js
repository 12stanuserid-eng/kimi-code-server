#!/usr/bin/env node
/**
 * Kimi Code Server — minimal, robust
 * Spawns Kimi on PORT, runs health check listener on PORT+1
 */

const { spawn, execSync } = require('child_process');
const http = require('http');

const PORT = parseInt(process.env.PORT) || 10000;
const HEALTH_PORT = PORT + 1;

// Find kimi binary
function findKimi() {
  const paths = [
    'node_modules/.bin/kimi',
    'node_modules/@moonshot-ai/kimi-code/dist/main.mjs',
    '/usr/local/bin/kimi',
    '/usr/bin/kimi'
  ];
  for (const p of paths) {
    try { require('fs').accessSync(p); return p; }
    catch(e) { /* not found */ }
  }
  // Try global
  try {
    const r = execSync('which kimi 2>/dev/null || echo ""', {encoding:'utf8'});
    if (r.trim()) return r.trim();
  } catch(e) {}
  return 'npx'; // fallback
}

const kimiBin = findKimi();
console.log(`[kimi] Using: ${kimiBin}`);

// Health server
http.createServer((req, res) => {
  const alive = kimi && kimi.exitCode === null && !kimi.killed;
  res.writeHead(alive ? 200 : 503, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({
    status: alive ? 'healthy' : 'unhealthy',
    kimi_alive: alive,
    uptime: process.uptime()
  }));
}).listen(HEALTH_PORT, '0.0.0.0', () => {
  console.log(`[health] on ${HEALTH_PORT}`);
});

// Run Kimi
const args = kimiBin === 'npx'
  ? ['@moonshot-ai/kimi-code', 'web', '--port', String(PORT), '--host', '0.0.0.0']
  : ['web', '--port', String(PORT), '--host', '0.0.0.0'];

const kimi = spawn(kimiBin, args, {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, UV_USE_IO_URING: '0' },
  shell: true
});

kimi.on('error', (err) => {
  console.error(`[kimi] error: ${err.message}`);
  setTimeout(() => process.exit(1), 2000);
});

kimi.on('exit', (code) => {
  console.log(`[kimi] exited (${code})`);
  if (code !== 0) setTimeout(() => process.exit(1), 5000);
});

process.on('SIGTERM', () => {
  kimi.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000);
});
