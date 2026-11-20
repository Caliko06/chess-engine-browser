#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
export HOMEBREW_NO_AUTO_UPDATE="${HOMEBREW_NO_AUTO_UPDATE:-1}"
export HOMEBREW_NO_INSTALL_CLEANUP="${HOMEBREW_NO_INSTALL_CLEANUP:-1}"
export HOMEBREW_NO_ENV_HINTS="${HOMEBREW_NO_ENV_HINTS:-1}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

if ! need_cmd brew; then
  echo "Homebrew is required for local macOS bootstrap. Install Homebrew, then rerun this script." >&2
  exit 1
fi

if ! need_cmd just; then
  echo "Installing just with Homebrew..."
  brew install just
fi

if ! need_cmd rustup; then
  echo "Installing rustup with Homebrew..."
  brew install rustup
  export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
fi

if ! need_cmd rustup; then
  echo "rustup is still unavailable after installation. Expected /opt/homebrew/opt/rustup/bin/rustup." >&2
  exit 1
fi

echo "Installing/verifying Rust stable with rustfmt and clippy..."
rustup toolchain install stable --profile minimal --component rustfmt --component clippy
rustup default stable >/dev/null

if ! cargo nextest --version >/dev/null 2>&1; then
  echo "Installing cargo-nextest with Homebrew..."
  brew install cargo-nextest
fi

if ! cargo deny --version >/dev/null 2>&1; then
  echo "Installing cargo-deny with Homebrew..."
  brew install cargo-deny
fi

if ! need_cmd node; then
  echo "Node 22+ is required. Install Node 22 or 24, then rerun this script." >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(`.`)[0]')"
if [[ "$node_major" != "22" && "$node_major" != "24" ]]; then
  echo "Node 22 or 24 is required; found $(node --version)." >&2
  exit 1
fi

if ! need_cmd corepack; then
  echo "Corepack is required for pnpm. Install/enable Corepack with Node, then rerun this script." >&2
  exit 1
fi

echo "Preparing pnpm 11.1.1 with Corepack..."
corepack enable
corepack prepare pnpm@11.1.1 --activate

if [[ "${CI:-}" == "true" && -f pnpm-lock.yaml ]]; then
  pnpm install --frozen-lockfile
else
  pnpm install
fi

echo "Generating/verifying Cargo.lock..."
cargo generate-lockfile

node scripts/verify-setup.mjs setup

echo "Setup complete."
