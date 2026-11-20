import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildScriptNetworkPatterns,
  matchingPatternNames,
  rustSubprocessPattern
} from "./runtime-network-policy.mjs";

const registrySource = "registry+https://github.com/rust-lang/crates.io-index";

export const approvedThirdPartyRuntimeDependencyClosures = [
  {
    workspacePackage: "chess-wasm-bridge",
    dependencyName: "wasm-bindgen",
    dependencyVersion: "0.2.121",
    approval: "ADR-0020 (archived in git tag governance-archive)",
    packages: [
      {
        name: "wasm-bindgen",
        version: "0.2.121",
        source: registrySource,
        customBuild: true,
        buildScriptSubprocess: false,
        dependencies: [
          { name: "cfg-if", version: "1.0.4", kind: null },
          { name: "once_cell", version: "1.21.4", kind: null },
          { name: "rustversion", version: "1.0.22", kind: "build" },
          { name: "wasm-bindgen-macro", version: "0.2.121", kind: null },
          { name: "wasm-bindgen-shared", version: "0.2.121", kind: null }
        ]
      },
      {
        name: "cfg-if",
        version: "1.0.4",
        source: registrySource,
        customBuild: false,
        buildScriptSubprocess: false,
        dependencies: []
      },
      {
        name: "once_cell",
        version: "1.21.4",
        source: registrySource,
        customBuild: false,
        buildScriptSubprocess: false,
        dependencies: []
      },
      {
        name: "rustversion",
        version: "1.0.22",
        source: registrySource,
        customBuild: true,
        buildScriptSubprocess: true,
        dependencies: []
      },
      {
        name: "wasm-bindgen-macro",
        version: "0.2.121",
        source: registrySource,
        customBuild: false,
        buildScriptSubprocess: false,
        dependencies: [
          { name: "quote", version: "1.0.45", kind: null },
          { name: "wasm-bindgen-macro-support", version: "0.2.121", kind: null }
        ]
      },
      {
        name: "quote",
        version: "1.0.45",
        source: registrySource,
        customBuild: true,
        buildScriptSubprocess: true,
        dependencies: [{ name: "proc-macro2", version: "1.0.106", kind: null }]
      },
      {
        name: "proc-macro2",
        version: "1.0.106",
        source: registrySource,
        customBuild: true,
        buildScriptSubprocess: true,
        dependencies: [{ name: "unicode-ident", version: "1.0.24", kind: null }]
      },
      {
        name: "unicode-ident",
        version: "1.0.24",
        source: registrySource,
        customBuild: false,
        buildScriptSubprocess: false,
        dependencies: []
      },
      {
        name: "wasm-bindgen-macro-support",
        version: "0.2.121",
        source: registrySource,
        customBuild: false,
        buildScriptSubprocess: false,
        dependencies: [
          { name: "bumpalo", version: "3.20.2", kind: null },
          { name: "proc-macro2", version: "1.0.106", kind: null },
          { name: "quote", version: "1.0.45", kind: null },
          { name: "syn", version: "2.0.117", kind: null },
          { name: "wasm-bindgen-shared", version: "0.2.121", kind: null }
        ]
      },
      {
        name: "bumpalo",
        version: "3.20.2",
        source: registrySource,
        customBuild: false,
        buildScriptSubprocess: false,
        dependencies: []
      },
      {
        name: "syn",
        version: "2.0.117",
        source: registrySource,
        customBuild: false,
        buildScriptSubprocess: false,
        dependencies: [
          { name: "proc-macro2", version: "1.0.106", kind: null },
          { name: "quote", version: "1.0.45", kind: null },
          { name: "unicode-ident", version: "1.0.24", kind: null }
        ]
      },
      {
        name: "wasm-bindgen-shared",
        version: "0.2.121",
        source: registrySource,
        customBuild: true,
        buildScriptSubprocess: true,
        dependencies: [{ name: "unicode-ident", version: "1.0.24", kind: null }]
      }
    ]
  }
];

