#!/usr/bin/env bash
set -euo pipefail
agent_repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
agent_install_home="${1:-${HOME}/.local/share/acp-teams-adapter/first-connection}"
node -e 'if(Number(process.versions.node.split(".")[0])<22 || (Number(process.versions.node.split(".")[0])===22 && Number(process.versions.node.split(".")[1])<13)){console.error("Install Node.js 22.13 or newer, then run this installer again.");process.exit(1)}'
cd "$agent_repo_dir"
npm ci --ignore-scripts
npm run build
node dist/cli.js init --home "$agent_install_home"
echo "Connection installed. Follow README.md to configure its Teams registration and ACP endpoint."
echo "Start with: node $agent_repo_dir/dist/cli.js serve --home $agent_install_home"
