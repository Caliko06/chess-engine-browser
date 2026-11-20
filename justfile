set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

export PATH := env_var("HOME") + "/.cargo/bin:/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:/opt/homebrew/sbin:" + env_var("PATH")
export COREPACK_ENABLE_DOWNLOAD_PROMPT := "0"

# Default quality gate.
default: check

# Install or verify required Phase 0 tools and dependencies.
# If `just` itself is missing, run: bash scripts/setup.sh
setup:
    bash scripts/setup.sh

# Phase 0 check gate: no bootstrapping and no silent skips.
check:
    node scripts/verify-setup.mjs check
    just audit-policy
    just audit-runtime-network
    cargo fmt --all --check
    cargo clippy --workspace --all-targets -- -D warnings
    cargo deny check
    pnpm -r run typecheck
    pnpm -r run lint

# Phase 0 test gate: no oracle/Stockfish dependency.
test:
    node scripts/verify-setup.mjs test
    just audit-policy
    just audit-runtime-network
    node scripts/policy-hardening.test.mjs
    node scripts/preview-static-assets.test.mjs
    node tests/oracle/oracle-status.mjs --self-test
    node scripts/play-local-stockfish-adapter.test.mjs
    cargo nextest run --workspace --all-targets --status-level fail --final-status-level fail --failure-output immediate-final --success-output never --show-progress none
    pnpm -r run test

# Fail if production Rust/TypeScript source contains obvious runtime network calls.
audit-runtime-network:
    node scripts/audit-runtime-network.mjs

# Fail on Phase 0 policy violations: build.rs, runtime deps, artifacts, Stockfish leakage.
audit-policy:
    node scripts/audit-policy.mjs

# Local-only future oracle hook. Not run in CI. Fails closed until tests/oracle has a real harness.
oracle:
    node tests/oracle/oracle-status.mjs

# Owned-engine perft manifest gate without the local Stockfish overlay.
oracle-owned:
    node tests/oracle/oracle-status.mjs --owned-only

# Local deterministic M8 benchmark against the committed baseline.
bench:
    node benches/m8-bench.mjs

# Manual ADR-0153 Play Explore proof. Loads a real Greek-gift FEN and proves Aggressive On
# recomputes the side-oriented Explore surface to a different attacking idea.
proof-play-explore-aggressive:
    node scripts/proof-play-explore-aggressive-toggle.mjs

# Manual ADR-0173 Play Aggressive quality oracle. Uses local Stockfish only as validation evidence;
# it is not a runtime dependency and is not part of check/test/build.
proof-play-aggressive-quality:
    node scripts/proof-play-aggressive-quality-oracle.mjs

# Manual ADR-0227 Play evidence proof. Runs the real local preview, drives Explore moves, and
# checks append-only JSONL evidence on disk.
proof-play-evidence-record:
    node scripts/proof-play-evidence-record.mjs

# ADR-0227/READY_TO_TEST side-by-side baseline/candidate preview comparison.
compare-previews:
    node scripts/compare-previews.mjs

# ADR-0232 G6 native-vs-served-wasm Explore surface parity proof.
proof-explore-surface-parity:
    node scripts/proof-explore-surface-parity.mjs

replay-evidence-trust *ARGS:
    node scripts/replay-evidence-trust.mjs {{ARGS}}

# Offline ADR-0237 Play game archive analyzer. Reads exported JSON/JSONL and optionally uses local
# Stockfish via CHESS_PLAY_STOCKFISH_BIN for ply-by-ply oracle labels.
analyze-play-game-archive *ARGS:
    node scripts/play-game-archive-analyze.mjs {{ARGS}}

# Analyze one saved game by id: finds it in data/play-archive/, runs the local Stockfish
# oracle, and writes the analysis report next to the archive.
analyze *ARGS:
    node scripts/analyze-game.mjs {{ARGS}}

# ADR-0239/ADR-0240 one-command engine memory update: analyze new data/play-archive exports with
# the local Stockfish oracle, recompile refutation memory, regenerate known-gaps, verify harness.
play-memory *ARGS:
    node scripts/play-memory-update.mjs {{ARGS}}

# Same loop left running: re-runs the update whenever a new/changed export appears.
play-memory-watch *ARGS:
    node scripts/play-memory-update.mjs --watch {{ARGS}}

# Manual ADR-0194 game-quality gauntlet. Uses local Stockfish only as validation evidence.
quality-gauntlet *ARGS:
    node tools/quality-gauntlet/run-quality-gauntlet.mjs {{ARGS}}

# Manual ADR-0194 blunder attribution analyzer. Uses local Stockfish only as validation evidence.
quality-attribution *ARGS:
    node tools/quality-gauntlet/attribute-blunders.mjs {{ARGS}}

# Frontend dev hook. No Vite/UI server exists in Phase 0.
dev:
    pnpm --filter web run dev

# Beta 0.1 human preview. Builds ignored local output and serves it on loopback.
preview:
    node scripts/preview-beta-0-1.mjs

# Focused proof for the Beta 0.1 local preview command.
proof-preview:
    node scripts/preview-beta-0-1.mjs --smoke

# Collect manual Aggressive evidence exports from the browser Downloads folder into the durable
# local vault OUTSIDE the repo (default ~/ChessEvidence). Local-only; no network; idempotent.
evidence-sync *ARGS:
    node scripts/evidence-sync.mjs {{ARGS}}

# Public site for calichess.cc (app + guides + sitemap) into target/site.
site:
    node site/build.mjs

# Publish target/site to Cloudflare Pages. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
site-deploy: site
    npx --yes wrangler@4 pages deploy target/site --project-name calichess --branch main --commit-dirty=true

# Release build smoke. Build is gated and scans built web output for runtime network tokens.
build: check
    cargo build --release --workspace
    pnpm --filter web run build
    node scripts/audit-runtime-network.mjs --include-built
