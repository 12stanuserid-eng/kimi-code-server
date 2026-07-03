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
# Config format for Kimi Code v0.21.0+
# Uses [providers.X] (plural) - NOT [provider.X] (singular)

default_model = "${defaultModel}"

# ====== PROVIDERS ======

[providers.openrouter]
type = "openai"
api_key = "${apiKey}"
base_url = "https://openrouter.ai/api/v1"

[providers.freebuff]
type = "openai"
api_key = "${apiKey}"
base_url = "https://api.freebuff.ai/v1"

[providers.omni]
type = "openai"
api_key = "${apiKey}"
base_url = "https://omni-router.ai/v1"

# ====== MODELS - OpenRouter Free ======

[models.deepseek-v4-flash-free]
provider = "openrouter"
model = "deepseek/deepseek-v4-flash-free"
max_context_size = 128000

[models.nemotron-3-ultra-free]
provider = "openrouter"
model = "nvidia/nemotron-3-ultra-free"
max_context_size = 128000

[models.big-pickle]
provider = "openrouter"
model = "big-pickle/big-pickle-free"
max_context_size = 128000

[models.mimo-v2.5-free]
provider = "openrouter"
model = "mimo/mimo-v2.5-free"
max_context_size = 128000

[models.qwen-3.6-plus-free]
provider = "openrouter"
model = "qwen/qwen-3.6-plus-free"
max_context_size = 128000

[models.minimax-m3-free]
provider = "openrouter"
model = "minimax/minimax-m3-free"
max_context_size = 128000

[models.kimi-k2.6-free]
provider = "openrouter"
model = "moonshotai/kimi-k2.6-free"
max_context_size = 128000

# ====== MODELS - GPT fallbacks ======

[models.gpt-4o-mini]
provider = "openrouter"
model = "openai/gpt-4o-mini"
max_context_size = 128000

[models.claude-sonnet]
provider = "openrouter"
model = "anthropic/claude-sonnet-4"
max_context_size = 200000

# ====== FREE MODELS via Freebuff ======

[models.freebuff-ultra]
provider = "freebuff"
model = "freebuff/free-ultra"
max_context_size = 128000

[models.freebuff-pro]
provider = "freebuff"
model = "freebuff/free-pro"
max_context_size = 128000

# ====== OMNI ROUTER MODELS ======

[models.omni-free]
provider = "omni"
model = "omni/free-router"
max_context_size = 128000

[models.omni-smart]
provider = "omni"
model = "omni/smart-router"
max_context_size = 128000

# ====== CLAUDE CODE ACCESSOR ======

[models.claude-code-sonnet]
provider = "openrouter"
model = "anthropic/claude-sonnet-4-code"
max_context_size = 200000

[models.claude-code-haiku]
provider = "openrouter"
model = "anthropic/claude-3-haiku-code"
max_context_size = 200000
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
