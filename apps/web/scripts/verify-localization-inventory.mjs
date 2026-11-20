import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sourcePath = resolve("apps/web/src/ui-localization.ts");
const source = readFileSync(sourcePath, "utf8");
const localeBlocks = [...source.matchAll(/^  (es|en): \{([\s\S]*?)^  \}/gmu)];
if (localeBlocks.length !== 2) {
  throw new Error("localization inventory: expected exactly es and en catalogs");
}

const keysFor = (block) => [...block.matchAll(/^    ([A-Za-z][A-Za-z0-9]*): /gmu)].map((match) => match[1]);
const valuesFor = (block) => [...block.matchAll(/^    [A-Za-z][A-Za-z0-9]*: "([^"]*)"/gmu)].map((match) => match[1]);
const [es, en] = localeBlocks;
const esKeys = keysFor(es[2]);
const enKeys = keysFor(en[2]);
if (JSON.stringify(esKeys) !== JSON.stringify(enKeys)) {
  throw new Error(`localization inventory: key parity failed (${esKeys.length}/${enKeys.length})`);
}
if (valuesFor(es[2]).some((value) => value.trim() === "") || valuesFor(en[2]).some((value) => value.trim() === "")) {
  throw new Error("localization inventory: empty copy value");
}
if (!source.includes('export const defaultUiLocale: UiLocale = "es";')) {
  throw new Error("localization inventory: Spanish default missing");
}
if (source.includes("copyFor(locale) ?? copyFor(\"en\")")) {
  throw new Error("localization inventory: implicit English fallback detected");
}
console.log(`Localization inventory passed: ${esKeys.length} keys, ES/EN parity, no fallback.`);
