import { dirname, join, relative, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  approvedDirectThirdPartyRuntimeDeps,
  validateApprovedThirdPartyRuntimeClosures
} from "./cargo-runtime-closure-policy.mjs";

const repoRoot = process.cwd();
const violations = [];

const excludedDirs = new Set([
  ".git",
  "target",
  "node_modules",
  ".pnpm-store"
]);

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

function trackedFiles() {
  const result = run("git", ["ls-files", "-z"]);
  if (result.status !== 0) {
    violations.push(`git ls-files failed:\n${result.stderr || result.stdout}`);
    return [];
  }
  return result.stdout.split("\0").filter(Boolean);
}

function walk(path, files = []) {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return files;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirs.has(entry.name)) {
      continue;
    }

    const child = join(path, entry.name);
    // Finder metadata is ignored operational noise. Tracked files still pass
    // through the artifact policy, including the data-directory restrictions.
    if (entry.isFile() && entry.name === ".DS_Store" && !trackedSet.has(relative(repoRoot, child))) {
      continue;
    }
    if (entry.isDirectory()) {
      walk(child, files);
    } else if (entry.isFile()) {
      files.push(child);
    }
  }

  return files;
}

const tracked = trackedFiles();
const trackedSet = new Set(tracked);
const allFiles = walk(repoRoot);

const isApprovedIgnoredOperationalBundle = (rel) =>
  !trackedSet.has(rel) && /^tmp\/git-bundles\/[^/]+\.bundle$/u.test(rel);

const bannedArtifactExtensions = new Set([
  ".pgn",
  ".epd",
  ".fen",
  ".cbh",
  ".cbv",
  ".ctg",
  ".abk",
  ".obk",
  ".rtbw",
  ".rtbz",
  ".bin",
  ".exe",
  ".dll",
  ".dylib",
  ".so",
  ".wasm",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".7z",
  ".rar",
  ".bz2",
  ".xz",
  ".zst",
  ".sqlite",
  ".sqlite3",
  ".db"
]);

function scanArtifactPolicy(rel, absolutePath) {
  const lower = rel.toLowerCase();
  const approvedIgnoredOperationalBundle = isApprovedIgnoredOperationalBundle(rel);

  const approvedDataFiles = new Set([
    "data/engine-memory/README.md",
    "data/engine-memory/known-gaps.v1.json",
    "data/engine-memory/last-update-report.json",
    "data/engine-memory/refutations.v1.json",
    "data/openings/explore-aggressive-v1.tsv",
    "data/play-archive/README.md"
  ]);
  // ADR-0242: analyzer outputs are pipeline-generated artifacts. The CLI and the local
  // Analyzer endpoint both write `game-<id>.json` reports beside the archive, so the
  // accepted artifact pattern includes them; they stay under the play-archive contract.
  const approvedGeneratedDataArtifact =
    /^data\/play-archive\/(?:live-\d{4}-\d{2}-\d{2}|imported-[0-9a-f]{12}|play-game-archive(?: \(\d+\))?|game-[a-z0-9][a-z0-9_-]*)\.(?:json|jsonl)$/u.test(rel)
    || /^data\/play-archive\/(?:live-\d{4}-\d{2}-\d{2}|imported-[0-9a-f]{12}|play-game-archive(?: \(\d+\))?|game-[a-z0-9][a-z0-9_-]*)\.analysis\.json$/u.test(rel);

  if (
    rel.startsWith("data/")
    && rel !== "data/.gitkeep"
    && !approvedDataFiles.has(rel)
    && !approvedGeneratedDataArtifact
  ) {
    violations.push(`${rel}: /data is gitignored and only data/.gitkeep may be tracked.`);
  }

  for (const ext of bannedArtifactExtensions) {
    if (lower.endsWith(ext)) {
      violations.push(`${rel}: banned data/blob/binary artifact extension ${ext}.`);
      break;
    }
  }

  const size = statSync(absolutePath).size;
  if (
    size > 1_000_000
    && !rel.endsWith("pnpm-lock.yaml")
    && !rel.endsWith("Cargo.lock")
    && rel !== "data/engine-memory/last-update-report.json"
    && !approvedGeneratedDataArtifact
    && !approvedIgnoredOperationalBundle
  ) {
    violations.push(`${rel}: file is larger than 1 MB and needs an explicit data/artifact policy.`);
  }
}

for (const file of allFiles) {
  scanArtifactPolicy(relative(repoRoot, file), file);
}

function childDirectories(parent) {
  if (!existsSync(parent)) {
    return [];
  }

  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name));
}

