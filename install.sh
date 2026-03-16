#!/bin/bash
set -euo pipefail

REPO="bravenewxyz/supergraph"
BRANCH="master"
BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
BIN_DIR="$HOME/.local/bin"
CLAUDE_CMD_DIR="$HOME/.claude/commands"

# ─── Local mode ────────────────────────────────────────────────
# Usage: ./install.sh --local
#   Builds from source and installs from the local repo instead of
#   downloading from GitHub releases.
LOCAL_MODE=false
if [[ "${1:-}" == "--local" ]]; then
  LOCAL_MODE=true
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

# ─── Colors & symbols ───────────────────────────────────────────
if [ -t 1 ]; then
  BOLD='\033[1m'
  DIM='\033[2m'
  RESET='\033[0m'
  CYAN='\033[36m'
  GREEN='\033[32m'
  YELLOW='\033[33m'
  RED='\033[31m'
  MAGENTA='\033[35m'
  WHITE='\033[97m'
else
  BOLD='' DIM='' RESET='' CYAN='' GREEN='' YELLOW='' RED='' MAGENTA='' WHITE=''
fi

CHECK="${GREEN}✓${RESET}"
CROSS="${RED}✗${RESET}"
ARROW="${DIM}→${RESET}"

# ─── Header ─────────────────────────────────────────────────────
echo ""
printf "${MAGENTA}${BOLD}  ╭─────────────────────────────────────╮${RESET}\n"
printf "${MAGENTA}${BOLD}  │${RESET}${WHITE}${BOLD}       supergraph  installer          ${RESET}${MAGENTA}${BOLD}│${RESET}\n"
printf "${MAGENTA}${BOLD}  ╰─────────────────────────────────────╯${RESET}\n"
echo ""

# ─── Detect platform ────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}" in
  Darwin) PLATFORM="darwin" ;;
  Linux)  PLATFORM="linux" ;;
  *)      printf "  ${CROSS} Unsupported OS: ${OS}\n"; exit 1 ;;
esac

case "${ARCH}" in
  arm64|aarch64) ARCH_SUFFIX="arm64" ;;
  x86_64)        ARCH_SUFFIX="x64" ;;
  *)             printf "  ${CROSS} Unsupported architecture: ${ARCH}\n"; exit 1 ;;
esac

TARGET="${PLATFORM}-${ARCH_SUFFIX}"
RELEASE_URL="https://github.com/${REPO}/releases/latest/download/supergraph-${TARGET}.tar.gz"

printf "  ${DIM}platform${RESET}  ${CYAN}${TARGET}${RESET}\n"
if [ "${LOCAL_MODE}" = true ]; then
  printf "  ${DIM}mode${RESET}      ${YELLOW}local build${RESET}\n"
fi
echo ""

# ─── Spinner helper ─────────────────────────────────────────────
SPINNER_PID=""

spinner_start() {
  local msg="$1"
  if [ -t 1 ]; then
    (
      frames=('⣾' '⣽' '⣻' '⢿' '⡿' '⣟' '⣯' '⣷')
      i=0
      while true; do
        printf "\r  ${CYAN}%s${RESET} %b" "${frames[i % ${#frames[@]}]}" "${msg}"
        i=$((i + 1))
        sleep 0.08
      done
    ) &
    SPINNER_PID=$!
  else
    printf "  %b\n" "${msg}"
  fi
}

spinner_stop() {
  if [ -n "${SPINNER_PID}" ]; then
    kill "${SPINNER_PID}" 2>/dev/null || true
    wait "${SPINNER_PID}" 2>/dev/null || true
    SPINNER_PID=""
    printf "\r\033[K"
  fi
}

trap 'spinner_stop' EXIT

step_done() {
  printf "  ${CHECK} %b\n" "$1"
}

step_detail() {
  printf "    ${ARROW} ${DIM}%b${RESET}\n" "$1"
}

step_fail() {
  printf "  ${CROSS} %b\n" "$1"
}

