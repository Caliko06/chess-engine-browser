#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const manifestPath = join(repoRoot, "tests", "perft", "fixtures.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const args = new Set(process.argv.slice(2));

const failures = [];
const ownedResults = [];
const stockfishResults = [];

for (const arg of args) {
  if (arg !== "--owned-only" && arg !== "--self-test") {
    fail(`unknown argument ${arg}`);
  }
}

function fail(message) {
  failures.push(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value);
  for (const key of keys) {
    if (!(key in value)) {
      fail(`${label} missing ${key}`);
    }
  }
  for (const key of actual) {
    if (!keys.includes(key)) {
      fail(`${label} has unexpected ${key}`);
    }
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
}

function assertNodeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
}

function assertDivideShape(entry, label) {
  if (!("divide" in entry)) {
    return;
  }
  if (!Array.isArray(entry.divide) || entry.divide.length === 0) {
    fail(`${label} divide must be a non-empty array`);
    return;
  }
  const seenMoves = new Set();
  let total = 0;
  for (const item of entry.divide) {
    if (!isRecord(item)) {
      fail(`${label} divide entry must be an object`);
      continue;
    }
    exactKeys(item, ["move", "nodes"], `${label} divide entry`);
    if (typeof item.move !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(item.move)) {
      fail(`${label} divide move must be coordinate notation`);
    } else if (seenMoves.has(item.move)) {
      fail(`${label} divide has duplicate move ${item.move}`);
    } else {
      seenMoves.add(item.move);
    }
    assertNodeCount(item.nodes, `${label} divide ${item.move} nodes`);
    if (Number.isSafeInteger(item.nodes)) {
      total += item.nodes;
    }
  }
  if (total !== entry.expected_nodes) {
    fail(`${label} divide total ${total} != expected_nodes ${entry.expected_nodes}`);
  }
}

function compareDivide(expected, actual, label) {
  const expectedByMove = new Map(expected.map((item) => [item.move, item.nodes]));
  const actualByMove = new Map(actual.map((item) => [item.move, item.nodes]));
  if (actualByMove.size !== actual.length) {
    fail(`${label} has duplicate divide moves`);
  }
  for (const [move, nodes] of expectedByMove) {
    if (!actualByMove.has(move)) {
      fail(`${label} missing divide move ${move}`);
    } else if (actualByMove.get(move) !== nodes) {
      fail(`${label} divide ${move} nodes ${actualByMove.get(move)} != expected ${nodes}`);
    }
  }
  for (const move of actualByMove.keys()) {
    if (!expectedByMove.has(move)) {
      fail(`${label} has unexpected divide move ${move}`);
    }
  }
}

function assertManifestShape(value) {
  if (!isRecord(value)) {
    fail("manifest root must be an object");
    return;
  }
  exactKeys(value, ["schema_version", "generated_on", "notes", "fixtures"], "manifest");
  if (value.schema_version !== 2) {
    fail(`manifest schema_version must be 2, got ${value.schema_version}`);
  }
  if (typeof value.generated_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.generated_on)) {
    fail("manifest generated_on must be YYYY-MM-DD");
  }
  if (
    !Array.isArray(value.notes) ||
    value.notes.length === 0 ||
    value.notes.some((note) => typeof note !== "string" || note.length === 0)
  ) {
    fail("manifest notes must be a non-empty string array");
  }
  if (!Array.isArray(value.fixtures) || value.fixtures.length === 0) {
    fail("manifest fixtures must be a non-empty array");
  }
}

