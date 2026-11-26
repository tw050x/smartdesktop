#!/usr/bin/env bash
# Installs SmartStudio's own ComfyUI nodes (server/comfyui/smartstudio_nodes) on the generation
# server, over SSH, and restarts ComfyUI so it loads them.
#
#   scripts/install-comfy-nodes.sh [host] [custom nodes folder] [container]
#
# Defaults are the GX10's: secondary.gx10, ~/genai/comfyui/custom_nodes, comfyui-genai.
set -euo pipefail
host="${1:-secondary.gx10}"
folder="${2:-genai/comfyui/custom_nodes}"
container="${3:-comfyui-genai}"
here="$(cd "$(dirname "$0")/.." && pwd)"

ssh "$host" "mkdir -p '$folder/smartstudio_nodes'"
scp -q "$here/server/comfyui/smartstudio_nodes/__init__.py" "$host:$folder/smartstudio_nodes/__init__.py"
ssh "$host" "docker restart '$container' >/dev/null"
echo "Installed on $host; ComfyUI ($container) is restarting."
