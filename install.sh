#!/bin/bash
set -euo pipefail

REPO="bravenewxyz/supergraph"
BRANCH="main"
BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
BIN_DIR="/usr/local/bin"
CLAUDE_CMD_DIR="$HOME/.claude/commands"

echo "supergraph — installing..."
echo ""

# ─── 1. Install binary ──────────────────────────────────────────
echo "  [1/2] Downloading supergraph binary..."
curl -fsSL "${BASE}/bin/supergraph" -o "${BIN_DIR}/supergraph"
chmod +x "${BIN_DIR}/supergraph"
echo "        -> ${BIN_DIR}/supergraph"

# ─── 2. Install deep-audit command for Claude Code ──────────────
echo "  [2/2] Installing /deep-audit command for Claude Code..."
mkdir -p "${CLAUDE_CMD_DIR}"
curl -fsSL "${BASE}/commands/deep-audit.md" -o "${CLAUDE_CMD_DIR}/deep-audit.md"
echo "        -> ${CLAUDE_CMD_DIR}/deep-audit.md"

echo ""
echo "Done. You now have:"
echo "  supergraph    — run in any monorepo to generate audit/supergraph.txt"
echo "  /deep-audit   — Claude Code slash command for 10-phase package audits"