function assertFixtureShape(fixture) {
  if (!isRecord(fixture)) {
    fail("fixture must be an object");
    return;
  }
  const fixtureId = fixture.id ?? "<unknown>";
  exactKeys(fixture, ["id", "source", "source_url", "license_status", "fen", "depths"], `fixture ${fixtureId}`);
  assertNonEmptyString(fixture.id, `fixture ${fixtureId} id`);
  assertNonEmptyString(fixture.source, `fixture ${fixtureId} source`);
  if (fixture.source_url !== null && typeof fixture.source_url !== "string") {
    fail(`fixture ${fixtureId} source_url must be null or string`);
  }
  assertNonEmptyString(fixture.license_status, `fixture ${fixtureId} license_status`);
  assertNonEmptyString(fixture.fen, `fixture ${fixtureId} fen`);
  if (!Array.isArray(fixture.depths) || fixture.depths.length === 0) {
    fail(`fixture ${fixtureId} has no depths`);
    return;
  }
  for (const entry of fixture.depths) {
    if (!isRecord(entry)) {
      fail(`fixture ${fixtureId} depth entry must be an object`);
      continue;
    }
    const entryKeys = ["depth", "expected_nodes", "stockfish_nodes", "owned_engine_nodes"];
    if ("divide" in entry) {
      entryKeys.push("divide");
    }
    exactKeys(entry, entryKeys, `fixture ${fixtureId} depth entry`);
    if (!Number.isInteger(entry.depth) || entry.depth < 1 || entry.depth > 6) {
      fail(`fixture ${fixtureId} depth ${entry.depth} must be an integer in 1..=6`);
    }
    assertNodeCount(entry.expected_nodes, `fixture ${fixtureId} depth ${entry.depth} expected_nodes`);
    assertNodeCount(entry.stockfish_nodes, `fixture ${fixtureId} depth ${entry.depth} stockfish_nodes`);
    assertNodeCount(entry.owned_engine_nodes, `fixture ${fixtureId} depth ${entry.depth} owned_engine_nodes`);
    assertDivideShape(entry, `fixture ${fixtureId} depth ${entry.depth}`);
  }
}

function runOwnedPerft(fixture, depth, divide = false) {
  const args = ["run", "--quiet", "-p", "chess-cli", "--", "perft", "--fen", fixture.fen, "--depth", String(depth)];
  if (divide) {
    args.push("--divide");
  }
  const output = spawnSync(
    "cargo",
    args,
    { cwd: repoRoot, encoding: "utf8", timeout: 120000 },
  );
  if (output.status !== 0) {
    fail(`owned perft ${fixture.id} depth ${depth} exited ${output.status}: ${(output.stderr ?? "<no stderr>").trim()}`);
    return null;
  }
  try {
    return JSON.parse(output.stdout);
  } catch (error) {
    fail(`owned perft ${fixture.id} depth ${depth} emitted invalid JSON: ${error.message}`);
    return null;
  }
}

function printOwnedDivide(fixture, depth) {
  const divide = runOwnedPerft(fixture, depth, true);
  if (divide?.divide) {
    console.error(`owned perft divide ${fixture.id} depth ${depth}: ${JSON.stringify(divide.divide)}`);
  }
}

function stockfishPath() {
  if (process.env.STOCKFISH_BIN) {
    return process.env.STOCKFISH_BIN;
  }
  const output = spawnSync("command", ["-v", "stockfish"], { encoding: "utf8", shell: true });
  if (output.status === 0 && output.stdout.trim()) {
    return output.stdout.trim();
  }
  return null;
}

function runStockfishPerft(binary, fixture, depth) {
  const input = `uci\nisready\nposition fen ${fixture.fen}\ngo perft ${depth}\nquit\n`;
  const output = spawnSync(binary, [], { input, encoding: "utf8", timeout: 120000 });
  if (output.status !== 0) {
    fail(`stockfish ${fixture.id} depth ${depth} exited ${output.status}: ${(output.stderr ?? "<no stderr>").trim()}`);
    return null;
  }
  const stdout = output.stdout ?? "";
  const match = stdout.match(/Nodes searched:\s*(\d+)/);
  if (!match) {
    fail(`stockfish ${fixture.id} depth ${depth} did not report "Nodes searched"`);
    return null;
  }
  const divide = [...stdout.matchAll(/^([a-h][1-8][a-h][1-8][qrbn]?):\s*(\d+)$/gm)]
    .map((entry) => ({ move: entry[1], nodes: Number(entry[2]) }));
  return { nodes: Number(match[1]), divide };
}

function recordResult(results, engine, fixture, depth, expected, actual) {
  results.push({
    engine,
    fixture: fixture.id,
    depth,
    expected,
    actual,
    status: actual === expected ? "PASS" : "FAIL",
  });
}

function printResults(results) {
  for (const result of results) {
    console.log(
      `${result.status} ${result.engine} ${result.fixture} depth ${result.depth}: expected=${result.expected} actual=${result.actual}`,
    );
  }
}

function probeFailures(callback) {
  const start = failures.length;
  callback();
  return failures.splice(start);
}

