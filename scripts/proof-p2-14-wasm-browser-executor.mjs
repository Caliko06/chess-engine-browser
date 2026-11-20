import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createServer } from "node:net";
import { runtimeNetworkPatterns } from "./runtime-network-policy.mjs";

const repoRoot = new URL("../", import.meta.url).pathname;
const proofRoot = "/private/tmp/chess-p2-14-wasm-proof";
const cargoPath = `${process.env.HOME}/.cargo/bin:/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:/opt/homebrew/sbin:${process.env.PATH ?? ""}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, PATH: cargoPath },
    encoding: "utf8",
    stdio: "inherit",
    ...options
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function scanProofOutput(root) {
  const proofOnlyForbiddenTokens = [
    "localStorage",
    "randomUUID",
    "mountReviewUi",
    "Worker",
    "ServiceWorker"
  ];
  const files = [
    join(root, "index.html"),
    join(root, "harness.mjs"),
    join(root, "package.json"),
    join(root, "pkg", "chess_wasm_bridge.js"),
    join(root, "pkg", "chess_wasm_bridge_bg.js"),
    join(root, "pkg", "chess_wasm_bridge_embedded.mjs"),
    join(root, "web", "review-wasm-executor.js")
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const pattern of runtimeNetworkPatterns) {
      if (pattern.regex.test(text)) {
        throw new Error(`${file} contains forbidden proof token: ${pattern.name}`);
      }
    }
    for (const token of proofOnlyForbiddenTokens) {
      if (text.includes(token)) {
        throw new Error(`${file} contains forbidden proof token: ${token}`);
      }
    }
  }
}

function runPolicyPreflight() {
  run("node", ["scripts/audit-policy.mjs"]);
}

function assertWasmBindgenCliVersion() {
  const result = spawnSync("wasm-bindgen", ["--version"], {
    cwd: repoRoot,
    env: { ...process.env, PATH: cargoPath },
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error("wasm-bindgen CLI is unavailable for the P2.14 proof");
  }
  const version = `${result.stdout}${result.stderr}`.trim();
  if (version !== "wasm-bindgen 0.2.121") {
    throw new Error(`P2.14 proof requires wasm-bindgen 0.2.121, got ${version}`);
  }
}

function chromePath() {
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(macChrome)) {
    return macChrome;
  }
  return "google-chrome";
}

async function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate loopback proof port")));
        return;
      }

      const port = String(address.port);
      server.close(() => resolve(port));
    });
  });
}

async function waitForProofServer(server, stderrChunks) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve();
    }, 1000);

    server.once("error", (error) => {
      if (!settled) {
        clearTimeout(timer);
        settled = true;
        reject(error);
      }
    });

    server.once("exit", (code, signal) => {
      if (!settled) {
        clearTimeout(timer);
        settled = true;
        const stderr = stderrChunks.join("").trim();
        reject(new Error(`Proof server exited before Chrome ran: code=${code}, signal=${signal}, stderr=${stderr}`));
      }
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CDP request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function eventDataText(data) {
  if (typeof data === "string") {
    return data;
  }
  return String(data);
}

async function connectCdp(webSocketDebuggerUrl) {
  const websocket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  const events = [];
  let nextId = 1;

  await new Promise((resolve, reject) => {
    websocket.addEventListener("open", resolve, { once: true });
    websocket.addEventListener("error", () => reject(new Error("Could not open CDP WebSocket")), {
      once: true
    });
  });

  websocket.addEventListener("message", (event) => {
    const message = JSON.parse(eventDataText(event.data));
    if (message.id !== undefined) {
      const pendingCommand = pending.get(message.id);
      if (pendingCommand !== undefined) {
        pending.delete(message.id);
        if (message.error !== undefined) {
          pendingCommand.reject(new Error(`${pendingCommand.method}: ${message.error.message}`));
        } else {
          pendingCommand.resolve(message.result ?? {});
        }
      }
      return;
    }

    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails;
      events.push(details?.exception?.description ?? details?.text ?? "Runtime.exceptionThrown");
    }
    if (message.method === "Runtime.consoleAPICalled") {
      const args = message.params?.args ?? [];
      events.push(args.map((arg) => String(arg.value ?? arg.description ?? "")).join(" "));
    }
  });

  return {
    events,
    close: () => websocket.close(),
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { method, resolve, reject });
        websocket.send(JSON.stringify({ id, method, params }));
      })
  };
}

async function openCdp(debugPort) {
  const deadline = Date.now() + 10_000;
  let lastError = new Error("CDP endpoint was not available");

  while (Date.now() < deadline) {
    try {
      const tabs = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
      const page = tabs.find((tab) => tab.type === "page" && tab.webSocketDebuggerUrl !== undefined);
      if (page !== undefined) {
        return connectCdp(page.webSocketDebuggerUrl);
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }

  throw lastError;
}

async function evaluateValue(cdp, expression) {
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (evaluation.exceptionDetails !== undefined) {
    throw new Error(evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text);
  }
  return evaluation.result?.value;
}

async function waitForProofResult(cdp, url) {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await evaluateValue(cdp, "document.body?.dataset?.proof ?? 'pending'");
    if (state === "pass" || state === "fail") {
      return {
        state,
        text: await evaluateValue(cdp, "document.body?.textContent ?? ''")
      };
    }
    await delay(250);
  }

  return {
    state: "timeout",
    text: await evaluateValue(cdp, "document.documentElement?.outerHTML ?? ''")
  };
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
  throw new Error("embedded wasm proof import mismatch: " + JSON.stringify(wasmImports));
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

function writeHarness() {
  writeFileSync(
    join(proofRoot, "package.json"),
    JSON.stringify({ type: "module", private: true }, null, 2)
  );
  writeFileSync(
    join(proofRoot, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>P2.14 wasm executor proof</title><body data-proof="pending"><script type="module" src="./harness.mjs"></script></body>`
  );
  writeFileSync(
    join(proofRoot, "harness.mjs"),
    `function assertEqual(actual, expected, label) {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(label + ": expected " + expectedText + ", got " + actualText);
  }
}

function assert(condition, label) {
  if (!condition) {
    throw new Error(label);
  }
}

try {
  const [{ createReviewWasmExecutor }, reviewModule] = await Promise.all([
    import("./web/review-wasm-executor.js"),
    import("./pkg/chess_wasm_bridge_embedded.mjs")
  ]);
  const reviewPgn = createReviewWasmExecutor(() => Promise.resolve(reviewModule));

  const valid = await reviewPgn({ pgn: "1. f3 e5 2. g4 Qh4# 0-1", depth: 3 });
  assert(valid.ok === true, "valid review should succeed");
  assert(Object.keys(valid.review).sort().join(",") === "entries,summary", "review shape should stay core only");
  assert(valid.review.summary.totalMoves > 0, "review should include moves");
  assert(valid.review.entries.some((entry) => entry.label === "blunder"), "review should include core labels");
  assert(!JSON.stringify(valid).includes("1. f3"), "raw PGN must not be echoed");

  assertEqual(await reviewPgn({ pgn: "", depth: 3 }), { ok: false, error: "invalid-pgn" }, "empty PGN");
  assertEqual(await reviewPgn({ pgn: "1. e4 *", depth: 1 }), { ok: false, error: "invalid-depth" }, "low depth");
  assertEqual(await reviewPgn({ pgn: "1. e4 *", depth: 7 }), { ok: false, error: "invalid-depth" }, "high depth");
  assertEqual(await reviewPgn({ pgn: "1. e4 {comment} *", depth: 3 }), { ok: false, error: "invalid-pgn" }, "unsupported comments");

  document.body.dataset.proof = "pass";
  document.body.textContent = JSON.stringify({
    status: "pass",
    summary: valid.review.summary,
    entries: valid.review.entries.length
  });
} catch (error) {
  document.body.dataset.proof = "fail";
  document.body.textContent = error instanceof Error ? error.message : String(error);
}
`
  );
}

