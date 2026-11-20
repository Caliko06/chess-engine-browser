import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const mode = process.argv[2] ?? "check";
const failures = [];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    env: { ...process.env, ...(options.env ?? {}) }
  });
}

function requireCommand(label, command, args = ["--version"], options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    failures.push(`${label} is unavailable. Run ${mode === "setup" ? "scripts/setup.sh again" : "just setup"}.`);
    return;
  }
  const version = `${result.stdout}${result.stderr}`.trim().split("\n")[0];
  if (version.length > 0) {
    console.log(`${label}: ${version}`);
  }
}

requireCommand("cargo", "cargo");
requireCommand("rustc", "rustc");
requireCommand("rustup", "rustup");
requireCommand("cargo-nextest", "cargo", ["nextest", "--version"]);
requireCommand("cargo-deny", "cargo", ["deny", "--version"]);
requireCommand("node", "node");
requireCommand("pnpm", "pnpm", ["--version"], {
  env: {
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_NETWORK: "0"
  }
});

if (!existsSync("Cargo.lock")) {
  failures.push("Cargo.lock is missing. Run just setup.");
}

if (!existsSync("pnpm-lock.yaml")) {
  failures.push("pnpm-lock.yaml is missing. Run just setup.");
}

if (!existsSync("node_modules/.modules.yaml")) {
  failures.push("pnpm dependencies are not installed. Run just setup.");
}

if (!existsSync("apps/web/node_modules/.bin/tsc")) {
  failures.push("apps/web TypeScript dependencies are not installed. Run just setup.");
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`setup check failed: ${failure}`);
  }
  process.exit(1);
}
