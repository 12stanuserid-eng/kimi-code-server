#!/usr/bin/env node
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT) || 10000;
const HOME = process.env.HOME || '/root';
const KIMI_DIR = path.join(HOME, '.kimi-code');
const CONFIG_PATH = path.join(KIMI_DIR, 'config.toml');
const LOG_DIR = path.join(KIMI_DIR, 'logs');

// Ensure directories exist
[KIMI_DIR, LOG_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ====== CONFIG.TOML GENERATION ======
function generateConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log('[config] Generating default config.toml...');
    const config = `# Kimi Code Config - Generated for Render
[server]
port = ${PORT}
host = "0.0.0.0"
max_message_length = 128000
max_conversation_history = 100
enable_telemetry = false

[agent]
default_model = "${process.env.KIMI_DEFAULT_MODEL || 'deepseek-v4-flash-free'}"
temperature = 0.7
max_tokens = 4096
enable_swarm = true

[models]
  [models.deepseek-v4-flash-free]
  provider = "openrouter"
  model = "deepseek/deepseek-v4-flash-free"
  api_key = "${process.env.OPENAI_API_KEY || ''}"
  
  [models.gpt-4o-mini]
  provider = "openrouter"
  model = "openai/gpt-4o-mini"
  api_key = "${process.env.OPENAI_API_KEY || ''}"

[provider]
default = "openrouter"

[provider.openrouter]
base_url = "https://openrouter.ai/api/v1"
api_key = "${process.env.OPENAI_API_KEY || ''}"

[platform]
enable_rest_api = true
enable_webhook = false
enable_telegram = ${process.env.TELEGRAM_BOT_TOKEN ? 'true' : 'false'}
`;
    fs.writeFileSync(CONFIG_PATH, config);
    console.log('[config] Config written to', CONFIG_PATH);
  }
}

// ====== KIMI PROCESS MANAGER ======
let kimiProcess = null;
let restartCount = 0;

function getKimiCommand() {
  // Use npx to find the package binary (most reliable)
  const npxPath = process.env.NPX_PATH || 'npx';
  return { cmd: npxPath, args: ['@moonshot-ai/kimi-code'] };
}

function startKimi() {
  const { cmd, args } = getKimiCommand();
  console.log(`[kimi] Starting: ${cmd} ${args.join(' ')} server --port ${PORT}`);

  kimiProcess = spawn(cmd, [...args, 'server', '--port', String(PORT)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME, PATH: process.env.PATH, NODE_PATH: process.cwd() + '/node_modules' }
  });

  kimiProcess.stdout.on('data', (data) => {
    process.stdout.write(`[kimi] ${data}`);
  });

  kimiProcess.stderr.on('data', (data) => {
    process.stderr.write(`[kimi:err] ${data}`);
  });

  kimiProcess.on('error', (err) => {
    console.error(`[kimi] Launch error: ${err.message}`);
    scheduleRestart();
  });

  kimiProcess.on('exit', (code, signal) => {
    console.log(`[kimi] Exited (code=${code}, signal=${signal})`);
    scheduleRestart();
  });
}

function scheduleRestart() {
  restartCount++;
  const delay = Math.min(5000, 1000 * restartCount);
  console.log(`[kimi] Restart #${restartCount} in ${delay}ms...`);
  setTimeout(startKimi, delay);
}

// ====== HEALTH SERVER ======
const healthServer = http.createServer((req, res) => {
  const respond = (code, data) => {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(data));
  };

  if (req.url === '/health') {
    const alive = kimiProcess && kimiProcess.exitCode === null;
    respond(alive ? 200 : 503, {
      status: alive ? 'healthy' : 'unhealthy',
      kimi_alive: alive,
      restarts: restartCount,
      uptime: process.uptime()
    });
  } else if (req.url === '/') {
    respond(200, {
      service: 'kimi-code-server',
      version: '1.0.0',
      status: kimiProcess && kimiProcess.exitCode === null ? 'running' : 'restarting',
      restarts: restartCount
    });
  } else {
    // Proxy to kimi
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: req.url,
      method: req.method,
      headers: req.headers
    };
    const proxy = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxy.on('error', () => respond(502, { error: 'kimi unavailble' }));
    req.pipe(proxy);
  }
});

// ====== MAIN ======
generateConfig();
startKimi();

healthServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Health + proxy server on :${PORT}`);
  console.log(`[server] Health check: /health`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`[server] ${signal} received, graceful shutdown...`);
  if (kimiProcess) {
    kimiProcess.kill('SIGTERM');
    setTimeout(() => process.exit(0), 3000);
  } else {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
