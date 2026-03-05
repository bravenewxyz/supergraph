#!/bin/bash
set -euo pipefail

REPO="bravenewxyz/supergraph"
BRANCH="master"
BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
BIN_DIR="/usr/local/bin"
CLAUDE_CMD_DIR="$HOME/.claude/commands"

echo "supergraph — installing..."
echo ""

# ─── Detect platform ────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}" in
  Darwin) PLATFORM="darwin" ;;
  Linux)  PLATFORM="linux" ;;
  *)      echo "Unsupported OS: ${OS}"; exit 1 ;;
esac

case "${ARCH}" in
  arm64|aarch64) ARCH_SUFFIX="arm64" ;;
  x86_64)        ARCH_SUFFIX="x64" ;;
  *)             echo "Unsupported architecture: ${ARCH}"; exit 1 ;;
esac

TARGET="${PLATFORM}-${ARCH_SUFFIX}"
RELEASE_URL="https://github.com/${REPO}/releases/latest/download/supergraph-${TARGET}.tar.gz"

# ─── 1. Install binary ──────────────────────────────────────────
echo "  [1/2] Downloading supergraph binary (${TARGET})..."
TMP="$(mktemp -d)"
curl -fsSL "${RELEASE_URL}" | tar xz -C "${TMP}"
mv "${TMP}/supergraph" "${BIN_DIR}/supergraph"
chmod +x "${BIN_DIR}/supergraph"
rm -rf "${TMP}"
echo "        -> ${BIN_DIR}/supergraph"

# ─── 2. Install deep-audit command for Claude Code ──────────────
echo "  [2/2] Installing /deep-audit command for Claude Code..."
mkdir -p "${CLAUDE_CMD_DIR}"
curl -fsSL "${BASE}/commands/deep-audit.md" -o "${CLAUDE_CMD_DIR}/deep-audit.md"
echo "        -> ${CLAUDE_CMD_DIR}/deep-audit.md"

# ─── 3. Mark setup done (skip first-run install) ────────────────
mkdir -p "$HOME/.supergraph"
date -u +%Y-%m-%dT%H:%M:%SZ > "$HOME/.supergraph/.setup-done"

echo ""
echo "Done. You now have:"
echo "  supergraph    — run in any monorepo to generate audit/supergraph.txt"
echo "  /deep-audit   — Claude Code slash command for 10-phase package audits"
