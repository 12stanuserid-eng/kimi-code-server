#!/usr/bin/env python3
"""Add NVIDIA provider to setup.js"""
content = open('/root/kimi-code-server/setup.js', 'r').read()

# Find the MODELS header
models_header = '\n# ═══════════════════════════════════════════════════════════════\n# MODELS\n# ═══════════════════════════════════════════════════════════════'
midx = content.find(models_header)

if midx == -1:
    print('ERROR: MODELS header not found')
    exit(1)

# Insert NVIDIA provider block before the MODELS header
nvidia_block = '\n\n# \u2500\u2500\u2500 NVIDIA (free tier, Nemotron, Llama, Mistral, etc.) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n[providers.nvidia]\ntype = "openai"\napi_key = "${getKey(\'NVIDIA_API_KEY\', \'nvidia\', \'nvapi-YOUR_NVIDIA_KEY\')}"\nbase_url = "https://integrate.api.nvidia.com/v1"\n'

content = content[:midx] + nvidia_block + content[midx:]

open('/root/kimi-code-server/setup.js', 'w').write(content)
print('SUCCESS: NVIDIA provider added to setup.js')
