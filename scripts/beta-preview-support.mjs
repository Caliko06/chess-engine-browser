import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, extname, join, relative } from "node:path";
import {
  runtimeNetworkPatterns,
  textWithoutApprovedSameOriginEvidenceConnect
} from "./runtime-network-policy.mjs";

export const repoRoot = new URL("../", import.meta.url).pathname;
export const betaCsp =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'";

const cargoPath = `${process.env.HOME}/.cargo/bin:/opt/homebrew/opt/rustup/bin:/opt/homebrew/sbin:/opt/homebrew/bin:${process.env.PATH ?? ""}`;
const expectedWasmBindgenVersion = "wasm-bindgen 0.2.121";

export function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, PATH: cargoPath },
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function walk(root, files = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, files);
    if (entry.isFile()) files.push(path);
  }
  return files;
}

export function assertNoRuntimeNetworkTokens(file, text) {
  const scannedText = textWithoutApprovedSameOriginEvidenceConnect(text);
  const patterns = file.endsWith(".rs")
    ? runtimeNetworkPatterns
    : runtimeNetworkPatterns.filter((pattern) => pattern.name !== "Rust unsafe");
  for (const pattern of patterns) {
    if (pattern.regex.test(scannedText)) {
      throw new Error(`${file} contains forbidden runtime token: ${pattern.name}`);
    }
  }
}

export function assertNoInlineStyles(file, text) {
  if (/<style\b/iu.test(text)) throw new Error(`${file} contains forbidden inline style element`);
  if (/\sstyle\s*=/iu.test(text)) {
    throw new Error(`${file} contains forbidden inline style attribute`);
  }
}

export function assertWasmBindgenCliVersion(label) {
  const result = spawnSync("wasm-bindgen", ["--version"], {
    cwd: repoRoot,
    env: { ...process.env, PATH: cargoPath },
    encoding: "utf8"
  });
  const version = `${result.stdout}${result.stderr}`.trim();
  if (result.status !== 0 || version !== expectedWasmBindgenVersion) {
    throw new Error(`${label} requires ${expectedWasmBindgenVersion}, got ${version || "unavailable"}`);
  }
}

export function copyBuiltWeb(outputRoot) {
  const sourceRoot = join(repoRoot, "apps/web/dist");
  const distRoot = join(outputRoot, "dist");
  mkdirSync(distRoot, { recursive: true });
  for (const file of walk(sourceRoot)) {
    if (file.endsWith(".js")) {
      const target = join(distRoot, relative(sourceRoot, file));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file, target);
    }
  }
}

export function copyProductHtml(outputRoot, options) {
  const source = join(repoRoot, "apps/web/index.html");
  if (options.missingMessage !== undefined && !existsSync(source)) {
    throw new Error(options.missingMessage);
  }

  const html = readFileSync(source, "utf8");
  if (options.scanBeforeChecks === true) {
    assertNoRuntimeNetworkTokens(source, html);
    assertNoInlineStyles(source, html);
  }
  assertProductHtmlCsp(html, options);
  for (const requirement of options.requiredIncludes) {
    if (!html.includes(requirement.text)) throw new Error(requirement.message);
  }
  if (options.scanBeforeChecks !== true) {
    assertNoRuntimeNetworkTokens(source, html);
    assertNoInlineStyles(source, html);
  }
  copyFileSync(source, join(outputRoot, "index.html"));
}

export function copyProductCss(outputRoot, options = {}) {
  const source = join(repoRoot, "apps/web/review.css");
  if (options.missingMessage !== undefined && !existsSync(source)) {
    throw new Error(options.missingMessage);
  }
  const css = readFileSync(source, "utf8");
  assertNoRuntimeNetworkTokens(source, css);
  copyFileSync(source, join(outputRoot, "review.css"));
  const playSource = join(repoRoot, "apps/web/play.css");
  assertNoRuntimeNetworkTokens(playSource, readFileSync(playSource, "utf8"));
  copyFileSync(playSource, join(outputRoot, "play.css"));
  const analyzerSource = join(repoRoot, "apps/web/analyzer.css");
  if (existsSync(analyzerSource)) {
    assertNoRuntimeNetworkTokens(analyzerSource, readFileSync(analyzerSource, "utf8"));
    copyFileSync(analyzerSource, join(outputRoot, "analyzer.css"));
  }
  copyWebAssets(outputRoot);
}

