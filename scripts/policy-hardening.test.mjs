import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvedThirdPartyRuntimeDependencyClosures,
  buildScriptSourcePaths,
  validateApprovedThirdPartyRuntimeClosures
} from "./cargo-runtime-closure-policy.mjs";
import {
  runtimeNetworkPatterns,
  textWithoutApprovedSameOriginEvidenceConnect
} from "./runtime-network-policy.mjs";

function expectEqual(actual, expected, label) {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(`${label}: expected ${expectedText}, got ${actualText}`);
  }
}

function expectIncludes(actual, expected, label) {
  if (!actual.some((value) => value.includes(expected))) {
    throw new Error(`${label}: expected ${JSON.stringify(actual)} to include ${expected}`);
  }
}

function expectTextIncludes(actual, expected, label) {
  if (!actual.includes(expected)) {
    throw new Error(`${label}: expected source to include ${expected}`);
  }
}

const approvedClosure = approvedThirdPartyRuntimeDependencyClosures[0];
const registry = "registry+https://github.com/rust-lang/crates.io-index";
const workspaceId = "workspace#chess-wasm-bridge@0.0.0";
const packageId = (name, version) => `${registry}#${name}@${version}`;
const rootDependency = packageId(approvedClosure.dependencyName, approvedClosure.dependencyVersion);

function packageFor(spec) {
  return {
    id: packageId(spec.name, spec.version),
    name: spec.name,
    version: spec.version,
    source: registry,
    targets: spec.customBuild
      ? [
          {
            name: "build-script-build",
            kind: ["custom-build"],
            src_path: `/registry/${spec.name}-${spec.version}/build.rs`
          }
        ]
      : [],
    dependencies: []
  };
}

function metadata(overrides = {}) {
  const packages = approvedClosure.packages.map(packageFor);
  const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const depsByName = new Map(approvedClosure.packages.map((spec) => [spec.name, []]));
  for (const spec of approvedClosure.packages) {
    for (const dependency of spec.dependencies) {
      depsByName.get(spec.name)?.push({
        name: dependency.name.replaceAll("-", "_"),
        pkg: packageId(dependency.name, dependency.version),
        dep_kinds: [{ kind: dependency.kind, target: null }]
      });
    }
  }

  const resolvedNodes = [
    {
      id: workspaceId,
      deps: [
        {
          name: approvedClosure.dependencyName.replaceAll("-", "_"),
          pkg: rootDependency,
          dep_kinds: [{ kind: null, target: null }]
        }
      ]
    },
    ...packages.map((pkg) => ({
      id: pkg.id,
      deps: depsByName.get(pkg.name) ?? []
    }))
  ];

  return {
    packages: [
      {
        id: workspaceId,
        name: approvedClosure.workspacePackage,
        version: "0.0.0",
        source: null,
        targets: [],
        dependencies: [
          {
            name: approvedClosure.dependencyName,
            kind: null,
            source: registry
          }
        ]
      },
      ...packages
    ],
    workspace_members: [workspaceId],
    resolve: { nodes: resolvedNodes },
    ...overrides
  };
}

function buildScriptText(spec) {
  return spec.buildScriptSubprocess ? "use std::process::Command;" : "fn main() {}";
}

function validate(input) {
  return validateApprovedThirdPartyRuntimeClosures(input, {
    readBuildScript: (pkg) => {
      const spec = approvedClosure.packages.find((candidate) => candidate.name === pkg.name);
      return spec === undefined ? "fn main() {}" : buildScriptText(spec);
    }
  });
}

expectEqual(validate(metadata()), [], "approved closure should validate");

const withExtraPackage = metadata();
withExtraPackage.packages.push({
  id: packageId("surprise", "1.0.0"),
  name: "surprise",
  version: "1.0.0",
  source: registry,
  targets: [],
  dependencies: []
});
withExtraPackage.resolve.nodes.push({
  id: packageId("surprise", "1.0.0"),
  deps: []
});
withExtraPackage.resolve.nodes
  .find((node) => node.id === rootDependency)
  ?.deps.push({
    name: "surprise",
    pkg: packageId("surprise", "1.0.0"),
    dep_kinds: [{ kind: null, target: null }]
  });