# ─── Download with retries + timeout ────────────────────────────
download() {
  local url="$1" dest="$2" label="$3"
  local max_attempts=5
  local attempt=1

  while [ "${attempt}" -le "${max_attempts}" ]; do
    local msg="${label}"
    if [ "${attempt}" -gt 1 ]; then
      msg="${label} ${DIM}(retry ${attempt}/${max_attempts})${RESET}"
    fi
    spinner_start "${msg}"

    if curl --http1.1 -fSL \
         --connect-timeout 10 \
         --max-time 30 \
         -o "${dest}" \
         "${url}" 2>/dev/null; then
      spinner_stop
      return 0
    fi

    spinner_stop

    if [ "${attempt}" -lt "${max_attempts}" ]; then
      local wait=$((attempt * 2))
      printf "    ${DIM}retrying in %ds...${RESET}\n" "${wait}"
      sleep "${wait}"
    fi
    rm -f "${dest}"
    attempt=$((attempt + 1))
  done

  step_fail "failed to download after ${max_attempts} attempts"
  return 1
}

# ─── 1. Install binary ──────────────────────────────────────────
rm -f "${BIN_DIR}/supergraph"
mkdir -p "${BIN_DIR}"

if [ "${LOCAL_MODE}" = true ]; then
  # Build from source
  if [ ! -f "${SCRIPT_DIR}/package.json" ]; then
    step_fail "Not in supergraph repo root — cannot build from source"
    exit 1
  fi

  spinner_start "Building from source"
  if ! (cd "${SCRIPT_DIR}" && bun run build) >/dev/null 2>&1; then
    spinner_stop
    step_fail "Build failed — run ${CYAN}bun run build${RESET} manually for details"
    exit 1
  fi
  spinner_stop

  if [ ! -f "${SCRIPT_DIR}/supergraph" ]; then
    step_fail "Build produced no binary"
    exit 1
  fi

  cp "${SCRIPT_DIR}/supergraph" "${BIN_DIR}/supergraph"
  chmod +x "${BIN_DIR}/supergraph"

  VERSION="$("${BIN_DIR}/supergraph" --version 2>/dev/null || echo "unknown")"
  step_done "Binary installed ${BOLD}${WHITE}${VERSION}${RESET} ${DIM}(local build)${RESET}"
  step_detail "${BIN_DIR}/supergraph"

  # Install native libraries (for Go analysis)
  SUPERGRAPH_LIB="${BIN_DIR}/../lib/supergraph"
  mkdir -p "${SUPERGRAPH_LIB}"
  if [ -d "${SCRIPT_DIR}/lib" ]; then
    cp -r "${SCRIPT_DIR}/lib/"* "${SUPERGRAPH_LIB}/"
    step_detail "${SUPERGRAPH_LIB}/ ${DIM}(native libs)${RESET}"
  fi
else
  # Download from GitHub releases
  TMP="$(mktemp -d)"
  TARBALL="${TMP}/supergraph.tar.gz"

  download "${RELEASE_URL}" "${TARBALL}" "Downloading binary"

  if [ ! -s "${TARBALL}" ]; then
    step_fail "download failed ${DIM}(empty file)${RESET}"
    rm -rf "${TMP}"; exit 1
  fi
  if ! gzip -t "${TARBALL}" 2>/dev/null; then
    step_fail "download corrupted ${DIM}(truncated gzip — try again)${RESET}"
    rm -rf "${TMP}"; exit 1
  fi

  tar xzf "${TARBALL}" -C "${TMP}"
  rm -f "${TARBALL}"
  mv "${TMP}/supergraph" "${BIN_DIR}/supergraph"
  chmod +x "${BIN_DIR}/supergraph"

  VERSION="$("${BIN_DIR}/supergraph" --version 2>/dev/null || echo "unknown")"
  step_done "Binary installed ${BOLD}${WHITE}${VERSION}${RESET}"
  step_detail "${BIN_DIR}/supergraph"

  # Install native libraries (for Go analysis)
  SUPERGRAPH_LIB="${BIN_DIR}/../lib/supergraph"
  mkdir -p "${SUPERGRAPH_LIB}"
  if [ -d "${TMP}/lib" ]; then
    cp -r "${TMP}/lib/"* "${SUPERGRAPH_LIB}/"
    step_detail "${SUPERGRAPH_LIB}/ ${DIM}(native libs)${RESET}"
  fi
  rm -rf "${TMP}"