function runWrongReasonProbes() {
  const duplicate = probeFailures(() => assertDivideShape({
    expected_nodes: 4,
    divide: [{ move: "a2a3", nodes: 2 }, { move: "a2a3", nodes: 2 }],
  }, "duplicate probe"));
  const wrongTotal = probeFailures(() => assertDivideShape({
    expected_nodes: 5,
    divide: [{ move: "a2a3", nodes: 2 }, { move: "a2a4", nodes: 2 }],
  }, "total probe"));
  const redistributed = probeFailures(() => compareDivide(
    [{ move: "a2a3", nodes: 2 }, { move: "a2a4", nodes: 2 }],
    [{ move: "a2a3", nodes: 1 }, { move: "a2a4", nodes: 3 }],
    "redistribution probe",
  ));
  if (
    !duplicate.some((message) => message.includes("duplicate move")) ||
    !wrongTotal.some((message) => message.includes("divide total 4 != expected_nodes 5")) ||
    redistributed.filter((message) => message.includes("!= expected")).length !== 2
  ) {
    console.error("Perft harness wrong-reason probes failed.");
    process.exit(1);
  }
  console.log("Perft harness wrong-reason probes passed.");
}

assertManifestShape(manifest);

const seenFixtureIds = new Set();
for (const fixture of manifest.fixtures ?? []) {
  assertFixtureShape(fixture);
  if (typeof fixture.id === "string") {
    if (seenFixtureIds.has(fixture.id)) {
      fail(`duplicate fixture id ${fixture.id}`);
    }
    seenFixtureIds.add(fixture.id);
  }
}

if (args.has("--self-test")) {
  if (args.size !== 1 || failures.length > 0) {
    console.error("Perft harness self-test preconditions failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }
  runWrongReasonProbes();
  process.exit(0);
}

for (const fixture of manifest.fixtures ?? []) {
  for (const entry of fixture.depths) {
    if (entry.expected_nodes !== entry.owned_engine_nodes) {
      fail(
        `manifest ${fixture.id} depth ${entry.depth} expected_nodes ${entry.expected_nodes} != owned_engine_nodes ${entry.owned_engine_nodes}`,
      );
    }
    if (entry.expected_nodes !== entry.stockfish_nodes) {
      fail(
        `manifest ${fixture.id} depth ${entry.depth} expected_nodes ${entry.expected_nodes} != stockfish_nodes ${entry.stockfish_nodes}`,
      );
    }

    const owned = runOwnedPerft(fixture, entry.depth, Array.isArray(entry.divide));
    if (!owned) {
      continue;
    }
    recordResult(ownedResults, "owned", fixture, entry.depth, entry.expected_nodes, owned.nodes);
    if (owned.command !== "perft") {
      fail(`owned perft ${fixture.id} depth ${entry.depth} returned wrong command ${owned.command}`);
    }
    if (owned.fen !== fixture.fen) {
      fail(`owned perft ${fixture.id} depth ${entry.depth} returned non-canonical or wrong FEN`);
    }
    if (owned.depth !== entry.depth) {
      fail(`owned perft ${fixture.id} returned depth ${owned.depth}, expected ${entry.depth}`);
    }
    if (owned.nodes !== entry.expected_nodes) {
      fail(
        `owned perft ${fixture.id} depth ${entry.depth} nodes ${owned.nodes} != expected ${entry.expected_nodes}`,
      );
      printOwnedDivide(fixture, entry.depth);
    }
    if (Array.isArray(entry.divide)) {
      compareDivide(entry.divide, owned.divide ?? [], `owned perft ${fixture.id} depth ${entry.depth}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Oracle harness failed before Stockfish validation:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

if (args.has("--owned-only")) {
  console.log("Oracle harness owned-engine checks passed:");
  printResults(ownedResults);
  process.exit(0);
}

const stockfish = stockfishPath();
if (!stockfish) {
  console.log("Oracle harness owned-engine checks passed:");
  printResults(ownedResults);
  console.error("BLOCKED stockfish: set STOCKFISH_BIN or install stockfish on PATH.");
  process.exit(2);
}

for (const fixture of manifest.fixtures) {
  for (const entry of fixture.depths) {
    const result = runStockfishPerft(stockfish, fixture, entry.depth);
    if (result !== null) {
      recordResult(stockfishResults, "stockfish", fixture, entry.depth, entry.expected_nodes, result.nodes);
    }
    if (result !== null && result.nodes !== entry.expected_nodes) {
      fail(`stockfish ${fixture.id} depth ${entry.depth} nodes ${result.nodes} != expected ${entry.expected_nodes}`);
    }
    if (result !== null && Array.isArray(entry.divide)) {
      compareDivide(entry.divide, result.divide, `stockfish ${fixture.id} depth ${entry.depth}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Oracle validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Oracle validation passed:");
printResults(ownedResults);
printResults(stockfishResults);
