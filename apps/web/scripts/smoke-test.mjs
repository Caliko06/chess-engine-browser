import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/smoke.ts", import.meta.url), "utf8");

if (!source.includes('phaseZeroMarker = "phase-0-scaffold"')) {
  console.error("Phase 0 web smoke marker is missing or changed.");
  process.exit(1);
}

if (!source.includes('m12BoundaryMarker = "m12-wasm-dto-boundary"')) {
  console.error("M12 web DTO boundary marker is missing or changed.");
  process.exit(1);
}

console.log("Phase 0/M12 web smoke test passed.");
