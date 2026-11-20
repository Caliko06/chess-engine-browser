import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoInlineStyles,
  assertNoRuntimeNetworkTokens,
  assertWasmBindgenCliVersion,
  contentType,
  copyBuiltWeb,
  copyProductCss,
  run,
  servedStaticExtensions,
  walk,
  writeEmbeddedWasmModule
} from "./beta-preview-support.mjs";
import {
  createLocalStockfishBestMoveProvider,
  playStockfishBinaryEnv,
  resolvePlayStockfishBinary
} from "./play-local-stockfish-adapter.mjs";
import { runtimeNetworkPatterns } from "./runtime-network-policy.mjs";

export const playStockfishPreviewRoot = "/private/tmp/chess-play-local-stockfish-preview";
export const playStockfishPreviewPortEnv = "CHESS_PLAY_STOCKFISH_PREVIEW_PORT";
export const playStockfishPreviewCsp =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self'; connect-src 'self'";
export const playStockfishPreviewProviderPath = "/play-stockfish-preview-provider.mjs";
export const allowedPreviewProviderNetworkTokens = ["fetch("];

const providerFilename = playStockfishPreviewProviderPath.slice(1);
const coordinateMovePattern = /^[a-h][1-8][a-h][1-8][qrbn]?$/u;
const maxJsonBodyBytes = 16_384;
const maxFenLength = 512;
const maxLegalMoves = 256;

export function resolvePlayStockfishPreviewPort(env = process.env) {
  const rawPort = env[playStockfishPreviewPortEnv] ?? "0";
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535 || String(port) !== rawPort.trim()) {
    throw new Error(`${playStockfishPreviewPortEnv} must be 0..65535`);
  }
  return port;
}

export function preparePlayStockfishPreviewOutput(outputRoot = playStockfishPreviewRoot, env = process.env) {
  const config = resolvePlayStockfishBinary(env);
  rmSync(outputRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  mkdirSync(join(outputRoot, "dist/pkg"), { recursive: true });
  run("node", ["scripts/audit-policy.mjs"]);
  run("pnpm", ["--filter", "web", "run", "build"]);
  assertWasmBindgenCliVersion("Play local Stockfish preview");
  run("cargo", ["build", "-p", "chess-wasm-bridge", "--target", "wasm32-unknown-unknown", "--release"]);
  run("wasm-bindgen", [
    "target/wasm32-unknown-unknown/release/chess_wasm_bridge.wasm",
    "--target",
    "bundler",
    "--out-dir",
    join(outputRoot, "dist/pkg")
  ]);
  writeEmbeddedWasmModule(outputRoot, { removeWasmAsset: true });
  copyBuiltWeb(outputRoot);
  copyProductCss(outputRoot);
  writePlayStockfishPreviewHtml(outputRoot);
  writePlayStockfishProviderBootstrap(outputRoot, config.ok);
  scanPlayStockfishPreviewOutput(outputRoot);
  return { outputRoot, config };
}

export function writePlayStockfishPreviewHtml(outputRoot = playStockfishPreviewRoot) {
  writeFileSync(
    join(outputRoot, "index.html"),
    [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<meta http-equiv="Content-Security-Policy" content="${playStockfishPreviewCsp}">`,
      '<link rel="stylesheet" href="./review.css">',
      "<title>Play local Stockfish preview</title>",
      "</head>",
      "<body>",
      '<main id="chess-review-app"></main>',
      `<script type="module" src=".${playStockfishPreviewProviderPath}"></script>`,
      '<script type="module" src="./dist/app.js"></script>',
      "</body>",
      "</html>",
      ""
    ].join("\n"),
    "utf8"
  );
}

export function writePlayStockfishProviderBootstrap(
  outputRoot = playStockfishPreviewRoot,
  initiallyAvailable = false
) {
  writeFileSync(
    join(outputRoot, providerFilename),
    playStockfishProviderBootstrapSource(initiallyAvailable),
    "utf8"
  );
}

export function playStockfishProviderBootstrapSource(initiallyAvailable = false) {
  return `let available = ${initiallyAvailable ? "true" : "false"};

const fail = () => ({ ok: false, error: "search-failed" });

async function postPlayStockfish(path, body) {
  if (!available) {
    return fail();
  }
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      available = false;
      return fail();
    }
    const result = await response.json();
    if (result?.ok !== true) {
      available = false;
    }
    return result;
  } catch {
    available = false;
    return fail();
  }
}

globalThis.__chessPlayBestMoveProvider = {
  isAvailable: () => available,
  prepareNewGame: () => postPlayStockfish("/api/play/stockfish-new-game", {}),
  bestMove: (fen, depth, legalMoves) =>
    Array.isArray(legalMoves)
      ? postPlayStockfish("/api/play/stockfish-best-move", { fen, depth, legalMoves })
      : Promise.resolve(fail()),
  cancelSearch: () => {
    void postPlayStockfish("/api/play/stockfish-cancel", {});
  }
};
`;
}

export function scanPlayStockfishPreviewOutput(outputRoot = playStockfishPreviewRoot) {
  for (const file of walk(outputRoot).filter((path) => /\.(?:html|js|mjs|css)$/u.test(path))) {
    const text = readFileSync(file, "utf8");
    if (file.endsWith(providerFilename)) {
      assertPreviewProviderNetworkTokens(file, text);
    } else {
      assertNoRuntimeNetworkTokens(file, text);
    }
    assertNoInlineStyles(file, text);
  }
}

export async function startPlayStockfishPreviewServer(options = {}) {
  const outputRoot = options.outputRoot ?? playStockfishPreviewRoot;
  const env = options.env ?? process.env;
  const config = options.config ?? resolvePlayStockfishBinary(env);
  const provider = options.provider ?? createLocalStockfishBestMoveProvider(config);
  writePlayStockfishProviderBootstrap(outputRoot, config.ok);
  const files = new Map(
    walk(outputRoot)
      .filter(isServedFile)
      .map((file) => [`/${relative(outputRoot, file).split("/").map(encodeURIComponent).join("/")}`, file])
  );
  const requests = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    void handlePreviewRequest({
      config,
      files,
      pathname,
      provider,
      request,
      requests,
      response
    }).catch((error) => {
      requests.push({ method: request.method ?? "GET", pathname, status: 500 });
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
    });
  });
  const port = resolvePlayStockfishPreviewPort(env);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Play local Stockfish preview address was unavailable");
  }
  const dispose = async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    if (typeof provider.dispose === "function") {
      await provider.dispose();
    }
  };
  return {
    config,
    dispose,
    provider,
    requests,
    server,
    url: `http://127.0.0.1:${address.port}/index.html`
  };
}