export function approvedDirectThirdPartyRuntimeDeps() {
  const approved = new Map();
  for (const closure of approvedThirdPartyRuntimeDependencyClosures) {
    const workspaceApprovals = approved.get(closure.workspacePackage) ?? new Map();
    workspaceApprovals.set(closure.dependencyName, closure.approval);
    approved.set(closure.workspacePackage, workspaceApprovals);
  }
  return approved;
}

function nodeById(metadata) {
  return new Map((metadata.resolve?.nodes ?? []).map((node) => [node.id, node]));
}

function packageById(metadata) {
  return new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
}

function packageLabel(pkg) {
  return `${pkg.name}@${pkg.version}`;
}

function directRuntimeDependencyPackage(
  metadata,
  workspacePackageName,
  dependencyName,
  dependencyVersion
) {
  const workspacePackage = metadata.packages.find(
    (pkg) => pkg.name === workspacePackageName && pkg.source === null
  );
  if (workspacePackage === undefined) {
    return undefined;
  }

  const packages = packageById(metadata);
  const workspaceNode = nodeById(metadata).get(workspacePackage.id);
  return (workspaceNode?.deps ?? [])
    .filter((dep) => dep.dep_kinds.some((depKind) => depKind.kind === null))
    .map((dep) => packages.get(dep.pkg))
    .find(
      (pkg) =>
        pkg !== undefined &&
        pkg.name === dependencyName &&
        pkg.version === dependencyVersion
    );
}

function hasCustomBuild(pkg) {
  return (pkg.targets ?? []).some((target) => (target.kind ?? []).includes("custom-build"));
}

function customBuildSources(pkg) {
  return (pkg.targets ?? [])
    .filter((target) => (target.kind ?? []).includes("custom-build"))
    .map((target) => target.src_path)
    .filter((path) => typeof path === "string");
}

function localBuildScriptDependencies(path, source) {
  const dependencies = [];
  const directory = dirname(path);

  for (const match of source.matchAll(/\binclude!\(\s*"([^"]+)"\s*\)/gu)) {
    dependencies.push(join(directory, match[1]));
  }

  for (const match of source.matchAll(
    /(?:#\s*\[\s*path\s*=\s*"([^"]+)"\s*\]\s*)?\bmod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gu
  )) {
    if (match[1] !== undefined) {
      dependencies.push(join(directory, match[1]));
      continue;
    }

    const moduleName = match[2];
    const flatModule = join(directory, `${moduleName}.rs`);
    const nestedModule = join(directory, moduleName, "mod.rs");
    if (existsSync(flatModule)) {
      dependencies.push(flatModule);
    } else if (existsSync(nestedModule)) {
      dependencies.push(nestedModule);
    }
  }

  return dependencies;
}

export function buildScriptSourcePaths(pkg) {
  const pending = customBuildSources(pkg);
  const visited = new Set();
  const paths = [];

  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || visited.has(path)) {
      continue;
    }
    visited.add(path);
    paths.push(path);

    const source = readFileSync(path, "utf8");
    pending.push(...localBuildScriptDependencies(path, source));
  }

  return paths.sort();
}

function dependencySurface(metadata, pkg) {
  const packages = packageById(metadata);
  const node = nodeById(metadata).get(pkg.id);
  return (node?.deps ?? [])
    .flatMap((dep) =>
      dep.dep_kinds.map((depKind) => {
        const dependency = packages.get(dep.pkg);
        return dependency === undefined
          ? null
          : {
              name: dependency.name,
              version: dependency.version,
              kind: depKind.kind
            };
      })
    )
    .filter((dep) => dep !== null)
    .sort(compareDependencySurface);
}

function compareDependencySurface(left, right) {
  return `${left.name}@${left.version}:${String(left.kind)}`.localeCompare(
    `${right.name}@${right.version}:${String(right.kind)}`
  );
}

function dependencySurfaceText(surface) {
  return surface
    .map((dependency) => `${dependency.name}@${dependency.version}:${String(dependency.kind)}`)
    .join(",");
}

