#!/usr/bin/env node
/**
 * Kimi Code Server — spawns Kimi directly on Render PORT
 * Bina proxy ke, sidha kimi chalata hai.
 * Health endpoint PORT+1 pe.
 */

const { spawn } = require('child_process');
const http = require('http');

const PORT = parseInt(process.env.PORT) || 10000;
const HEALTH_PORT = PORT + 1;

// Simple health server on separate port
http.createServer((req, res) => {
  const alive = kimi && kimi.exitCode === null && kimi.killed === false;
  const status = alive ? 200 : 503;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify({
    status: alive ? 'healthy' : 'unhealthy',
    kimi_alive: alive,
    uptime: process.uptime(),
    port: PORT,
    health_port: HEALTH_PORT
  }));
}).listen(HEALTH_PORT, '0.0.0.0', () => {
  console.log(`[health] listening on ${HEALTH_PORT}`);
});

// Run Kimi directly on the Render PORT
console.log(`[kimi] Starting @moonshot-ai/kimi-code on port ${PORT}...`);
const kimi = spawn('npx', ['@moonshot-ai/kimi-code', 'web', '--port', String(PORT), '--host', '0.0.0.0'], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    KIMI_CODE_PASSWORD: process.env.KIMI_CODE_PASSWORD || '',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-placeholder',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  },
  shell: true
});

kimi.on('error', (err) => {
  console.error(`[kimi] Failed to start: ${err.message}`);
  process.exit(1);
});

kimi.on('exit', (code, signal) => {
  console.log(`[kimi] exited (code=${code}, signal=${signal})`);
  if (code !== 0) {
    // Wait a bit then exit so Render knows to restart
    setTimeout(() => process.exit(1), 5000);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[kimi] received SIGTERM, shutting down...');
  kimi.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000);
});