export function copyWebAssets(outputRoot) {
  const sourceRoot = join(repoRoot, "apps/web/assets");
  if (!existsSync(sourceRoot)) {
    return;
  }
  for (const file of walk(sourceRoot)) {
    const relativePath = file.slice(sourceRoot.length + 1);
    const destination = join(outputRoot, "assets", relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(file, destination);
  }
}

export function writeEmbeddedWasmModule(outputRoot, options = {}) {
  const pkgRoot = join(outputRoot, "dist/pkg");
  const wasmPath = join(pkgRoot, "chess_wasm_bridge_bg.wasm");
  const wasmBytes = Array.from(readFileSync(wasmPath));
  const importAssertion =
    options.assertExpectedImports === true
      ? `const wasmImports = WebAssembly.Module.imports(wasmModule);
const expectedWasmImports = [{ module: "./chess_wasm_bridge_bg.js", name: "__wbindgen_init_externref_table", kind: "function" }];
if (JSON.stringify(wasmImports) !== JSON.stringify(expectedWasmImports)) {
  throw new Error("embedded wasm delivery import mismatch: " + JSON.stringify(wasmImports));
}
`
      : "";

  writeFileSync(
    join(pkgRoot, "chess_wasm_bridge_embedded.mjs"),
    `import { __wbg_set_wasm, __wbindgen_init_externref_table, best_move_context_json, best_move_json, best_move_user_context_json, engine_move_json, forcing_map_json, make_move_json, new_game_json, position_json, reaction_map_json, review_pgn_json, review_pgn_with_artifacts_json, side_explore_context_json, side_explore_context_v2_json, side_explore_json } from "./chess_wasm_bridge_bg.js";
const wasmBytes = new Uint8Array([${wasmBytes.join(",")}]);
const wasmModule = new WebAssembly.Module(wasmBytes);
${importAssertion}const wasmInstance = new WebAssembly.Instance(wasmModule, {
  "./chess_wasm_bridge_bg.js": { __wbindgen_init_externref_table }
});
__wbg_set_wasm(wasmInstance.exports);
wasmInstance.exports.__wbindgen_start();
export { best_move_context_json, best_move_json, best_move_user_context_json, engine_move_json, forcing_map_json, make_move_json, new_game_json, position_json, reaction_map_json, review_pgn_json, review_pgn_with_artifacts_json, side_explore_context_json, side_explore_context_v2_json, side_explore_json };
`
  );

  if (options.removeWasmAsset === true) {
    rmSync(wasmPath, { force: true });
  }
}

export function scanStaticOutput(root, options = {}) {
  const scannedFiles = walk(root).filter((path) => /\.(?:html|js|mjs|css)$/u.test(path));
  for (const file of scannedFiles) {
    const text = readFileSync(file, "utf8");
    assertNoRuntimeNetworkTokens(file, text);
    assertNoInlineStyles(file, text);
  }
  for (const token of options.extraForbiddenTokens ?? []) {
    for (const file of scannedFiles) {
      if (readFileSync(file, "utf8").includes(token)) {
        throw new Error(`${file} contains forbidden token: ${token}`);
      }
    }
  }
}

export const servedStaticExtensions = [
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".svg"
];

export function contentType(path) {
  if (extname(path) === ".html") return "text/html; charset=utf-8";
  if (extname(path) === ".css") return "text/css; charset=utf-8";
  if (extname(path) === ".jpg" || extname(path) === ".jpeg") return "image/jpeg";
  if (extname(path) === ".png") return "image/png";
  if (extname(path) === ".webp") return "image/webp";
  if (extname(path) === ".svg") return "image/svg+xml";
  return "text/javascript; charset=utf-8";
}

function assertProductHtmlCsp(html, options) {
  if (options.cspCheck === "meta") {
    const metaCsp =
      html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u)?.[1] ??
      html.match(/content="([^"]+)"\s+http-equiv="Content-Security-Policy"/u)?.[1] ??
      "";
    if (metaCsp !== betaCsp) throw new Error(resolveCspMessage(options, metaCsp));
    return;
  }

  if (!html.includes(`content="${betaCsp}"`)) {
    throw new Error(resolveCspMessage(options, ""));
  }
}

function resolveCspMessage(options, actualCsp) {
  return typeof options.cspMismatchMessage === "function"
    ? options.cspMismatchMessage(actualCsp)
    : options.cspMismatchMessage;
}
