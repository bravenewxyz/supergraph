#!/bin/bash
set -euo pipefail

REPO="bravenewxyz/supergraph"
BRANCH="master"
BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
BIN_DIR="$HOME/.local/bin"
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

# ─── 1. Install binary + native libraries ──────────────────────
# Remove any existing binary first (avoids stale copies shadowing Homebrew)
rm -f "${BIN_DIR}/supergraph"

echo "  [1/4] Downloading supergraph binary (${TARGET})..."
mkdir -p "${BIN_DIR}"
TMP="$(mktemp -d)"
curl -fsSL "${RELEASE_URL}" | tar xz -C "${TMP}"
mv "${TMP}/supergraph" "${BIN_DIR}/supergraph"
chmod +x "${BIN_DIR}/supergraph"
echo "        -> ${BIN_DIR}/supergraph"

# Install native libraries (for Go analysis)
SUPERGRAPH_LIB="${BIN_DIR}/../lib/supergraph"
mkdir -p "${SUPERGRAPH_LIB}"
if [ -d "${TMP}/lib" ]; then
  cp -r "${TMP}/lib/"* "${SUPERGRAPH_LIB}/"
  echo "        -> ${SUPERGRAPH_LIB}/ (native libs)"
fi
rm -rf "${TMP}"

# ─── 2. Install deep-audit command for Claude Code ──────────────
echo "  [2/4] Installing /deep-audit command for Claude Code..."
mkdir -p "${CLAUDE_CMD_DIR}"
curl -fsSL "${BASE}/commands/deep-audit.md" -o "${CLAUDE_CMD_DIR}/deep-audit.md"
echo "        -> ${CLAUDE_CMD_DIR}/deep-audit.md"

# ─── 3. Install /high-level command for Claude Code ──────────────
echo "  [3/4] Installing /high-level command for Claude Code..."
curl -fsSL "${BASE}/commands/high-level.md" -o "${CLAUDE_CMD_DIR}/high-level.md"
echo "        -> ${CLAUDE_CMD_DIR}/high-level.md"

# ─── 4. Install /init-supergraph command for Claude Code ─────────
echo "  [4/4] Installing /init-supergraph command for Claude Code..."
curl -fsSL "${BASE}/commands/init-supergraph.md" -o "${CLAUDE_CMD_DIR}/init-supergraph.md"
echo "        -> ${CLAUDE_CMD_DIR}/init-supergraph.md"

# ─── 5. Mark setup done (skip first-run install) ────────────────
mkdir -p "$HOME/.supergraph"
date -u +%Y-%m-%dT%H:%M:%SZ > "$HOME/.supergraph/.setup-done"

echo ""
echo "Done. You now have:"
echo "  supergraph         — run in any monorepo to generate audit/supergraph.txt"
echo "  /init-supergraph   — Claude Code slash command to bootstrap supergraph on any repo"
echo "  /high-level        — Claude Code slash command to read the full supergraph"
echo "  /deep-audit        — Claude Code slash command for 10-phase package audits"
echo ""

# ─── Ensure PATH includes BIN_DIR ────────────────────────────────
if [[ ":$PATH:" != *":${BIN_DIR}:"* ]]; then
  echo "Note: ${BIN_DIR} is not in your PATH."
  echo "Add it by running:"
  echo ""
  echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
  echo ""
fi
