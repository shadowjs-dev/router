import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";
import { createConfig } from "./build/tsdown-preset.mjs";

// Each feature is a subpath of its own: a router pays only for the features its app imports.
const FEATURES = [
  "scroll",
  "loaders",
  "head",
  "errors",
  "filters",
  "blockers",
  "transitions",
  "prefetch",
  "prefetch-report",
  "relative",
  "announcer",
  "link-status",
  "search",
  "not-found",
  "pending",
];

const browser = createConfig({
  packageDir: import.meta.dirname,
  entries: {
    index: "src/index.ts",
    "core/index": "src/core/index.ts",
    ...Object.fromEntries(FEATURES.map((name) => [`features/${name}`, `src/features/${name}.ts`])),
  },
});

const pkg = JSON.parse(readFileSync(`${import.meta.dirname}/package.json`, "utf8"));

// `./vite` is build-time code that runs in Node. It has its own output folder (no dev/prod split,
// nothing in it depends on `__DEV__`), so cleaning it can never race with the browser builds.
const vite = defineConfig({
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  dts: true,
  entry: { index: "src/vite/index.ts" },
  outDir: "dist/vite",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  // Per-module output: see tools/build/tsdown-preset.mjs (unbundle).
  unbundle: true,
  define: { __VERSION__: JSON.stringify(pkg.version) },
});

export default [...browser, vite];
