#!/usr/bin/env node
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT) || 10000;
const KIMI_PORT = PORT + 1; // Kimi runs on internal port
const HOME = process.env.HOME || '/root';
const KIMI_DIR = path.join(HOME, '.kimi-code');
const CONFIG_PATH = path.join(KIMI_DIR, 'config.toml');
const LOG_DIR = path.join(KIMI_DIR, 'logs');

// Ensure directories
[KIMI_DIR, LOG_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ====== CONFIG.TOML — OpenCode Zen FREE models ======
function generateConfig() {
  if (fs.existsSync(CONFIG_PATH)) return;
  console.log('[config] Generating config.toml with OpenCode Zen free models...');

  const config = `# Kimi Code Config — OpenCode Zen FREE
default_model = "opencode-deepseek-v4-flash-free"

[server]
port = ${KIMI_PORT}
host = "0.0.0.0"
enable_swarm = true

# === OpenCode Zen (FREE — no API key needed) ===
[providers.opencode]
type = "openai"
base_url = "https://opencode.ai/zen/v1"

[models."opencode-deepseek-v4-flash-free"]
provider = "opencode"
model = "deepseek-v4-flash-free"
max_context_size = 128000

[models."opencode-deepseek-v4-flash"]
provider = "opencode"
model = "deepseek-v4-flash"
max_context_size = 128000

[models."opencode-deepseek-v4-pro"]
provider = "opencode"
model = "deepseek-v4-pro"
max_context_size = 128000

[models."opencode-gpt5.5"]
provider = "opencode"
model = "gpt-5.5"
max_context_size = 128000

[models."opencode-gpt5.5-pro"]
provider = "opencode"
model = "gpt-5.5-pro"
max_context_size = 128000

[models."opencode-gpt5.4"]
provider = "opencode"
model = "gpt-5.4"
max_context_size = 128000

[models."opencode-gpt5.4-mini"]
provider = "opencode"
model = "gpt-5.4-mini"
max_context_size = 128000

[models."opencode-gpt5.4-nano"]
provider = "opencode"
model = "gpt-5.4-nano"
max_context_size = 128000

[models."opencode-claude-sonnet-4"]
provider = "opencode"
model = "claude-sonnet-4"
max_context_size = 128000

[models."opencode-claude-haiku-4.5"]
provider = "opencode"
model = "claude-haiku-4-5"
max_context_size = 128000

[models."opencode-gemini-3.5-flash"]
provider = "opencode"
model = "gemini-3.5-flash"
max_context_size = 128000

[models."opencode-kimi-k2.6"]
provider = "opencode"
model = "kimi-k2.6"
max_context_size = 128000

[models."opencode-kimi-k2.5"]
provider = "opencode"
model = "kimi-k2.5"
max_context_size = 128000

[models."opencode-qwen3.6-plus"]
provider = "opencode"
model = "qwen3.6-plus"
max_context_size = 128000

[models."opencode-qwen3.6-plus-free"]
provider = "opencode"
model = "qwen3.6-plus-free"
max_context_size = 128000

[models."opencode-minimax-m3-free"]
provider = "opencode"
model = "minimax-m3-free"
max_context_size = 128000

[models."opencode-nemotron"]
provider = "opencode"
model = "nemotron-3-ultra-free"
max_context_size = 128000

[models."opencode-mimo-v2.5-free"]
provider = "opencode"
model = "mimo-v2.5-free"
max_context_size = 128000

[models."opencode-big-pickle"]
provider = "opencode"
model = "big-pickle"
max_context_size = 128000

[models."opencode-north-mini-code-free"]
provider = "opencode"
model = "north-mini-code-free"
max_context_size = 128000

# === OpenRouter (free tier) ===
[providers.openrouter]
type = "openai"
base_url = "https://openrouter.ai/api/v1"
api_key = "${process.env.OPENROUTER_API_KEY || ''}"

[models."openrouter-deepseek-v4-flash-free"]
provider = "openrouter"
model = "deepseek/deepseek-v4-flash-free"
max_context_size = 128000

[models."openrouter-gpt-4o-mini"]
provider = "openrouter"
model = "openai/gpt-4o-mini"
max_context_size = 128000

[models."openrouter-claude-sonnet-4"]
provider = "openrouter"
model = "anthropic/claude-sonnet-4"
max_context_size = 128000

[models."openrouter-gemini-2.5-flash"]
provider = "openrouter"
model = "google/gemini-2.5-flash"
max_context_size = 128000
`;

  fs.writeFileSync(CONFIG_PATH, config);
  console.log('[config] Written to', CONFIG_PATH);
}

// ====== KIMI PROCESS ======
let kimiProcess = null;
let restartCount = 0;

function startKimi() {
  const args = ['@moonshot-ai/kimi-code', 'web', '--port', String(KIMI_PORT), '--host', '0.0.0.0'];
  console.log(`[kimi] Starting: npx ${args.join(' ')}`);

  kimiProcess = spawn('npx', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME,
      PATH: process.env.PATH,
      NODE_PATH: process.cwd() + '/node_modules'
    }
  });

  kimiProcess.stdout.on('data', (data) => process.stdout.write(`[kimi] ${data}`));
  kimiProcess.stderr.on('data', (data) => process.stderr.write(`[kimi:err] ${data}`));

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
  const delay = Math.min(10000, 2000 * restartCount);
  console.log(`[kimi] Restart #${restartCount} in ${delay}ms...`);
  setTimeout(startKimi, delay);
}

// ====== PROXY SERVER ======
const server = http.createServer((req, res) => {
  // Health endpoint
  if (req.url === '/health') {
    const alive = kimiProcess && kimiProcess.exitCode === null;
    res.writeHead(alive ? 200 : 503, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      status: alive ? 'healthy' : 'unhealthy',
      kimi_alive: alive,
      restarts: restartCount,
      uptime: process.uptime()
    }));
    return;
  }

  // Everything else → proxy to Kimi Code Web UI
  const options = {
    hostname: '127.0.0.1',
    port: KIMI_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${KIMI_PORT}` }
  };

  const proxyReq = http.request(options, (proxyRes) => {
    // Copy all headers (including content-type for HTML/JS/CSS)
    const headers = { ...proxyRes.headers };
    delete headers['transfer-encoding']; // let Node handle chunking
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Kimi Code starting...');
  });

  req.pipe(proxyReq);
});

// ====== MAIN ======
generateConfig();
startKimi();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Kimi Code Web + proxy on :${PORT}`);
  console.log(`[server] URL: http://0.0.0.0:${PORT}`);
  console.log(`[server] Health: /health`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`[server] ${signal} received, graceful shutdown...`);
  if (kimiProcess) {
    kimiProcess.kill('SIGTERM');
    setTimeout(() => process.exit(0), 5000);
  } else {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
