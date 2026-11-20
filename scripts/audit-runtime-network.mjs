import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import {
  runtimeNetworkPatterns,
  textWithoutApprovedSameOriginEvidenceConnect
} from "./runtime-network-policy.mjs";

const repoRoot = process.cwd();
const includeBuilt = process.argv.includes("--include-built");
const cargoPath = `${process.env.HOME}/.rustup/toolchains/stable-aarch64-apple-darwin/bin:${process.env.HOME}/.cargo/bin:/opt/homebrew/opt/rustup/bin:/opt/homebrew/sbin:/opt/homebrew/bin:${process.env.PATH ?? ""}`;

const ignoredDirs = new Set([".git", "target", "node_modules", ".pnpm-store"]);
const sourceExtensions = [".rs", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const builtExtensions = [".js", ".mjs", ".cjs", ".html", ".css", ".svg", ".json"];

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

function productionHtmlEntrypoints() {
  return childDirectories(join(repoRoot, "apps"))
    .map((path) => join(path, "index.html"))
    .filter((path) => existsSync(path));
}

function productionCssEntrypoints() {
  return childDirectories(join(repoRoot, "apps")).flatMap((path) =>
    readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
      .map((entry) => join(path, entry.name))
  );
}

function builtRoots() {
  return childDirectories(join(repoRoot, "apps"))
    .map((path) => join(path, "dist"))
    .filter((path) => existsSync(path));
}

function isProductionCargoTarget(target) {
  const kinds = target.kind ?? [];
  return kinds.some((kind) => ["lib", "bin", "cdylib", "staticlib", "proc-macro"].includes(kind));
}

function cargoRustSourceFiles(violations) {
  const result = spawnSync("cargo", ["metadata", "--format-version", "1", "--locked"], {
    env: { ...process.env, PATH: cargoPath },
    encoding: "utf8"
  });
  if (result.status !== 0) {
    violations.push(`cargo metadata --locked failed:\n${result.stderr || result.stdout}`);
    return [];
  }

  const metadata = JSON.parse(result.stdout);
  const workspaceIds = new Set(metadata.workspace_members);
  const files = [];
  for (const pkg of metadata.packages) {
    if (!workspaceIds.has(pkg.id)) {
      continue;
    }
    for (const target of pkg.targets ?? []) {
      if (isProductionCargoTarget(target) && target.src_path) {
        files.push(target.src_path);
      }
    }
  }
  return files;
}

function hasExtension(path, extensions) {
  return extensions.some((extension) => path.endsWith(extension));
}

function walk(path, extensions, files = []) {
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
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) {
      continue;
    }

    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      walk(child, extensions, files);
    } else if (entry.isFile() && hasExtension(child, extensions)) {
      files.push(child);
    }
  }
  return files;
}

function scanFiles(files, violations) {
  for (const file of files) {
    const text = textWithoutApprovedSameOriginEvidenceConnect(readFileSync(file, "utf8"));
    for (const pattern of runtimeNetworkPatternsForFile(file)) {
      if (pattern.regex.test(text)) {
        violations.push(`${relative(repoRoot, file)} contains forbidden runtime token: ${pattern.name}`);
      }
    }
  }
}

function runtimeNetworkPatternsForFile(file) {
  if (file.endsWith(".rs")) {
    return runtimeNetworkPatterns;
  }
  return runtimeNetworkPatterns.filter((pattern) => pattern.name !== "Rust unsafe");
}

const violations = [];
const roots = productionSourceRoots();
const productionFiles = [
  ...roots.flatMap((root) => walk(root, sourceExtensions)),
  ...cargoRustSourceFiles(violations),
  ...productionHtmlEntrypoints(),
  ...productionCssEntrypoints()
];
const uniqueProductionFiles = [...new Set(productionFiles)];
if (uniqueProductionFiles.length === 0) {
  violations.push("No production source roots were found under crates/*/src or apps/*/src.");
}
scanFiles(uniqueProductionFiles, violations);

if (includeBuilt) {
  const outputs = builtRoots();
  if (childDirectories(join(repoRoot, "apps")).length > 0 && outputs.length === 0) {
    violations.push("No built app outputs were found under apps/*/dist for --include-built audit.");
  }
  scanFiles(outputs.flatMap((root) => walk(root, builtExtensions)), violations);
}

if (violations.length > 0) {
  console.error("Runtime network audit failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Runtime network audit passed.");