fi

# ─── 2. Install Claude Code commands ────────────────────────────
mkdir -p "${CLAUDE_CMD_DIR}"

COMMANDS=("deep-audit" "high-level" "init-supergraph")

if [ "${LOCAL_MODE}" = true ]; then
  CMD_OK=true
  for cmd in "${COMMANDS[@]}"; do
    local_cmd="${SCRIPT_DIR}/commands/${cmd}.md"
    if [ -f "${local_cmd}" ]; then
      cp "${local_cmd}" "${CLAUDE_CMD_DIR}/${cmd}.md"
    else
      CMD_OK=false
    fi
  done

  if [ "${CMD_OK}" = true ]; then
    step_done "Claude Code commands installed ${DIM}(from local repo)${RESET}"
    for cmd in "${COMMANDS[@]}"; do
      step_detail "/${cmd}"
    done
  else
    printf "  ${YELLOW}!${RESET} Some commands not found locally ${DIM}(non-fatal)${RESET}\n"
  fi
else
  spinner_start "Installing Claude Code commands"
  CMD_OK=true
  for cmd in "${COMMANDS[@]}"; do
    if ! curl --http1.1 -fsSL \
         --connect-timeout 10 \
         --max-time 15 \
         --retry 3 \
         --retry-delay 2 \
         --retry-all-errors \
         "${BASE}/commands/${cmd}.md" \
         -o "${CLAUDE_CMD_DIR}/${cmd}.md" 2>/dev/null; then
      CMD_OK=false
    fi
  done
  spinner_stop

  if [ "${CMD_OK}" = true ]; then
    step_done "Claude Code commands installed"
    for cmd in "${COMMANDS[@]}"; do
      step_detail "/${cmd}"
    done
  else
    printf "  ${YELLOW}!${RESET} Some commands failed to install ${DIM}(non-fatal)${RESET}\n"
  fi
fi

# ─── 3. Mark setup done ─────────────────────────────────────────
mkdir -p "$HOME/.supergraph"
date -u +%Y-%m-%dT%H:%M:%SZ > "$HOME/.supergraph/.setup-done"

# ─── Done ────────────────────────────────────────────────────────
echo ""
printf "${GREEN}${BOLD}  ╭─────────────────────────────────────╮${RESET}\n"
printf "${GREEN}${BOLD}  │${RESET}${WHITE}${BOLD}         Installation complete         ${RESET}${GREEN}${BOLD}│${RESET}\n"
printf "${GREEN}${BOLD}  ╰─────────────────────────────────────╯${RESET}\n"
echo ""
printf "  ${WHITE}${BOLD}supergraph${RESET}         ${DIM}run in any repo to generate a full audit${RESET}\n"
printf "  ${WHITE}${BOLD}/init-supergraph${RESET}   ${DIM}bootstrap supergraph on any repo${RESET}\n"
printf "  ${WHITE}${BOLD}/high-level${RESET}        ${DIM}read the full supergraph overview${RESET}\n"
printf "  ${WHITE}${BOLD}/deep-audit${RESET}        ${DIM}10-phase deep package audit${RESET}\n"
echo ""

# ─── PATH check ─────────────────────────────────────────────────
if [[ ":$PATH:" != *":${BIN_DIR}:"* ]]; then
  printf "  ${YELLOW}!${RESET} ${BOLD}${BIN_DIR}${RESET} is not in your PATH. Add it:\n"
  echo ""
  printf "    ${CYAN}echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc${RESET}\n"
  echo ""
fi