expectIncludes(validate(withExtraPackage), "unexpected approved closure package surprise@1.0.0", "extra package");

const withVersionDrift = metadata();
const onceCell = withVersionDrift.packages.find((pkg) => pkg.name === "once_cell");
onceCell.version = "9.9.9";
expectIncludes(validate(withVersionDrift), "expected once_cell@1.21.4", "version drift");

const withDirectEdgeVersionDrift = metadata();
withDirectEdgeVersionDrift.resolve.nodes
  .find((node) => node.id === workspaceId)
  ?.deps.splice(0, 1, {
    name: approvedClosure.dependencyName.replaceAll("-", "_"),
    pkg: packageId("wasm-bindgen", "9.9.9"),
    dep_kinds: [{ kind: null, target: null }]
  });
withDirectEdgeVersionDrift.packages.push({
  id: packageId("wasm-bindgen", "9.9.9"),
  name: "wasm-bindgen",
  version: "9.9.9",
  source: registry,
  targets: [],
  dependencies: []
});
withDirectEdgeVersionDrift.resolve.nodes.push({
  id: packageId("wasm-bindgen", "9.9.9"),
  deps: []
});
expectIncludes(
  validate(withDirectEdgeVersionDrift),
  "expected direct runtime edge to wasm-bindgen@0.2.121",
  "direct edge version drift"
);

const withBuildSurfaceDrift = metadata();
const cfgIf = withBuildSurfaceDrift.packages.find((pkg) => pkg.name === "cfg-if");
cfgIf.targets.push({
  name: "build-script-build",
  kind: ["custom-build"],
  src_path: "/registry/cfg-if-1.0.4/build.rs"
});
expectIncludes(validate(withBuildSurfaceDrift), "cfg-if@1.0.4 custom-build surface changed", "custom-build drift");

const withBuildDependencyDrift = metadata();
withBuildDependencyDrift.resolve.nodes
  .find((node) => node.id === packageId("once_cell", "1.21.4"))
  ?.deps.push({
    name: "quote",
    pkg: packageId("quote", "1.0.45"),
    dep_kinds: [{ kind: "build", target: null }]
  });
expectIncludes(validate(withBuildDependencyDrift), "once_cell@1.21.4 build dependency surface changed", "build dependency drift");

const buildScriptFixtureDir = mkdtempSync(join(tmpdir(), "chess-build-script-"));
const buildScriptEntrypoint = join(buildScriptFixtureDir, "build.rs");
const buildScriptModule = join(buildScriptFixtureDir, "helper.rs");
writeFileSync(buildScriptEntrypoint, "mod helper;\nfn main() {}\n", "utf8");
writeFileSync(buildScriptModule, "pub fn helper() {}\n", "utf8");
expectEqual(
  buildScriptSourcePaths({
    targets: [
      {
        kind: ["custom-build"],
        src_path: buildScriptEntrypoint
      }
    ]
  }),
  [buildScriptEntrypoint, buildScriptModule].sort(),
  "build-script local module traversal"
);

const networkViolations = validateApprovedThirdPartyRuntimeClosures(metadata(), {
  readBuildScript: (pkg) =>
    pkg.name === "wasm-bindgen" ? "use std::net::TcpStream;" : "fn main() {}"
});
expectIncludes(networkViolations, "wasm-bindgen@0.2.121 build script contains forbidden network token", "build-script network");

const subprocessViolations = validateApprovedThirdPartyRuntimeClosures(metadata(), {
  readBuildScript: (pkg) =>
    pkg.name === "wasm-bindgen" ? "use std::process::Command;" : buildScriptText(pkg)
});
expectIncludes(subprocessViolations, "wasm-bindgen@0.2.121 build-script subprocess surface changed", "subprocess drift");

const runtimeAuditSource = readFileSync("scripts/audit-runtime-network.mjs", "utf8");
expectTextIncludes(
  runtimeAuditSource,
  "textWithoutApprovedSameOriginEvidenceConnect",
  "runtime audit shared matcher"
);