function productionSourceRoots() {
  return [
    ...childDirectories(join(repoRoot, "crates")).map((path) => join(path, "src")),
    ...childDirectories(join(repoRoot, "apps")).map((path) => join(path, "src"))
  ].filter((path) => existsSync(path));
}

const productionSourceRootsForScan = productionSourceRoots();
if (productionSourceRootsForScan.length === 0) {
  violations.push("No production source roots were found under crates/*/src or apps/*/src.");
}

const sourceExtensions = [".rs", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const scriptSourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const approvedStockfishSourceReferences = new Map([
  ["apps/web/src/play-engine.ts", "ADR-0117 Play-only adapter mode and fallback seam."],
  ["apps/web/src/play-engine.test.ts", "ADR-0117 Play-only adapter mode and fallback tests."],
  ["apps/web/src/app.ts", "ADR-0117 optional Play-only adapter injection point."],
  ["apps/web/src/app.test.ts", "ADR-0117 optional Play-only adapter app isolation tests."],
  ["apps/web/src/play-ui.ts", "ADR-0117 visible Play engine mode wording."],
  ["apps/web/src/play-ui.test.ts", "ADR-0117 visible Play engine mode wording tests."],
  ["apps/web/src/play-wasm-executor.ts", "ADR-0117 PlayEngine mode contract."]
]);

  // ADR-0242: engine-memory reports are pipeline-generated too (`just play-memory`); the
  // reading view names the real oracle (Stockfish) the way ADR-0117 sanctions engine wording.
  approvedStockfishSourceReferences.set(
    "apps/web/src/ui-localization.ts",
    "ADR-0242 visible Analyzer oracle wording."
  );
  approvedStockfishSourceReferences.set(
    "apps/web/src/analyzer-ui.ts",
    "ADR-0242 Analyzer surface module provenance comment."
  );

const isProductionSourceFile = (path) =>
  sourceExtensions.some((extension) => path.endsWith(extension));

const isScriptSourceFile = (path) =>
  scriptSourceExtensions.some((extension) => path.endsWith(extension));

function isProductionCargoTarget(target) {
  const kinds = target.kind ?? [];
  return kinds.some((kind) => ["lib", "bin", "cdylib", "staticlib", "proc-macro"].includes(kind));
}

function scanStockfishReference(file) {
  if (!isProductionSourceFile(file)) {
    return;
  }
  const text = readFileSync(file, "utf8");
  const rel = relative(repoRoot, file);
  if (/stockfish/i.test(text)) {
    if (!approvedStockfishSourceReferences.has(rel)) {
      violations.push(`${rel}: Stockfish reference in production source.`);
    }
  }
}

function scanStockfishAdapterScriptImport(file) {
  if (!isProductionSourceFile(file)) {
    return;
  }
  const text = readFileSync(file, "utf8");
  const rel = relative(repoRoot, file);
  if (/play-local-stockfish-adapter|createLocalStockfishBestMoveProvider/u.test(text)) {
    violations.push(`${rel}: production source must not import the script-side Stockfish adapter.`);
  }
}

function isBareModuleSpecifier(specifier) {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("#") && !specifier.startsWith("node:");
}

function scanRuntimeNpmImports(file) {
  if (!isScriptSourceFile(file)) {
    return;
  }
  const text = readFileSync(file, "utf8");
  const importPatterns = [
    /\bimport\s+(?:type\s+)?(?:[^"']+\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\bexport\s+(?:type\s+)?[^"']+\s+from\s+["']([^"']+)["']/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu
  ];
  for (const regex of importPatterns) {
    for (const match of text.matchAll(regex)) {
      const specifier = match[1];
      if (isBareModuleSpecifier(specifier)) {
        violations.push(
          `${relative(repoRoot, file)}: production source imports npm package ${specifier}; runtime npm dependencies require an ADR.`
        );
      }
    }
  }
}

for (const root of productionSourceRootsForScan) {
  for (const file of walk(root)) {
    scanStockfishReference(file);
    scanStockfishAdapterScriptImport(file);
    scanRuntimeNpmImports(file);
  }
}

const packageManifestPaths = allFiles
  .map((path) => relative(repoRoot, path))
  .filter((path) => path.endsWith("package.json"));
for (const manifestPath of packageManifestPaths) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, manifestPath), "utf8"));
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = manifest[field] ?? {};
    const names = Object.keys(deps);
    if (names.length > 0) {
      violations.push(`${manifestPath}: ${field} must be empty unless an ADR approves runtime npm dependencies; found ${names.join(", ")}.`);
    }
  }
}

const metadataResult = run("cargo", ["metadata", "--format-version", "1", "--locked"]);
const wasmMetadataResult = run("cargo", [
  "metadata",
  "--format-version",
  "1",
  "--locked",
  "--filter-platform",
  "wasm32-unknown-unknown"
]);

