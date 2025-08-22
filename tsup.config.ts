import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: false, // Temporarily disable DTS until @shadow-js/core is available
  sourcemap: true,
  clean: true,
  target: "es2020",
  treeshake: true,
  platform: "browser",
  minify: false,
});