function assertPreviewProviderNetworkTokens(file, text) {
  for (const pattern of runtimeNetworkPatterns) {
    if (allowedPreviewProviderNetworkTokens.includes(pattern.name)) {
      continue;
    }
    if (pattern.name === "Rust unsafe") {
      continue;
    }
    if (pattern.regex.test(text)) {
      throw new Error(`${file} contains forbidden preview provider runtime token: ${pattern.name}`);
    }
  }
  if (!/\bfetch\s*\(/u.test(text)) {
    throw new Error(`${file} is missing the expected same-origin fetch bridge`);
  }
}

function isServedFile(path) {
  if (path.includes("/chrome-profile/")) {
    return false;
  }
  return servedStaticExtensions.includes(extname(path));
}

async function handlePreviewRequest(input) {
  const { config, files, pathname, provider, request, requests, response } = input;
  response.setHeader("Content-Security-Policy", playStockfishPreviewCsp);
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (pathname.startsWith("/api/")) {
    await handleApiRequest({ config, pathname, provider, request, requests, response });
    return;
  }
  handleStaticRequest({ files, pathname, request, requests, response });
}

async function handleApiRequest(input) {
  const { config, pathname, provider, request, requests, response } = input;
  if (pathname === "/api/play/stockfish-status") {
    if (request.method !== "GET") {
      writeJson(response, requests, request, pathname, 405, { ok: false, error: "method-not-allowed" });
      return;
    }
    writeJson(response, requests, request, pathname, 200, {
      ok: true,
      value: {
        available: provider.isAvailable(),
        configured: config.ok,
        reason: config.ok ? null : config.reason
      }
    });
    return;
  }

  if (!playApiPostPaths.has(pathname)) {
    writeJson(response, requests, request, pathname, 404, { ok: false, error: "not-found" });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, requests, request, pathname, 405, { ok: false, error: "method-not-allowed" });
    return;
  }
  if (!isJsonRequest(request)) {
    writeJson(response, requests, request, pathname, 400, { ok: false, error: "search-failed" });
    return;
  }

  if (pathname === "/api/play/stockfish-cancel") {
    if ((await readJsonBodyResult(request)).ok === false) {
      writeJson(response, requests, request, pathname, 400, { ok: false, error: "search-failed" });
      return;
    }
    provider.cancelSearch?.();
    writeJson(response, requests, request, pathname, 200, { ok: true, value: undefined });
    return;
  }

  if (pathname === "/api/play/stockfish-new-game") {
    if ((await readJsonBodyResult(request)).ok === false) {
      writeJson(response, requests, request, pathname, 400, { ok: false, error: "search-failed" });
      return;
    }
    writeJson(
      response,
      requests,
      request,
      pathname,
      200,
      (await runProviderResult(() => provider.prepareNewGame?.())) ?? { ok: true, value: undefined }
    );
    return;
  }

  const body = await readJsonBodyResult(request);
  if (!body.ok) {
    writeJson(response, requests, request, pathname, 400, { ok: false, error: "search-failed" });
    return;
  }
  const validation = validateBestMoveRequest(body.value);
  if (!validation.ok) {
    writeJson(response, requests, request, pathname, 400, { ok: false, error: "search-failed" });
    return;
  }
  const result = await runProviderResult(() =>
    provider.bestMove(validation.value.fen, validation.value.depth, validation.value.legalMoves)
  );
  if (
    result.ok &&
    result.value.bestMove !== null &&
    !validation.value.legalMoves.includes(result.value.bestMove)
  ) {
    writeJson(response, requests, request, pathname, 200, { ok: false, error: "search-failed" });
    return;
  }
  writeJson(response, requests, request, pathname, 200, result);
}

