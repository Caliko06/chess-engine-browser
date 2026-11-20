import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { basename, extname, join, relative } from "node:path";
import { runtimeNetworkPatterns } from "./runtime-network-policy.mjs";
const repoRoot = new URL("../", import.meta.url).pathname;
const proofRoot = "/private/tmp/chess-p2-17-browser-delivery-proof";
const cargoPath = `${process.env.HOME}/.cargo/bin:/opt/homebrew/opt/rustup/bin:/opt/homebrew/sbin:/opt/homebrew/bin:${process.env.PATH ?? ""}`;
const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'";
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, PATH: cargoPath },
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
function walk(root, files = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      walk(path, files);
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}
function assertBrowserRuntimeImports(root) {
  const importPattern =
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/gu;
  const violations = [];
  for (const file of walk(root).filter((path) => path.endsWith(".js") || path.endsWith(".mjs"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2] ?? "";
      if (
        (specifier.startsWith("./") || specifier.startsWith("../")) &&
        !specifier.endsWith(".js") &&
        !specifier.endsWith(".mjs")
      ) {
        violations.push(`${relative(repoRoot, file)} imports ${specifier} without a browser extension`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`Browser ESM import proof failed:\n${violations.join("\n")}`);
  }
}
function assertWasmBindgenCliVersion() {
  const result = spawnSync("wasm-bindgen", ["--version"], {
    cwd: repoRoot,
    env: { ...process.env, PATH: cargoPath },
    encoding: "utf8"
  });
  const version = `${result.stdout}${result.stderr}`.trim();
  if (result.status !== 0 || version !== "wasm-bindgen 0.2.121") {
    throw new Error(`P2.17 proof requires wasm-bindgen 0.2.121, got ${version || "unavailable"}`);
  }
}
function writeEmbeddedWasmModule() {
  const wasmBytes = Array.from(readFileSync(join(proofRoot, "pkg", "chess_wasm_bridge_bg.wasm")));
  writeFileSync(
    join(proofRoot, "pkg", "chess_wasm_bridge_embedded.mjs"),
    `import { __wbg_set_wasm, __wbindgen_init_externref_table, review_pgn_json } from "./chess_wasm_bridge_bg.js";
const wasmBytes = new Uint8Array([${wasmBytes.join(",")}]);
const wasmModule = new WebAssembly.Module(wasmBytes);
const wasmImports = WebAssembly.Module.imports(wasmModule);
const expectedWasmImports = [{ module: "./chess_wasm_bridge_bg.js", name: "__wbindgen_init_externref_table", kind: "function" }];
if (JSON.stringify(wasmImports) !== JSON.stringify(expectedWasmImports)) {
  throw new Error("embedded wasm delivery import mismatch: " + JSON.stringify(wasmImports));
}
const wasmInstance = new WebAssembly.Instance(wasmModule, {
  "./chess_wasm_bridge_bg.js": { __wbindgen_init_externref_table }
});
__wbg_set_wasm(wasmInstance.exports);
wasmInstance.exports.__wbindgen_start();
export { review_pgn_json };
`
  );
}
function copyBuiltWeb() {
  const webRoot = join(proofRoot, "web");
  mkdirSync(webRoot, { recursive: true });
  for (const file of walk(join(repoRoot, "apps/web/dist"))) {
    if (file.endsWith(".js")) {
      copyFileSync(file, join(webRoot, basename(file)));
    }
  }
}
function writeHarness() {
  writeFileSync(
    join(proofRoot, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>P2.17 browser delivery proof</title><body data-proof="pending"><script type="module" src="./harness.mjs"></script></body>`
  );
  writeFileSync(
    join(proofRoot, "harness.mjs"),
    `function assert(condition, label) {
  if (!condition) {
    throw new Error(label);
  }
}
function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}
try {
  const [{ createReviewWasmExecutor }, { mountReviewUi }, reviewModule] = await Promise.all([
    import("./web/review-wasm-executor.js"),
    import("./web/review-ui.js"),
    import("./pkg/chess_wasm_bridge_embedded.mjs")
  ]);
  assert(typeof mountReviewUi === "function", "review UI module graph should load without mounting");
  const reviewPgn = createReviewWasmExecutor(() => Promise.resolve(reviewModule));
  const valid = await reviewPgn({ pgn: "1. f3 e5 2. g4 Qh4# 0-1", depth: 3 });
  assert(valid.ok === true, "valid inline PGN should review through owned wasm");
  assert(Object.keys(valid.review).sort().join(",") === "entries,summary", "review output should stay core only");
  assert(valid.review.summary.totalMoves > 0, "review should include entries");
  assert(!JSON.stringify(valid).includes("1. f3"), "raw PGN must not be echoed");
  assertEqual(await reviewPgn({ pgn: "", depth: 3 }), { ok: false, error: "invalid-pgn" }, "empty PGN");
  assertEqual(await reviewPgn({ pgn: "1. e4 *", depth: 1 }), { ok: false, error: "invalid-depth" }, "low depth");
  assertEqual(await reviewPgn({ pgn: "1. e4 *", depth: 7 }), { ok: false, error: "invalid-depth" }, "high depth");
  assertEqual(await reviewPgn({ pgn: "1. e4 {comment} *", depth: 3 }), { ok: false, error: "invalid-pgn" }, "unsupported comments");
  document.body.dataset.proof = "pass";
  document.body.textContent = JSON.stringify({ status: "pass", entries: valid.review.entries.length });
} catch (error) {
  document.body.dataset.proof = "fail";
  document.body.textContent = error instanceof Error ? error.message : String(error);
}
`
  );
}
function scanProofOutput() {
  const files = [
    join(proofRoot, "index.html"),
    join(proofRoot, "harness.mjs"),
    ...walk(join(proofRoot, "pkg")).filter((file) => file.endsWith(".js") || file.endsWith(".mjs")),
    ...walk(join(proofRoot, "web")).filter((file) => file.endsWith(".js"))
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const pattern of runtimeNetworkPatterns) {
      if (pattern.regex.test(text)) {
        throw new Error(`${file} contains forbidden runtime token: ${pattern.name}`);
      }
    }
    for (const token of ["localStorage", "randomUUID", "Worker", "ServiceWorker", "importmap"]) {
      if (text.includes(token)) {
        throw new Error(`${file} contains forbidden delivery-proof token: ${token}`);
      }
    }
  }
}
function contentType(path) {
  return extname(path) === ".html" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8";
}
async function startStaticServer() {
  const files = new Map(
    walk(proofRoot).map((file) => [`/${relative(proofRoot, file).split("/").map(encodeURIComponent).join("/")}`, file])
  );
  const requests = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(pathname);
    const path = pathname === "/" ? files.get("/index.html") : files.get(pathname);
    response.setHeader("Content-Security-Policy", csp);
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (path === undefined || !statSync(path).isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "Content-Type": contentType(path) });
    response.end(readFileSync(path));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, requests, port: server.address().port };
}
function chromePath() {
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(macChrome) ? macChrome : "google-chrome";
}
async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function connectCdp(debugPort) {
  const deadline = Date.now() + 10_000;
  let webSocketUrl = "";
  while (Date.now() < deadline && webSocketUrl === "") {
    try {
      const tabs = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      webSocketUrl = tabs.find((tab) => tab.type === "page")?.webSocketDebuggerUrl ?? "";
    } catch {
      await delay(100);
    }
  }
  if (webSocketUrl === "") {
    throw new Error("CDP endpoint was not available");
  }
  const websocket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;
  websocket.addEventListener("message", (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    const command = pending.get(message.id);
    if (command === undefined) {
      return;
    }
    pending.delete(message.id);
    message.error === undefined ? command.resolve(message.result ?? {}) : command.reject(new Error(message.error.message));
  });
  await new Promise((resolve, reject) => {
    websocket.addEventListener("open", resolve, { once: true });
    websocket.addEventListener("error", () => reject(new Error("Could not open CDP WebSocket")), { once: true });
  });
  return {
    close: () => websocket.close(),
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { resolve, reject });
        websocket.send(JSON.stringify({ id, method, params }));
      })
  };
}
async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.text);
  }
  return result.result?.value;
}
async function runBrowserProof(url, debugPort) {
  const chrome = spawn(chromePath(), [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${join(proofRoot, "chrome-profile")}`,
    "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let cdp;
  try {
    cdp = await connectCdp(debugPort);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const state = await evaluate(cdp, "document.body?.dataset?.proof ?? 'pending'");
      if (state === "pass") {
        return;
      }
      if (state === "fail") {
        throw new Error(await evaluate(cdp, "document.body?.textContent ?? ''"));
      }
      await delay(250);
    }
    throw new Error(await evaluate(cdp, "document.documentElement?.outerHTML ?? ''"));
  } finally {
    if (cdp !== undefined) {
      await cdp.send("Browser.close").catch(() => {});
      cdp.close();
    }
    chrome.kill();
  }
}
rmSync(proofRoot, { recursive: true, force: true });
mkdirSync(join(proofRoot, "pkg"), { recursive: true });
run("node", ["scripts/audit-policy.mjs"]);
run("pnpm", ["--filter", "web", "run", "build"]);
assertBrowserRuntimeImports(join(repoRoot, "apps/web/dist"));
assertWasmBindgenCliVersion();
run("cargo", ["build", "-p", "chess-wasm-bridge", "--target", "wasm32-unknown-unknown", "--release"]);
run("wasm-bindgen", [
  "target/wasm32-unknown-unknown/release/chess_wasm_bridge.wasm",
  "--target",
  "bundler",
  "--out-dir",
  join(proofRoot, "pkg")
]);
writeEmbeddedWasmModule();
copyBuiltWeb();
writeHarness();
scanProofOutput();
const { server, requests, port } = await startStaticServer();
try {
  await runBrowserProof(`http://127.0.0.1:${port}/index.html`, port + 1);
} finally {
  server.close();
}
if (requests.some((request) => request.endsWith(".wasm"))) {
  throw new Error(`P2.17 proof requested a .wasm asset: ${requests.join(", ")}`);
}
if (requests.includes("/review-workflow") || requests.includes("/review-store")) {
  throw new Error(`P2.17 proof used extensionless delivery aliases: ${requests.join(", ")}`);
}
console.log("P2.17 browser delivery proof passed.");