const policyAuditSource = readFileSync("scripts/audit-policy.mjs", "utf8");
expectTextIncludes(
  policyAuditSource,
  "approvedStockfishSourceReferences",
  "policy audit approved Stockfish reference allowlist"
);
expectTextIncludes(
  policyAuditSource,
  "apps/web/src/play-engine.ts",
  "policy audit ADR-0117 Play engine allowlist"
);
expectTextIncludes(
  policyAuditSource,
  "apps/web/src/app.ts",
  "policy audit ADR-0117 Play app injection allowlist"
);
expectTextIncludes(
  policyAuditSource,
  "apps/web/src/app.test.ts",
  "policy audit ADR-0117 Play app isolation test allowlist"
);
expectTextIncludes(
  policyAuditSource,
  "apps/web/src/play-ui.ts",
  "policy audit ADR-0117 Play UI allowlist"
);
expectTextIncludes(
  policyAuditSource,
  "isApprovedIgnoredOperationalBundle",
  "policy audit keeps ignored git-bundle snapshots operational"
);

const productHtmlSource = readFileSync("apps/web/index.html", "utf8");
expectTextIncludes(
  productHtmlSource,
  "connect-src 'self'",
  "product HTML keeps ADR-0227 same-origin connect CSP"
);
expectEqual(
  textWithoutApprovedSameOriginEvidenceConnect('fetch("/evidence/append", { method: "POST" });').includes("fetch("),
  false,
  "ADR-0227 evidence append fetch allowlist"
);
expectEqual(
  textWithoutApprovedSameOriginEvidenceConnect('fetch("/game-archive/append", { method: "POST" });').includes("fetch("),
  false,
  "ADR-0241 game archive append fetch allowlist"
);
expectEqual(
  textWithoutApprovedSameOriginEvidenceConnect('fetch("/analyzer/analyze", { method: "POST" });').includes("fetch("),
  false,
  "ADR-0242 analyzer analyze fetch allowlist"
);
expectEqual(
  textWithoutApprovedSameOriginEvidenceConnect('fetch("/api/other", { method: "POST" });').includes("fetch("),
  true,
  "non-evidence fetch remains forbidden"
);

const appSource = readFileSync("apps/web/src/app.ts", "utf8");
expectTextIncludes(
  appSource,
  "resolveBootstrappedPlayBestMoveProvider",
  "app has explicit Play provider bootstrap resolver"
);
expectTextIncludes(
  appSource,
  "__chessPlayBestMoveProvider",
  "app bootstrap host uses narrow Play provider property"
);

const previewStockfishSource = readFileSync("scripts/preview-play-local-stockfish.mjs", "utf8");
expectTextIncludes(
  previewStockfishSource,
  "CHESS_PLAY_STOCKFISH_PREVIEW_PORT",
  "Play Stockfish preview uses explicit port env"
);
expectTextIncludes(
  previewStockfishSource,
  "127.0.0.1",
  "Play Stockfish preview binds loopback"
);
expectTextIncludes(
  previewStockfishSource,
  "connect-src 'self'",
  "Play Stockfish preview CSP allows same-origin only"
);
for (const endpoint of [
  "/api/play/stockfish-status",
  "/api/play/stockfish-new-game",
  "/api/play/stockfish-best-move",
  "/api/play/stockfish-cancel"
]) {
  expectTextIncludes(previewStockfishSource, endpoint, `Play Stockfish preview endpoint ${endpoint}`);
}
expectTextIncludes(
  previewStockfishSource,
  "allowedPreviewProviderNetworkTokens",
  "Play Stockfish preview has a named provider network-token allowlist"
);
expectTextIncludes(
  policyAuditSource,
  "scanStockfishAdapterScriptImport",
  "policy audit blocks production imports of script-side Stockfish adapter"
);
expectTextIncludes(
  policyAuditSource,
  "createLocalStockfishBestMoveProvider",
  "policy audit blocks script-side Stockfish provider import by symbol"
);
expectTextIncludes(
  policyAuditSource,
  '"--filter-platform"',
  "policy audit wasm filter flag"
);
expectTextIncludes(
  policyAuditSource,
  '"wasm32-unknown-unknown"',
  "policy audit wasm graph target"
);

