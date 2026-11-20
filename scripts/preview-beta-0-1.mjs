import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import {
  assertWasmBindgenCliVersion,
  betaCsp,
  contentType,
  copyBuiltWeb,
  copyProductCss,
  copyProductHtml,
  repoRoot,
  run,
  scanStaticOutput,
  servedStaticExtensions,
  walk,
  writeEmbeddedWasmModule
} from "./beta-preview-support.mjs";
import { handleAnalyzerAnalyze } from "./preview-analyzer-endpoint.mjs";

const smokeMode = process.argv.includes("--smoke");
// --build-only: write target/preview and exit (scripts/build-site.mjs builds calichess.cc from it).
const buildOnly = process.argv.includes("--build-only");
const previewRoot = join(repoRoot, "target", smokeMode ? "preview-smoke" : "preview");
const csp = betaCsp;
const evidenceRoot = smokeMode ? join(previewRoot, "smoke-evidence") : join(repoRoot, "tmp/play-evidence");
// ADR-0241: saved game archive records land inside the repo (gitignored) so
// `just play-memory` / `just play-memory-watch` pick them up with zero manual export.
const gameArchiveRoot = smokeMode ? join(previewRoot, "smoke-game-archive") : join(repoRoot, "data/play-archive");
const analyzerOutputRoot = smokeMode ? join(previewRoot, "smoke-analyzer") : join(repoRoot, "tmp/analyzer");
let servedPreviewWasmSha256 = "unknown";

function preparePreviewOutput() {
  rmSync(previewRoot, { recursive: true, force: true });
  mkdirSync(join(previewRoot, "dist/pkg"), { recursive: true });
  run("node", ["scripts/audit-policy.mjs"]);
  run("pnpm", ["--filter", "web", "run", "build"]);
  assertWasmBindgenCliVersion("Beta 0.2 preview");
  // OpSec: Rust keeps absolute source paths (panic locations, crate sources) inside the WASM.
  // Map the home directory to "~" so the public build does not carry this machine's user name.
  process.env.RUSTFLAGS = `${process.env.RUSTFLAGS ?? ""} --remap-path-prefix=${process.env.HOME}=~`.trim();
  run("cargo", ["build", "-p", "chess-wasm-bridge", "--target", "wasm32-unknown-unknown", "--release"]);
  run("wasm-bindgen", [
    "target/wasm32-unknown-unknown/release/chess_wasm_bridge.wasm",
    "--target",
    "bundler",
    "--out-dir",
    join(previewRoot, "dist/pkg")
  ]);
  writeEmbeddedWasmModule(previewRoot, { removeWasmAsset: true });
  copyBuiltWeb(previewRoot);
  copyProductHtml(previewRoot, {
    cspCheck: "includes",
    cspMismatchMessage: "Beta 0.2 product HTML CSP mismatch",
    requiredIncludes: [
      { text: 'href="./review.css"', message: "Beta 0.2 product stylesheet link is missing" },
      { text: 'href="./analyzer.css"', message: "Beta 0.2 analyzer stylesheet link is missing" },
      { text: 'src="./dist/app.js"', message: "Beta 0.2 product entrypoint is missing" }
    ]
  });
  servedPreviewWasmSha256 = servedWasmArtifactSha256();
  injectPreviewBuildSha(currentGitSha(), servedPreviewWasmSha256);
  copyProductCss(previewRoot);
}

function currentGitSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) {
    return "unknown";
  }
  return result.stdout.trim() || "unknown";
}

function servedWasmArtifactSha256() {
  const artifact = readFileSync(join(previewRoot, "dist/pkg/chess_wasm_bridge_embedded.mjs"));
  return createHash("sha256").update(artifact).digest("hex");
}

function injectPreviewBuildSha(buildSha, wasmSha256) {
  const htmlPath = join(previewRoot, "index.html");
  const html = readFileSync(htmlPath, "utf8");
  const appScript = '<script type="module" src="./dist/app.js"></script>';
  const buildShaPath = "/dist/play-build-sha.js";
  writeFileSync(
    join(previewRoot, buildShaPath),
    [
      `globalThis.__chessPreviewBuildSha = ${JSON.stringify(buildSha)};`,
      `globalThis.__chessPreviewWasmSha256 = ${JSON.stringify(wasmSha256)};`,
      ""
    ].join("\n")
  );
  const buildScript = '<script type="module" src="./dist/play-build-sha.js"></script>';
  const injected = html.replace(appScript, `${buildScript}\n    ${appScript}`);
  if (injected === html) {
    throw new Error("Beta 0.2 product entrypoint was unavailable for evidence build SHA");
  }
  writeFileSync(htmlPath, injected);
}

function isServedFile(path) {
  return servedStaticExtensions.includes(extname(path));
}

