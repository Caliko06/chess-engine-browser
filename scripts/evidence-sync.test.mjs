import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const syncScript = new URL("./evidence-sync.mjs", import.meta.url).pathname;
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    process.stderr.write(`FAIL: ${message}\n`);
    failed++;
  } else {
    process.stdout.write(`PASS: ${message}\n`);
    passed++;
  }
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "evidence-sync-test-"));
}

function makeSession(id, savedAtIso = "2026-06-29T10:00:00.000Z") {
  return {
    id,
    savedAtIso,
    source: "manual-aggressive-explore",
    captureReason: "manual-save",
    playerSide: "white",
    playMode: "opponent",
    aggressive: true,
    engineDepth: 2,
    startFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    currentFen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    moves: [],
    sideExplore: null,
    completedGame: null
  };
}

function makeExport(sessions) {
  return JSON.stringify({ schemaVersion: 1, sessions });
}

function runSync(from, vault, extraArgs = []) {
  execFileSync(process.execPath, [syncScript, "--from", from, "--vault", vault, ...extraArgs], {
    stdio: "pipe"
  });
}

function readVault(vaultDir) {
  const vaultFile = join(vaultDir, "vault.json");
  if (!existsSync(vaultFile)) return null;
  return JSON.parse(readFileSync(vaultFile, "utf8"));
}

// Test 1: initial sync with 2 sessions
{
  const src = makeTempDir();
  const vault = makeTempDir();
  try {
    writeFileSync(
      join(src, "manual-aggressive-evidence.json"),
      makeExport([makeSession("a"), makeSession("b")])
    );
    runSync(src, vault);
    const vaultData = readVault(vault);
    assert(vaultData !== null, "test1: vault.json exists");
    assert(vaultData.sessions.length === 2, "test1: vault has 2 sessions");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
}

// Test 2: dedup merge — second export adds 1 new session (b is a duplicate)
{
  const src = makeTempDir();
  const vault = makeTempDir();
  try {
    writeFileSync(
      join(src, "manual-aggressive-evidence.json"),
      makeExport([makeSession("a"), makeSession("b")])
    );
    runSync(src, vault);
    writeFileSync(
      join(src, "manual-aggressive-evidence-2.json"),
      makeExport([makeSession("b"), makeSession("c")])
    );
    runSync(src, vault);
    const vaultData = readVault(vault);
    assert(vaultData !== null, "test2: vault.json exists after merge");
    assert(vaultData.sessions.length === 3, "test2: vault has 3 sessions after dedup merge");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
}

// Test 3: idempotent — re-run with no new files leaves count at 3
{
  const src = makeTempDir();
  const vault = makeTempDir();
  try {
    writeFileSync(
      join(src, "manual-aggressive-evidence.json"),
      makeExport([makeSession("a"), makeSession("b"), makeSession("c")])
    );
    runSync(src, vault);
    runSync(src, vault);
    const vaultData = readVault(vault);
    assert(vaultData !== null, "test3: vault.json exists after rerun");
    assert(vaultData.sessions.length === 3, "test3: count still 3 after idempotent rerun");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
}

// Test 4: per-session files exist under vault/sessions/
{
  const src = makeTempDir();
  const vault = makeTempDir();
  try {
    writeFileSync(
      join(src, "manual-aggressive-evidence.json"),
      makeExport([makeSession("a"), makeSession("b")])
    );
    runSync(src, vault);
    assert(
      existsSync(join(vault, "sessions", "a.json")),
      "test4: sessions/a.json exists"
    );
    assert(
      existsSync(join(vault, "sessions", "b.json")),
      "test4: sessions/b.json exists"
    );
    const sessionA = JSON.parse(readFileSync(join(vault, "sessions", "a.json"), "utf8"));
    assert(sessionA.id === "a", "test4: sessions/a.json has correct id");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
}

process.stdout.write(`\nevidence-sync.test.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
