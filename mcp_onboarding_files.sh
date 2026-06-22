#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/DenisErmakov/apps/onboarding_cross_node"
LOG="/tmp/onboarding_cross_mcp.log"

cd "$PROJECT_DIR"

{
  echo "=== MCP START $(date) ==="
  echo "user=$(id -un)"
  echo "pwd=$(pwd)"
  echo "node=$(command -v node || true)"
  echo "npx=$(command -v npx || true)"
} >> "$LOG" 2>&1

exec npx -y @modelcontextprotocol/server-filesystem "$PROJECT_DIR" 2>>"$LOG"
