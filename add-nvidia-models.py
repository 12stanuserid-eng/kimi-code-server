#!/usr/bin/env python3
"""Add NVIDIA models to setup.js"""
content = open('/root/kimi-code-server/setup.js', 'r').read()

# Find the closing backtick of the template string
close_backtick = content.rfind('\n\t`;')
if close_backtick == -1:
    close_backtick = content.rfind('`;')
print('Close backtick at:', close_backtick)

# Also find the last model entry to add before it
# Find 'cf-mistral-7b' which is the last Cloudflare model
last_cf = content.rfind('max_context_size = 16000')
print('Last CF model at:', last_cf)

if close_backtick > -1:
    # Insert NVIDIA models before the closing backtick
    nvidia_models = '''
\t# \u2500\u2500 NVIDIA models \u2500\u2500\u2500\u2500

\t[models."nvidia-nemotron-4-ultra"]
\tprovider = "nvidia"
\tmodel = "nvidia/llama-3.1-nemotron-ultra-253b-v1"
\tmax_context_size = 131072

\t[models."nvidia-nemotron-4-mini"]
\tprovider = "nvidia"
\tmodel = "nvidia/llama-3.1-nemotron-mini-4b-instruct"
\tmax_context_size = 32768

\t[models."nvidia-nemotron-70b"]
\tprovider = "nvidia"
\tmodel = "nvidia/llama-3.1-nemotron-70b-instruct"
\tmax_context_size = 131072

\t[models."nvidia-mistral-7b"]
\tprovider = "nvidia"
\tmodel = "mistralai/mistral-7b-instruct-v0.3"
\tmax_context_size = 32768

\t[models."nvidia-mistral-large"]
\tprovider = "nvidia"
\tmodel = "mistralai/mistral-large-2407"
\tmax_context_size = 131072

\t[models."nvidia-llama-3-70b"]
\tprovider = "nvidia"
\tmodel = "meta/llama-3.1-70b-instruct"
\tmax_context_size = 131072

\t[models."nvidia-llama-3-8b"]
\tprovider = "nvidia"
\tmodel = "meta/llama-3.1-8b-instruct"
\tmax_context_size = 32768

\t[models."nvidia-qwen-72b"]
\tprovider = "nvidia"
\tmodel = "qwen/qwen-72b-chat"
\tmax_context_size = 131072

\t[models."nvidia-deepseek-r1"]
\tprovider = "nvidia"
\tmodel = "deepseek-ai/deepseek-r1"
\tmax_context_size = 131072

\t[models."nvidia-phi-3-mini"]
\tprovider = "nvidia"
\tmodel = "microsoft/phi-3-mini-4k-instruct"
\tmax_context_size = 4096

'''
    content = content[:close_backtick] + nvidia_models + content[close_backtick:]
    open('setup.js', 'w').write(content)
    print('SUCCESS: NVIDIA models added to setup.js')
else:
    print('Could not find closing backtick')