async function startPreviewServer() {
  const files = new Map(
    walk(previewRoot)
      .filter(isServedFile)
      .map((file) => [`/${relative(previewRoot, file).split("/").map(encodeURIComponent).join("/")}`, file])
  );
  const requests = [];
  const served = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(pathname);
    if (pathname === "/evidence/append") {
      void handleEvidenceAppend(request, response);
      return;
    }
    if (pathname === "/game-archive/append") {
      void handleGameArchiveAppend(request, response);
      return;
    }
    if (pathname === "/analyzer/analyze") {
      void handleAnalyzerAnalyze(request, response, analyzerOutputRoot);
      return;
    }
    const file = pathname === "/" ? files.get("/index.html") : files.get(pathname);
    response.setHeader("Content-Security-Policy", csp);
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("method not allowed");
      return;
    }
    if (file === undefined || !statSync(file).isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    served.push(pathname);
    response.writeHead(200, { "Content-Type": contentType(file) });
    response.end(request.method === "HEAD" ? undefined : readFileSync(file));
  });
  const defaultPort = smokeMode ? "0" : "7700";
  const port = Number.parseInt(process.env.CHESS_PREVIEW_PORT ?? defaultPort, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("CHESS_PREVIEW_PORT must be 0..65535");
  await new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error && error.code === "EADDRINUSE") {
        reject(new Error(`Preview port ${port} is already in use. Free it or run with CHESS_PREVIEW_PORT=<port> just preview.`));
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Preview server address was unavailable");
  return { requests, served, server, url: `http://127.0.0.1:${address.port}/index.html` };
}

async function handleEvidenceAppend(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("method not allowed");
    return;
  }
  try {
    const body = await readEvidenceBody(request);
    const event = JSON.parse(body);
    const sessionId = validateEvidenceEvent(event);
    const enrichedEvent = { ...event, wasmSha256: servedPreviewWasmSha256 };
    mkdirSync(evidenceRoot, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const path = join(evidenceRoot, `${date}-${sessionId}.jsonl`);
    appendFileSync(path, `${JSON.stringify(enrichedEvent)}\n`, "utf8");
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, path }));
  } catch (error) {
    response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "invalid evidence" }));
  }
}

async function handleGameArchiveAppend(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("method not allowed");
    return;
  }
  try {
    const body = await readBoundedBody(request, 2_097_152);
    const record = JSON.parse(body);
    validateGameArchiveRecord(record);
    mkdirSync(gameArchiveRoot, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const path = join(gameArchiveRoot, `live-${date}.jsonl`);
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, path }));
  } catch (error) {
    response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "invalid game archive record" }));
  }
}

export function validateGameArchiveRecord(record) {
  if (record === null || typeof record !== "object") {
    throw new Error("invalid game archive record");
  }
  if (record.schema !== 1) {
    throw new Error("invalid game archive schema");
  }
  if (record.source !== "play-game-archive") {
    throw new Error("invalid game archive source");
  }
  if (typeof record.id !== "string" || !/^[A-Za-z0-9._-]{1,96}$/u.test(record.id)) {
    throw new Error("invalid game archive id");
  }
  if (!Array.isArray(record.moves) || record.moves.length < 2 || record.moves.length > 256) {
    throw new Error("invalid game archive moves");
  }
}

function readEvidenceBody(request) {
  return readBoundedBody(request, 65_536);
}

function readBoundedBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(chunks.join("")));
    request.on("error", reject);
  });
}

function validateEvidenceEvent(event) {
  if (event === null || typeof event !== "object") {
    throw new Error("invalid evidence event");
  }
  if (event.schema !== 1 && event.schema !== 2) {
    throw new Error("invalid evidence schema");
  }
  if (event.type !== "move" && event.type !== "recommendation" && event.type !== "discrepancy") {
    throw new Error("invalid evidence type");
  }
  if (typeof event.sessionId !== "string" || !/^[A-Za-z0-9._-]{1,96}$/u.test(event.sessionId)) {
    throw new Error("invalid evidence sessionId");
  }
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) {
    throw new Error("invalid evidence seq");
  }
  return event.sessionId;
}

async function expectServed(baseUrl, path, expectedType, mustInclude) {
  const response = await fetch(new URL(path, baseUrl));
  if (response.status !== 200) throw new Error(`${path} returned HTTP ${response.status}`);
  if (response.headers.get("content-security-policy") !== csp) throw new Error(`${path} CSP header mismatch`);
  if (response.headers.get("content-type") !== expectedType) throw new Error(`${path} content type mismatch`);
  if (mustInclude !== null) {
    const body = await response.text();
    if (!body.includes(mustInclude)) throw new Error(`${path} did not include expected content`);
  }
}

