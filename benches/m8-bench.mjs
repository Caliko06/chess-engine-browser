#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const baselinePath = join(repoRoot, "benches", "baseline.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const baselineFields = [
  "schema_version",
  "generated_on",
  "hardware",
  "command",
  "search",
  "position_set",
  "depth",
  "total_nodes",
  "elapsed_ms",
  "nodes_per_second"
];
const currentFields = [
  "command",
  "search",
  "position_set",
  "depth",
  "total_nodes",
  "elapsed_ms",
  "nodes_per_second"
];

const output = spawnSync(
  "cargo",
  ["run", "--release", "--quiet", "-p", "chess-search", "--example", "m8_bench"],
  {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120000,
  }
);

if (output.error !== undefined) {
  console.error(`benchmark command failed to start or finish: ${output.error.message}`);
  process.exit(1);
}
if (output.status !== 0) {
  const stderr = typeof output.stderr === "string" ? output.stderr.trim() : "";
  console.error(stderr || `benchmark command exited with status ${String(output.status)}`);
  process.exit(output.status ?? 1);
}

const lines = output.stdout
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0);
if (lines.length === 0) {
  console.error("benchmark emitted no output");
  process.exit(1);
}

let current;
try {
  current = JSON.parse(lines[lines.length - 1]);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`benchmark emitted invalid JSON: ${reason}`);
  process.exit(1);
}

for (const field of baselineFields) {
  if (!(field in baseline)) {
    console.error(`baseline missing ${field}`);
    process.exit(1);
  }
}
for (const field of currentFields) {
  if (!(field in current)) {
    console.error(`benchmark output missing ${field}`);
    process.exit(1);
  }
}

function benchmarkComparison() {
  const deltaNodes = current.total_nodes - baseline.total_nodes;
  const deltaNps = current.nodes_per_second - baseline.nodes_per_second;
  const legacyNps = baseline.legacy_m8_baseline?.nodes_per_second;
  const legacySpeedup =
    typeof legacyNps === "number" && legacyNps > 0
      ? ` legacy_m8_nps=${legacyNps} speedup_vs_legacy=${(current.nodes_per_second / legacyNps).toFixed(2)}x`
      : "";
  return [
    `search=${current.search}`,
    `depth=${current.depth}`,
    `baseline_total_nodes=${baseline.total_nodes}`,
    `current_total_nodes=${current.total_nodes}`,
    `delta_nodes=${deltaNodes}`,
    `baseline_nps=${baseline.nodes_per_second}`,
    `current_nps=${current.nodes_per_second}`,
    `delta_nps=${deltaNps}${legacySpeedup}`
  ].join(" ");
}

if (baseline.command !== current.command) {
  console.error(`command mismatch: baseline=${baseline.command} current=${current.command}`);
  process.exit(1);
}
if (baseline.search !== current.search) {
  console.error(`search mismatch: baseline=${baseline.search} current=${current.search}`);
  process.exit(1);
}
if (baseline.depth !== current.depth) {
  console.error(`depth mismatch: baseline=${baseline.depth} current=${current.depth}`);
  process.exit(1);
}
if (JSON.stringify(baseline.position_set) !== JSON.stringify(current.position_set)) {
  console.error("position set mismatch");
  process.exit(1);
}
if (baseline.total_nodes !== current.total_nodes) {
  console.error(`total nodes mismatch: ${benchmarkComparison()}`);
  process.exit(1);
}
if (current.total_nodes === 0 || current.elapsed_ms === 0 || current.nodes_per_second === 0) {
  console.error("benchmark did not perform measurable work");
  process.exit(1);
}

console.log(`M8 bench passed: ${benchmarkComparison()}`);
