import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { contentType, copyBuiltWeb, repoRoot, servedStaticExtensions } from "./beta-preview-support.mjs";

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

const expectedContentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"]
]);

for (const [extension, expected] of expectedContentTypes) {
  expectEqual(contentType(`sample${extension}`), expected, `content-type ${extension}`);
}

for (const extension of expectedContentTypes.keys()) {
  if (!servedStaticExtensions.includes(extension)) {
    throw new Error(`served-extensions missing ${extension}`);
  }
}

for (const extension of servedStaticExtensions) {
  if (!expectedContentTypes.has(extension)) {
    throw new Error(`served extension ${extension} has no dedicated content-type expectation`);
  }
}

const nestedBuildSource = join(repoRoot, "apps/web/dist/__preview-copy-test__/nested.js");
const previewCopyOutput = join(repoRoot, "tmp/preview-copy-static-assets-test");
rmSync(join(repoRoot, "apps/web/dist/__preview-copy-test__"), { recursive: true, force: true });
rmSync(previewCopyOutput, { recursive: true, force: true });
mkdirSync(join(repoRoot, "apps/web/dist/__preview-copy-test__"), { recursive: true });
writeFileSync(nestedBuildSource, "export const previewCopyTest = true;\n");
try {
  copyBuiltWeb(previewCopyOutput);
  if (!existsSync(join(previewCopyOutput, "dist/__preview-copy-test__/nested.js"))) {
    throw new Error("copyBuiltWeb did not preserve nested dist JavaScript paths");
  }
  if (existsSync(join(previewCopyOutput, "dist/nested.js"))) {
    throw new Error("copyBuiltWeb flattened a nested dist JavaScript path");
  }
} finally {
  rmSync(join(repoRoot, "apps/web/dist/__preview-copy-test__"), { recursive: true, force: true });
  rmSync(previewCopyOutput, { recursive: true, force: true });
}

const productCssPath = join(repoRoot, "apps/web/review.css");
const productCss = readFileSync(productCssPath, "utf8");
const assetReferences = [...productCss.matchAll(/url\("\.\/(assets\/[^"]+)"\)/gu)].map(
  (match) => match[1]
);
if (assetReferences.length === 0) {
  throw new Error("review.css asset scan found no url() references; scan pattern is stale");
}
for (const reference of assetReferences) {
  const assetPath = join(repoRoot, "apps/web", reference);
  if (!existsSync(assetPath)) {
    throw new Error(`review.css references missing asset: ${reference}`);
  }
  const extension = extname(reference);
  if (!servedStaticExtensions.includes(extension)) {
    throw new Error(`review.css references asset the preview servers will not serve: ${reference}`);
  }
  expectEqual(
    contentType(reference),
    expectedContentTypes.get(extension),
    `review.css asset content-type ${reference}`
  );
}

console.log(
  `preview-static-assets: ${assetReferences.length} css asset references servable, ` +
    `${servedStaticExtensions.length} served extensions mapped`
);
