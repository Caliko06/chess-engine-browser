import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { basename, extname, join, relative } from "node:path";

const repoRoot = new URL("../", import.meta.url).pathname;
const proofRoot = "/private/tmp/chess-p2-19-browser-dom-proof";
const csp = "default-src 'none'; script-src 'self'; connect-src 'none'";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
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
    `<!doctype html><meta charset="utf-8"><title>P2.19 DOM proof</title><body data-proof="pending"><script type="module" src="./harness.mjs"></script></body>`
  );
  writeFileSync(
    join(proofRoot, "harness.mjs"),
    `function assert(condition, label) {
  if (!condition) throw new Error(label);
}
function summary() {
  return { totalMoves: 0, best: 0, good: 0, inaccuracies: 0, mistakes: 0, blunders: 0 };
}
function entry(label = "good") {
  return {
    ply: 1,
    playedMove: "e2e4",
    san: "e4",
    bestMove: "a2a3",
    bestScoreCp: 20,
    playedScoreCp: 10,
    cpLoss: 10,
    label
  };
}
function review() {
  return { summary: summary(), entries: [entry()] };
}
function storedReview(id) {
  return { id, savedAtIso: "2026-05-17T12:00:00.000Z", source: "review-pgn", review: review() };
}
function memoryStorage(initial) {
  const values = new Map(initial);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    entries: () => [...values.entries()]
  };
}
function ui(name) {
  const element = document.querySelector('[data-review-ui="' + name + '"]');
  assert(element !== null, "missing " + name);
  return element;
}
try {
  const { mountReviewUi } = await import("./web/review-ui.js");
  const storeKey = "chess.trainer.reviewStore.v1";
  const hostileId = 'stored\\u0000 "quoted" [id]\\\\';
  const storage = memoryStorage([
    [
      storeKey,
      JSON.stringify({
        schemaVersion: 1,
        reviews: [storedReview(hostileId), storedReview(hostileId + "-keep")]
      })
    ]
  ]);
  const root = document.createElement("main");
  document.body.append(root);
  const handle = mountReviewUi(root, {
    storage,
    reviewPgn: () => Promise.resolve({ ok: true, review: review() }),
    createSaveMetadata: () => ({ ok: true, metadata: { id: "saved", savedAtIso: "2026-05-17T13:00:00.000Z" } })
  });

  const input = ui("pgn-input");
  input.focus();
  input.value = "1. e4 *";
  input.setSelectionRange(4, 4);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "4", inputType: "insertText" }));
  const rerenderedInput = ui("pgn-input");
  assert(rerenderedInput.value === "1. e4 *", "typed PGN should survive rerender");
  assert(handle.getState().inlinePgn === "1. e4 *", "workflow PGN should match typed value");
  assert(document.activeElement === rerenderedInput, "textarea focus should survive rerender");
  assert(rerenderedInput.selectionStart === 4 && rerenderedInput.selectionEnd === 4, "textarea caret should survive rerender");

  const depth = ui("depth-control");
  depth.value = "5";
  depth.dispatchEvent(new Event("change", { bubbles: true }));
  assert(ui("depth-control").value === "5", "selected depth should survive rerender");

  await ui("review-button").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(ui("pgn-input").value === "1. e4 *", "review rerender should preserve textarea value");

  const rootWithoutTextareas = root.cloneNode(true);
  for (const textarea of rootWithoutTextareas.querySelectorAll("textarea")) textarea.remove();
  const textOutsideTextarea = rootWithoutTextareas.textContent ?? "";
  assert(!textOutsideTextarea.includes("1. e4 *"), "raw PGN should not render outside textarea");

  const target = document.querySelector('[data-review-ui="delete-review-button"][data-review-index="0"]');
  assert(target !== undefined, "selector-hostile review delete button should render");
  target.click();
  const stored = JSON.parse(storage.entries().find(([key]) => key === storeKey)[1]);
  assert(JSON.stringify(stored.reviews.map((item) => item.id)) === JSON.stringify([hostileId + "-keep"]), "delete should remove only hostile id");

  document.body.dataset.proof = "pass";
  document.body.textContent = "P2.19 DOM proof passed";
} catch (error) {
  document.body.dataset.proof = "fail";
  document.body.textContent = error instanceof Error ? error.message : String(error);
}
`
  );
}

function contentType(path) {
  return extname(path) === ".html" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8";
}

async function startStaticServer() {
  const files = new Map(
    walk(proofRoot).map((file) => [`/${relative(proofRoot, file).split("/").map(encodeURIComponent).join("/")}`, file])
  );
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
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
  return { server, port: server.address().port };
}

function chromePath() {
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return statSync(macChrome, { throwIfNoEntry: false })?.isFile() === true ? macChrome : "google-chrome";
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
  if (webSocketUrl === "") throw new Error("CDP endpoint was not available");
  const websocket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;
  websocket.addEventListener("message", (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    const command = pending.get(message.id);
    if (command === undefined) return;
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
      if (state === "pass") return;
      if (state === "fail") throw new Error(await evaluate(cdp, "document.body?.textContent ?? ''"));
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
mkdirSync(proofRoot, { recursive: true });
run("pnpm", ["--filter", "web", "run", "build"]);
copyBuiltWeb();
writeHarness();
const { server, port } = await startStaticServer();
try {
  await runBrowserProof(`http://127.0.0.1:${port}/index.html`, port + 1);
} finally {
  server.close();
}
console.log("P2.19 browser DOM contract proof passed.");