rmSync(proofRoot, { recursive: true, force: true });
mkdirSync(join(proofRoot, "pkg"), { recursive: true });
mkdirSync(join(proofRoot, "web"), { recursive: true });

runPolicyPreflight();
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
run("pnpm", ["--filter", "web", "run", "build"]);
copyFileSync(
  join(repoRoot, "apps/web/dist/review-wasm-executor.js"),
  join(proofRoot, "web/review-wasm-executor.js")
);
writeHarness();
scanProofOutput(proofRoot);

const proofPort = await allocateLoopbackPort();
const serverStderr = [];
const server = spawn("python3", ["-m", "http.server", proofPort, "--bind", "127.0.0.1"], {
  cwd: proofRoot,
  stdio: ["ignore", "ignore", "pipe"]
});
server.stderr.on("data", (chunk) => serverStderr.push(chunk.toString("utf8")));

try {
  await waitForProofServer(server, serverStderr);
  const debugPort = await allocateLoopbackPort();
  const chromeStderr = [];
  const chrome = spawn(chromePath(), [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    "--enable-features=WebAssemblyESMIntegration",
    `--remote-debugging-port=${debugPort}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${join(proofRoot, "chrome-profile")}`,
    "about:blank"
  ], {
    stdio: ["ignore", "ignore", "pipe"]
  });
  chrome.stderr.on("data", (chunk) => chromeStderr.push(chunk.toString("utf8")));

  let cdp;
  try {
    cdp = await openCdp(debugPort);
    const result = await waitForProofResult(cdp, `http://127.0.0.1:${proofPort}/index.html`);
    if (result.state !== "pass") {
      console.error(result.text);
      if (cdp.events.length > 0) {
        console.error(cdp.events.join("\n"));
      }
      if (chromeStderr.length > 0) {
        console.error(chromeStderr.join(""));
      }
      throw new Error("P2.14 browser proof did not pass");
    }
  } finally {
    if (cdp !== undefined) {
      await cdp.send("Browser.close").catch(() => {});
      cdp.close();
    }
    chrome.kill();
  }
  console.log("P2.14 wasm/browser executor proof passed.");
} finally {
  server.kill();
}
