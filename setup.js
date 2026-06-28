#!/usr/bin/env node
console.log('=== Kimi Code Setup ===');
console.log('This setup runs during Render build to configure everything.');

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HOME = process.env.HOME || '/root';
const KIMI_DIR = path.join(HOME, '.kimi-code');
const LOG_DIR = path.join(KIMI_DIR, 'logs');

// Create dirs
[KIMI_DIR, LOG_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Generate config.toml
const configPath = path.join(KIMI_DIR, 'config.toml');
const apiKey = process.env.OPENAI_API_KEY || '';
const defaultModel = process.env.KIMI_DEFAULT_MODEL || 'deepseek-v4-flash-free';

const config = `# Kimi Code Configuration - Auto-generated
# Includes all free models from multiple providers

[server]
port = ${parseInt(process.env.KIMI_PORT) || 58627}
host = "0.0.0.0"
max_message_length = 128000
enable_telemetry = false

[agent]
default_model = "${defaultModel}"
temperature = 0.7
max_tokens = 8192
enable_swarm = true

# ====== PROVIDERS ======
[provider]
default = "openrouter"

[provider.openrouter]
base_url = "https://openrouter.ai/api/v1"
api_key = "${apiKey}"
max_retries = 3

[provider.freebuff]
base_url = "https://api.freebuff.ai/v1"
api_key = "${apiKey}"
max_retries = 2

[provider.verdant]
base_url = "https://api.verdant.code/v1"
api_key = "${apiKey}"
max_retries = 2

[provider.omni]
base_url = "https://omni-router.ai/v1"
api_key = "${apiKey}"
max_retries = 3

# ====== MODELS - OpenRouter Free ======
[models.deepseek-v4-flash-free]
provider = "openrouter"
model = "deepseek/deepseek-v4-flash-free"
api_key = "${apiKey}"

[models.nemotron-3-ultra-free]
provider = "openrouter"
model = "nvidia/nemotron-3-ultra-free"
api_key = "${apiKey}"

[models.big-pickle]
provider = "openrouter"
model = "big-pickle/big-pickle-free"
api_key = "${apiKey}"

[models.mimo-v2.5-free]
provider = "openrouter"
model = "mimo/mimo-v2.5-free"
api_key = "${apiKey}"

[models.qwen-3.6-plus-free]
provider = "openrouter"
model = "qwen/qwen-3.6-plus-free"
api_key = "${apiKey}"

[models.minimax-m3-free]
provider = "openrouter"
model = "minimax/minimax-m3-free"
api_key = "${apiKey}"

[models.kimi-k2.6-free]
provider = "openrouter"
model = "moonshotai/kimi-k2.6-free"
api_key = "${apiKey}"

# ====== MODELS - GPT fallbacks ======
[models.gpt-4o-mini]
provider = "openrouter"
model = "openai/gpt-4o-mini"
api_key = "${apiKey}"

[models.claude-sonnet]
provider = "openrouter"
model = "anthropic/claude-sonnet-4"
api_key = "${apiKey}"

# ====== FREE MODELS via Freebuff ======
[models.freebuff-ultra]
provider = "freebuff"
model = "freebuff/free-ultra"
api_key = "${apiKey}"

[models.freebuff-pro]
provider = "freebuff"
model = "freebuff/free-pro"
api_key = "${apiKey}"

# ====== OMNI ROUTER MODELS ======
[models.omni-free]
provider = "omni"
model = "omni/free-router"
api_key = "${apiKey}"

[models.omni-smart]
provider = "omni"
model = "omni/smart-router"
api_key = "${apiKey}"

# ====== CLAUDE CODE ACCESSOR ======
[models.claude-code-sonnet]
provider = "openrouter"
model = "anthropic/claude-sonnet-4-code"
api_key = "${apiKey}"

[models.claude-code-haiku]
provider = "openrouter"
model = "anthropic/claude-3-haiku-code"
api_key = "${apiKey}"

# ====== VERDENT CODE ======
[models.verdent-free]
provider = "verdant"
model = "verdant/code-free"
api_key = "${apiKey}"

[models.verdent-pro]
provider = "verdant"
model = "verdant/code-pro"
api_key = "${apiKey}"
`;

fs.writeFileSync(configPath, config);
console.log('[setup] Config written to', configPath);

// Verify kimi binary
try {
  const whichKimi = execSync('which kimi 2>/dev/null || npx --yes @moonshot-ai/kimi-code --version 2>/dev/null || echo "not-found"', { encoding: 'utf8' }).trim();
  console.log('[setup] Kimi binary:', whichKimi);
} catch (e) {
  console.log('[setup] Kimi not yet installed (will be available after npm install)');
}

console.log('=== Setup Complete ===');
