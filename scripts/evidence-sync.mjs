import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const SCRIPT_NAME = "evidence-sync";
const EXPORT_PATTERN = /^manual-aggressive-evidence.*\.json$/i;

function usage() {
  process.stdout.write(
    `Usage: node scripts/evidence-sync.mjs [options]\n` +
    `\n` +
    `Options:\n` +
    `  --from <dir>    Source dir (default: CHESS_EVIDENCE_DOWNLOADS or ~/Downloads)\n` +
    `  --vault <dir>   Vault dir  (default: CHESS_EVIDENCE_DIR or ~/ChessEvidence/aggressive)\n` +
    `  --prune         Delete consumed source files after a successful merge\n` +
    `  --watch         Re-run on changes in the source dir\n` +
    `  --help          Show this message\n`
  );
}

function repoRoot() {
  const scriptDir = new URL(".", import.meta.url).pathname;
  return resolve(scriptDir, "..");
}

function isInsideRepo(dir) {
  const root = repoRoot();
  const rel = relative(root, resolve(dir));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function parseArgs(argv) {
  const args = { from: null, vault: null, prune: false, watch: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--prune") {
      args.prune = true;
    } else if (arg === "--watch") {
      args.watch = true;
    } else if (arg === "--from") {
      args.from = argv[++i] ?? null;
    } else if (arg === "--vault") {
      args.vault = argv[++i] ?? null;
    } else {
      process.stderr.write(`${SCRIPT_NAME}: unknown argument: ${arg}\n`);
      process.exit(1);
    }
  }
  return args;
}

function resolveSource(fromArg) {
  if (fromArg) return resolve(fromArg);
  if (process.env.CHESS_EVIDENCE_DOWNLOADS) return resolve(process.env.CHESS_EVIDENCE_DOWNLOADS);
  return join(homedir(), "Downloads");
}

function resolveVault(vaultArg) {
  if (vaultArg) return resolve(vaultArg);
  if (process.env.CHESS_EVIDENCE_DIR) return resolve(process.env.CHESS_EVIDENCE_DIR);
  return join(homedir(), "ChessEvidence", "aggressive");
}

function validateSession(session) {
  return (
    session !== null &&
    typeof session === "object" &&
    typeof session.id === "string"
  );
}

function validateExport(parsed) {
  return (
    parsed !== null &&
    typeof parsed === "object" &&
    parsed.schemaVersion === 1 &&
    Array.isArray(parsed.sessions) &&
    parsed.sessions.every(validateSession)
  );
}

function loadVault(vaultFile) {
  if (!existsSync(vaultFile)) return { schemaVersion: 1, sessions: [] };
  try {
    const text = readFileSync(vaultFile, "utf8");
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.sessions)) {
      return parsed;
    }
    process.stderr.write(`${SCRIPT_NAME}: warning: vault.json is corrupt; treating as empty\n`);
    return { schemaVersion: 1, sessions: [] };
  } catch {
    process.stderr.write(`${SCRIPT_NAME}: warning: could not read vault.json; treating as empty\n`);
    return { schemaVersion: 1, sessions: [] };
  }
}

function safeId(id) {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

function runSync(sourceDir, vaultDir, prune) {
  if (!existsSync(sourceDir)) {
    process.stdout.write(`${SCRIPT_NAME}: source dir not found: ${sourceDir}\n`);
    return;
  }

  const entries = readdirSync(sourceDir)
    .filter((name) => EXPORT_PATTERN.test(name))
    .map((name) => {
      const full = join(sourceDir, name);
      return { name, full, mtime: statSync(full).mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime);

  if (entries.length === 0) {
    process.stdout.write(`${SCRIPT_NAME}: no export files found in ${sourceDir}\n`);
    return;
  }

  mkdirSync(vaultDir, { recursive: true });
  const sessionsDir = join(vaultDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const vaultFile = join(vaultDir, "vault.json");
  const existing = loadVault(vaultFile);
  const byId = new Map();
  for (const session of existing.sessions) {
    byId.set(session.id, session);
  }

  const prevCount = byId.size;
  let dupes = 0;
  const consumed = [];

  for (const entry of entries) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(entry.full, "utf8"));
    } catch {
      process.stderr.write(`${SCRIPT_NAME}: warning: skipping invalid JSON: ${entry.name}\n`);
      continue;
    }
    if (!validateExport(parsed)) {
      process.stderr.write(`${SCRIPT_NAME}: warning: skipping invalid schema: ${entry.name}\n`);
      continue;
    }
    for (const session of parsed.sessions) {
      if (byId.has(session.id)) {
        dupes++;
      } else {
        byId.set(session.id, session);
      }
    }
    consumed.push(entry.full);
  }

  const merged = [...byId.values()].sort((a, b) => {
    const ai = a.savedAtIso ?? "";
    const bi = b.savedAtIso ?? "";
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });

  const newCount = byId.size - prevCount;
  const totalCount = byId.size;

  const vault = { schemaVersion: 1, sessions: merged };
  writeFileSync(vaultFile, JSON.stringify(vault, null, 2), "utf8");

  for (const session of merged) {
    writeFileSync(
      join(sessionsDir, `${safeId(session.id)}.json`),
      JSON.stringify(session, null, 2),
      "utf8"
    );
  }

  process.stdout.write(
    `${SCRIPT_NAME}: +${newCount} new (${totalCount} total) from ${sourceDir} -> ${vaultDir}; ${dupes} duplicates skipped\n`
  );

  if (prune) {
    for (const path of consumed) {
      try {
        unlinkSync(path);
      } catch {
        process.stderr.write(`${SCRIPT_NAME}: warning: could not prune ${path}\n`);
      }
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    usage();
    process.exit(0);
  }

  const sourceDir = resolveSource(args.from);
  const vaultDir = resolveVault(args.vault);

  if (isInsideRepo(vaultDir)) {
    process.stderr.write(
      `${SCRIPT_NAME}: error: vault dir is inside the repo (${vaultDir}).\n` +
      `  This will trip just audit-policy / just preview. Use a path outside the repo.\n`
    );
    process.exit(1);
  }

  runSync(sourceDir, vaultDir, args.prune);

  if (args.watch) {
    let debounce = null;
    process.stdout.write(`${SCRIPT_NAME}: watching ${sourceDir} ...\n`);
    watch(sourceDir, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        runSync(sourceDir, vaultDir, args.prune);
      }, 300);
    });
  }
}

main();