function handleStaticRequest(input) {
  const { files, pathname, request, requests, response } = input;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("method not allowed");
    requests.push({ method: request.method ?? "GET", pathname, status: 405 });
    return;
  }
  const file = pathname === "/" ? files.get("/index.html") : files.get(pathname);
  if (file === undefined || !statSync(file).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("not found");
    requests.push({ method: request.method ?? "GET", pathname, status: 404 });
    return;
  }
  response.writeHead(200, { "Content-Type": contentType(file) });
  response.end(request.method === "HEAD" ? undefined : readFileSync(file));
  requests.push({ method: request.method ?? "GET", pathname, status: 200 });
}

const playApiPostPaths = new Set([
  "/api/play/stockfish-new-game",
  "/api/play/stockfish-best-move",
  "/api/play/stockfish-cancel"
]);

function isJsonRequest(request) {
  return (request.headers["content-type"] ?? "").toLowerCase().split(";")[0]?.trim() === "application/json";
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString("utf8");
    if (Buffer.byteLength(body, "utf8") > maxJsonBodyBytes) {
      throw new Error("request body too large");
    }
  }
  if (body.trim() === "") {
    return {};
  }
  return JSON.parse(body);
}

async function readJsonBodyResult(request) {
  try {
    return { ok: true, value: await readJsonBody(request) };
  } catch {
    return { ok: false };
  }
}

function validateBestMoveRequest(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false };
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["depth", "fen", "legalMoves"])) {
    return { ok: false };
  }
  const { depth, fen, legalMoves } = value;
  if (
    typeof fen !== "string" ||
    fen.trim() === "" ||
    fen.length > maxFenLength ||
    /[\r\n]/u.test(fen)
  ) {
    return { ok: false };
  }
  if (!Number.isInteger(depth) || depth < 1 || depth > 64) {
    return { ok: false };
  }
  if (!Array.isArray(legalMoves) || legalMoves.length === 0 || legalMoves.length > maxLegalMoves) {
    return { ok: false };
  }
  if (!legalMoves.every((move) => typeof move === "string" && coordinateMovePattern.test(move))) {
    return { ok: false };
  }
  return { ok: true, value: { depth, fen, legalMoves } };
}

function writeJson(response, requests, request, pathname, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
  requests.push({ method: request.method ?? "GET", pathname, status });
}

async function runProviderResult(operation) {
  try {
    return await operation();
  } catch {
    return { ok: false, error: "search-failed" };
  }
}

async function runCli() {
  const { config } = preparePlayStockfishPreviewOutput();
  const preview = await startPlayStockfishPreviewServer({ config });
  console.log("Play local Stockfish preview");
  console.log(preview.url);
  console.log(`Open the printed 127.0.0.1 URL; no browser was launched.`);
  console.log(`Serving ignored local output from ${playStockfishPreviewRoot}`);
  if (config.ok) {
    console.log(`${playStockfishBinaryEnv}: configured`);
    console.log("Success signal in Play: Engine: Local Stockfish");
  } else {
    console.log(`${playStockfishBinaryEnv}: unavailable (${config.reason})`);
    console.log(
      `To activate Stockfish: ${playStockfishBinaryEnv}=/absolute/path/to/stockfish node scripts/preview-play-local-stockfish.mjs`
    );
    console.log("Fallback signal in Play: Engine: Owned local (Stockfish unavailable)");
  }
  console.log(
    `Optional proof: ${playStockfishBinaryEnv}=/absolute/path/to/stockfish node scripts/proof-play-local-stockfish-real-preview.mjs`
  );
  console.log("Press Ctrl+C to stop.");
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await preview.dispose();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