function closurePackages(metadata, directPackage) {
  const packages = packageById(metadata);
  const nodes = nodeById(metadata);
  const pending = [directPackage.id];
  const visited = new Set();
  const closure = [];

  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) {
      continue;
    }
    visited.add(id);
    const pkg = packages.get(id);
    if (pkg === undefined) {
      continue;
    }
    if (pkg.source !== null) {
      closure.push(pkg);
    }
    for (const dep of nodes.get(id)?.deps ?? []) {
      pending.push(dep.pkg);
    }
  }

  return closure.sort((left, right) => packageLabel(left).localeCompare(packageLabel(right)));
}

function defaultReadBuildScript(pkg) {
  return buildScriptSourcePaths(pkg).map((path) => readFileSync(path, "utf8")).join("\n");
}

export function validateApprovedThirdPartyRuntimeClosures(metadata, options = {}) {
  const violations = [];
  const readBuildScript = options.readBuildScript ?? defaultReadBuildScript;

  for (const approvedClosure of approvedThirdPartyRuntimeDependencyClosures) {
    const directPackage = directRuntimeDependencyPackage(
      metadata,
      approvedClosure.workspacePackage,
      approvedClosure.dependencyName,
      approvedClosure.dependencyVersion
    );
    if (directPackage === undefined) {
      violations.push(
        `${approvedClosure.workspacePackage}: expected direct runtime edge to ${approvedClosure.dependencyName}@${approvedClosure.dependencyVersion}`
      );
      continue;
    }

    const actualPackages = closurePackages(metadata, directPackage);
    const expectedByLabel = new Map(
      approvedClosure.packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg])
    );
    const actualByLabel = new Map(actualPackages.map((pkg) => [packageLabel(pkg), pkg]));

    for (const expected of approvedClosure.packages) {
      const actual = actualByLabel.get(`${expected.name}@${expected.version}`);
      if (actual === undefined) {
        violations.push(
          `${approvedClosure.workspacePackage}: expected ${expected.name}@${expected.version} in approved closure`
        );
      }
    }
    for (const actual of actualPackages) {
      if (!expectedByLabel.has(packageLabel(actual))) {
        violations.push(
          `${approvedClosure.workspacePackage}: unexpected approved closure package ${packageLabel(actual)}`
        );
      }
    }

    for (const [label, expected] of expectedByLabel) {
      const actual = actualByLabel.get(label);
      if (actual === undefined) {
        continue;
      }
      if (actual.source !== expected.source) {
        violations.push(
          `${approvedClosure.workspacePackage}: ${label} source changed from ${expected.source} to ${actual.source}`
        );
      }

      if (hasCustomBuild(actual) !== expected.customBuild) {
        violations.push(
          `${approvedClosure.workspacePackage}: ${label} custom-build surface changed`
        );
      }

      const actualDependencies = dependencySurface(metadata, actual);
      const expectedDependencies = expected.dependencies.slice().sort(compareDependencySurface);
      if (dependencySurfaceText(actualDependencies) !== dependencySurfaceText(expectedDependencies)) {
        violations.push(
          `${approvedClosure.workspacePackage}: ${label} build dependency surface changed from ${dependencySurfaceText(expectedDependencies)} to ${dependencySurfaceText(actualDependencies)}`
        );
      }

      if (expected.customBuild) {
        const buildScript = readBuildScript(actual);
        const networkTokens = matchingPatternNames(buildScript, buildScriptNetworkPatterns);
        if (networkTokens.length > 0) {
          violations.push(
            `${approvedClosure.workspacePackage}: ${label} build script contains forbidden network token ${networkTokens.join(", ")}`
          );
        }
        const hasSubprocess = rustSubprocessPattern?.regex.test(buildScript) ?? false;
        if (hasSubprocess !== expected.buildScriptSubprocess) {
          violations.push(
            `${approvedClosure.workspacePackage}: ${label} build-script subprocess surface changed`
          );
        }
      }
    }
  }

  return violations;
}