if (metadataResult.status !== 0) {
  violations.push(`cargo metadata --locked failed:\n${metadataResult.stderr || metadataResult.stdout}`);
} else {
  const metadata = JSON.parse(metadataResult.stdout);
  const workspaceIds = new Set(metadata.workspace_members);
  const workspaceManifestDirs = new Set(
    metadata.packages
      .filter((pkg) => workspaceIds.has(pkg.id))
      .map((pkg) => dirname(resolve(pkg.manifest_path)))
  );

  for (const crateDir of childDirectories(join(repoRoot, "crates"))) {
    const manifestPath = join(crateDir, "Cargo.toml");
    if (existsSync(manifestPath) && !workspaceManifestDirs.has(resolve(crateDir))) {
      violations.push(`${relative(repoRoot, manifestPath)}: crates/* packages must be Cargo workspace members.`);
    }
  }

  const workspacePackageNames = new Set(
    metadata.packages.filter((pkg) => workspaceIds.has(pkg.id)).map((pkg) => pkg.name)
  );
  const allowedWorkspaceRuntimeDeps = new Map([
    ["chess-board", new Set()],
    ["chess-eval", new Set(["chess-board"])],
    ["chess-search", new Set(["chess-board", "chess-eval"])],
    ["chess-openings", new Set(["chess-board"])],
    ["chess-endgames", new Set(["chess-board"])],
    ["chess-coach", new Set(["chess-board", "chess-search"])],
    ["chess-wasm-bridge", new Set(["chess-board", "chess-eval", "chess-search", "chess-coach"])],
    ["chess-cli", new Set(["chess-board", "chess-eval", "chess-search", "chess-openings", "chess-endgames", "chess-coach"])],
    ["chess-tuner", new Set(["chess-board", "chess-eval"])],
  ]);
  const approvedThirdPartyRuntimeDeps = approvedDirectThirdPartyRuntimeDeps();

  for (const pkg of metadata.packages) {
    if (!workspaceIds.has(pkg.id)) {
      continue;
    }

    for (const target of pkg.targets ?? []) {
      if (isProductionCargoTarget(target) && target.src_path) {
        scanStockfishReference(target.src_path);
      }
    }

    for (const target of pkg.targets ?? []) {
      if ((target.kind ?? []).includes("custom-build")) {
        violations.push(`${pkg.name}: custom Cargo build script target ${target.name} is banned unless an ADR and audit allow it.`);
      }
    }

    for (const dep of pkg.dependencies) {
      if (dep.kind === "build") {
        violations.push(`${pkg.name}: build dependency ${dep.name} is banned unless an ADR and audit allow a build script.`);
      }

      if (dep.kind === null) {
        if (dep.source !== null) {
          if (approvedThirdPartyRuntimeDeps.get(pkg.name)?.has(dep.name)) {
            continue;
          }

          violations.push(`${pkg.name}: third-party runtime dependency ${dep.name} requires an ADR.`);
          continue;
        }

        if (dep.path !== undefined) {
          const resolvedDepPath = resolve(dep.path);
          const isWorkspacePath = workspaceManifestDirs.has(resolvedDepPath);
          if (!isWorkspacePath) {
            violations.push(`${pkg.name}: non-workspace path runtime dependency ${dep.name} requires an ADR.`);
            continue;
          }

          if (workspacePackageNames.has(dep.name)) {
            const allowed = allowedWorkspaceRuntimeDeps.get(pkg.name) ?? new Set();
            if (!allowed.has(dep.name)) {
              violations.push(`${pkg.name}: workspace runtime dependency on ${dep.name} violates the approved dependency direction.`);
            }
          }
        }
      }
    }
  }

  violations.push(...validateApprovedThirdPartyRuntimeClosures(metadata));
}

if (wasmMetadataResult.status !== 0) {
  violations.push(
    `cargo metadata --locked --filter-platform wasm32-unknown-unknown failed:\n${wasmMetadataResult.stderr || wasmMetadataResult.stdout}`
  );
} else {
  const wasmMetadata = JSON.parse(wasmMetadataResult.stdout);
  violations.push(
    ...validateApprovedThirdPartyRuntimeClosures(wasmMetadata).map(
      (violation) => `wasm32-unknown-unknown graph: ${violation}`
    )
  );
}

for (const file of allFiles) {
  const rel = relative(repoRoot, file);
  if (rel.endsWith("build.rs")) {
    violations.push(`${rel}: build.rs files are banned unless an ADR and audit allow a build script.`);
  }
}

if (violations.length > 0) {
  console.error("Policy audit failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Policy audit passed.");
