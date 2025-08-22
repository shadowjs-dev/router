import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: {
    compilerOptions: {
      skipLibCheck: true,
    },
  }, // Generate DTS with peer dependency handling
  sourcemap: true,
  clean: true,
  target: "es2020",
  treeshake: true,
  platform: "browser",
  minify: false,
});