const proofSource = readFileSync("scripts/proof-p2-14-wasm-browser-executor.mjs", "utf8");
expectTextIncludes(
  proofSource,
  'import { runtimeNetworkPatterns } from "./runtime-network-policy.mjs";',
  "proof shared matcher"
);
expectTextIncludes(proofSource, "runPolicyPreflight();", "proof policy preflight");
expectTextIncludes(proofSource, "assertWasmBindgenCliVersion();", "proof CLI version");
expectEqual(
  runtimeNetworkPatterns.map((pattern) => pattern.name).length > 0,
  true,
  "shared runtime matcher should not be empty"
);

// Exercise the real audit with an isolated Git index. Finder metadata must not
// block a local build, while deliberately tracking it under data must still fail.
const metadataProofRoot = join(process.cwd(), "target/proofs/policy-metadata");
mkdirSync(metadataProofRoot, { recursive: true });
const metadataIndex = join(metadataProofRoot, "index");
const metadataEnv = { ...process.env, GIT_INDEX_FILE: metadataIndex };
const finderMetadata = "data/.DS_Store";
const createdMetadata = !existsSync(finderMetadata);
if (createdMetadata) writeFileSync(finderMetadata, "Finder metadata fixture\n", { flag: "wx" });
const forbiddenBlob = `data/policy-metadata-proof-${process.pid}.bin`;
rmSync(metadataIndex, { force: true });
try {
  const readTree = spawnSync("git", ["read-tree", "HEAD"], { env: metadataEnv, encoding: "utf8" });
  expectEqual(readTree.status, 0, "metadata proof isolated index");
  const ignored = spawnSync("git", ["check-ignore", "data/.DS_Store"], { encoding: "utf8" });
  expectEqual(ignored.status, 0, "Finder metadata is gitignored");
  const untrackedAudit = spawnSync(process.execPath, ["scripts/audit-policy.mjs"], {
    env: metadataEnv, encoding: "utf8"
  });
  expectEqual(untrackedAudit.status, 0, `ignored metadata audit: ${untrackedAudit.stderr}`);
  const blob = spawnSync("git", ["rev-parse", "HEAD:.gitignore"], { encoding: "utf8" });
  expectEqual(blob.status, 0, "metadata proof existing blob");
  const trackMetadata = spawnSync("git", [
    "update-index", "--add", "--cacheinfo", `100644,${blob.stdout.trim()},data/.DS_Store`
  ], { env: metadataEnv, encoding: "utf8" });
  expectEqual(trackMetadata.status, 0, "metadata proof tracked fixture");
  const trackedAudit = spawnSync(process.execPath, ["scripts/audit-policy.mjs"], {
    env: metadataEnv, encoding: "utf8"
  });
  expectEqual(trackedAudit.status, 1, "tracked data metadata remains forbidden");
  expectTextIncludes(trackedAudit.stderr, "data/.DS_Store", "tracked metadata violation");
  writeFileSync(forbiddenBlob, "Forbidden artifact fixture\n", { flag: "wx" });
  const forbiddenAudit = spawnSync(process.execPath, ["scripts/audit-policy.mjs"], {
    encoding: "utf8"
  });
  expectEqual(forbiddenAudit.status, 1, "untracked binary artifact remains forbidden");
  expectTextIncludes(forbiddenAudit.stderr, "banned data/blob/binary artifact extension .bin", "binary violation");
  writeFileSync(join(metadataProofRoot, "summary.json"), `${JSON.stringify({
    status: "PASS", ignoredMetadata: "PASS", trackedDataMetadataRejected: "PASS", binaryArtifactRejected: "PASS"
  }, null, 2)}\n`);
} finally {
  rmSync(metadataIndex, { force: true });
  rmSync(forbiddenBlob, { force: true });
  if (createdMetadata) rmSync(finderMetadata, { force: true });
}

console.log("Policy hardening tests passed.");