async function runSmokeProof(url, served) {
  const expectRepositoryArtifact = (path) => {
    const rel = relative(realpathSync(process.cwd()), realpathSync(path));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Preview persisted an artifact outside the repository: ${path}`);
    }
  };
  expectRepositoryArtifact(join(previewRoot, "index.html"));
  await expectServed(url, "/index.html", "text/html; charset=utf-8", 'src="./dist/app.js"');
  await expectServed(url, "/index.html", "text/html; charset=utf-8", 'src="./dist/play-build-sha.js"');
  await expectServed(url, "/dist/play-build-sha.js", "text/javascript; charset=utf-8", "__chessPreviewBuildSha");
  await expectServed(url, "/dist/play-build-sha.js", "text/javascript; charset=utf-8", "__chessPreviewWasmSha256");
  await expectServed(url, "/review.css", "text/css; charset=utf-8", "font-family");
  await expectServed(url, "/analyzer.css", "text/css; charset=utf-8", "data-analyzer-ui");
  await expectServed(url, "/dist/app.js", "text/javascript; charset=utf-8", "chess-review-app");
  await expectServed(
    url,
    "/dist/generated/play-refutation-memory.generated.js",
    "text/javascript; charset=utf-8",
    "generatedPlayRefutationMemoryCases"
  );
  await expectServed(url, "/dist/pkg/chess_wasm_bridge_embedded.mjs", "text/javascript; charset=utf-8", "WebAssembly.Module");
  await expectServed(url, "/dist/pkg/chess_wasm_bridge_embedded.mjs", "text/javascript; charset=utf-8", "side_explore_json");
  await expectServed(url, "/assets/pieces/adr-0137/white-king-review-v1.png", "image/png", null);
  const wasmResponse = await fetch(new URL("/dist/pkg/chess_wasm_bridge_bg.wasm", url));
  if (wasmResponse.status !== 404) throw new Error("Beta 0.2 preview served a direct .wasm asset");
  if (served.some((request) => request.endsWith(".wasm"))) {
    throw new Error(`Beta 0.2 preview served a .wasm asset: ${served.join(", ")}`);
  }
  if (!served.includes("/assets/pieces/adr-0137/white-king-review-v1.png")) {
    throw new Error(`Beta 0.2 preview did not serve the ADR-0137 piece PNG: ${served.join(", ")}`);
  }
  const invalidArchive = await fetch(new URL("/game-archive/append", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema: 1 })
  });
  if (invalidArchive.status !== 400) {
    throw new Error("ADR-0241 archive endpoint accepted an invalid record");
  }
  const validArchive = await fetch(new URL("/game-archive/append", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema: 1,
      source: "play-game-archive",
      id: "smoke-game-1",
      moves: [{ ply: 1 }, { ply: 2 }]
    })
  });
  if (validArchive.status !== 200) {
    throw new Error("ADR-0241 archive endpoint rejected a valid record");
  }
  const archivePath = (await validArchive.json()).path;
  if (typeof archivePath !== "string" || !readFileSync(archivePath, "utf8").includes("smoke-game-1")) {
    throw new Error("ADR-0241 archive endpoint did not persist the record");
  }
  expectRepositoryArtifact(archivePath);
  const evidenceResponse = await fetch(new URL("/evidence/append", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema: 1, type: "move", sessionId: "smoke-preview", seq: 1 })
  });
  if (evidenceResponse.status !== 200) throw new Error("Preview rejected the smoke evidence event");
  const evidencePath = (await evidenceResponse.json()).path;
  expectRepositoryArtifact(evidencePath);
  const evidenceEvents = readFileSync(evidencePath, "utf8").trim().split("\n").map(JSON.parse);
  if (!evidenceEvents.some((event) => event.wasmSha256 === servedPreviewWasmSha256)) {
    throw new Error("Preview evidence did not record the served WASM artifact");
  }
  const invalidAnalyze = await fetch(new URL("/analyzer/analyze", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "pgn", pgn: "" })
  });
  if (invalidAnalyze.status !== 400) {
    throw new Error("ADR-0242 analyzer endpoint accepted an invalid request");
  }
  const validAnalyze = await fetch(new URL("/analyzer/analyze", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "pgn",
      side: "white",
      depth: 2,
      ownedEngine: true,
      pgn: '1. Nf3 Nf6 2. Nc3 Nc6 1/2-1/2'
    })
  });
  if (validAnalyze.status !== 200) {
    throw new Error(`ADR-0242 analyzer endpoint rejected a valid request: ${validAnalyze.status}`);
  }
  const analyzeResult = await validAnalyze.json();
  if (
    analyzeResult.ok !== true ||
    typeof analyzeResult.path !== "string" ||
    !readFileSync(analyzeResult.path, "utf8").includes("owned-engine-move-comparison") ||
    analyzeResult.report.ownedEngine?.status !== "enabled"
  ) {
    throw new Error("ADR-0242 analyzer endpoint did not run the owned-engine pipeline");
  }
  expectRepositoryArtifact(analyzeResult.path);
}

preparePreviewOutput();
if (buildOnly) {
  scanStaticOutput(previewRoot);
} else if (smokeMode) {
  scanStaticOutput(previewRoot);
  const preview = await startPreviewServer();
  try {
    await runSmokeProof(preview.url, preview.served);
    console.log(`Beta 0.2 local preview proof passed: ${preview.url}`);
  } finally {
    await new Promise((resolve) => preview.server.close(resolve));
  }
} else {
  scanStaticOutput(previewRoot);
  const { server, url } = await startPreviewServer();
  console.log("Beta 0.2 Active Trainer local preview");
  console.log(url);
  console.log(`Serving ignored local output from ${previewRoot}`);
  console.log("No browser was launched. Press Ctrl+C to stop.");
  await new Promise((resolve) => {
    process.once("SIGINT", () => server.close(resolve));
    process.once("SIGTERM", () => server.close(resolve));
  });
}
