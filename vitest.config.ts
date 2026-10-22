import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const exact = (entries: [string, string][]) =>
  entries.map(([specifier, path]) => ({
    find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`),
    replacement: source(path),
  }));

// This repository's own packages are imported from source, so a test run needs no build.
const own: [string, string][] = [
  ["@shadow-js/router/prefetch-report", "./src/features/prefetch-report.ts"],
  ["@shadow-js/router/transitions", "./src/features/transitions.ts"],
  ["@shadow-js/router/link-status", "./src/features/link-status.ts"],
  ["@shadow-js/router/announcer", "./src/features/announcer.ts"],
  ["@shadow-js/router/not-found", "./src/features/not-found.ts"],
  ["@shadow-js/router/blockers", "./src/features/blockers.ts"],
  ["@shadow-js/router/relative", "./src/features/relative.ts"],
  ["@shadow-js/router/prefetch", "./src/features/prefetch.ts"],
  ["@shadow-js/router/loaders", "./src/features/loaders.ts"],
  ["@shadow-js/router/filters", "./src/features/filters.ts"],
  ["@shadow-js/router/pending", "./src/features/pending.ts"],
  ["@shadow-js/router/scroll", "./src/features/scroll.ts"],
  ["@shadow-js/router/errors", "./src/features/errors.ts"],
  ["@shadow-js/router/search", "./src/features/search.ts"],
  ["@shadow-js/router/core", "./src/core/index.ts"],
  ["@shadow-js/router/vite", "./src/vite/index.ts"],
  ["@shadow-js/router/head", "./src/features/head.ts"],
  ["@shadow-js/router", "./src/index.ts"],
];
// The other ShadowJS packages come from node_modules, as the build an app would get: the browser development build for DOM and unit
// tests, the server development build for server tests. Naming the files keeps every package on one build, so there is one copy of core.
const fromClient: [string, string][] = [
  ["@shadow-js/compiler/javascript", "./node_modules/@shadow-js/compiler/dist/dev/javascript.js"],
  ["@shadow-js/web/jsx-dev-runtime", "./node_modules/@shadow-js/web/dist/prod/jsx-dev-runtime.js"],
  ["@shadow-js/web/jsx-runtime", "./node_modules/@shadow-js/web/dist/prod/jsx-runtime.js"],
  ["@shadow-js/core/extend", "./node_modules/@shadow-js/core/dist/dev/extend/index.js"],
  ["@shadow-js/core/store", "./node_modules/@shadow-js/core/dist/dev/store/index.js"],
  ["@shadow-js/web/server", "./node_modules/@shadow-js/web/dist/dev/server.js"],
  ["@shadow-js/web/extend", "./node_modules/@shadow-js/web/dist/dev/extend.js"],
  ["@shadow-js/compiler", "./node_modules/@shadow-js/compiler/dist/dev/index.js"],
  ["@shadow-js/web/hmr", "./node_modules/@shadow-js/web/dist/dev/hmr.js"],
  ["@shadow-js/core", "./node_modules/@shadow-js/core/dist/dev/index.js"],
  ["@shadow-js/web", "./node_modules/@shadow-js/web/dist/dev/index.js"],
];
const fromServer: [string, string][] = [
  ["@shadow-js/compiler/javascript", "./node_modules/@shadow-js/compiler/dist/dev/javascript.js"],
  ["@shadow-js/web/jsx-dev-runtime", "./node_modules/@shadow-js/web/dist/prod/jsx-dev-runtime.js"],
  ["@shadow-js/web/jsx-runtime", "./node_modules/@shadow-js/web/dist/prod/jsx-runtime.js"],
  ["@shadow-js/core/extend", "./node_modules/@shadow-js/core/dist/server-dev/extend/index.js"],
  ["@shadow-js/core/store", "./node_modules/@shadow-js/core/dist/server-dev/store/index.js"],
  ["@shadow-js/web/server", "./node_modules/@shadow-js/web/dist/server-dev/server.js"],
  ["@shadow-js/web/extend", "./node_modules/@shadow-js/web/dist/server-dev/extend.js"],
  ["@shadow-js/compiler", "./node_modules/@shadow-js/compiler/dist/dev/index.js"],
  ["@shadow-js/web/hmr", "./node_modules/@shadow-js/web/dist/dev/hmr.js"],
  ["@shadow-js/core", "./node_modules/@shadow-js/core/dist/server-dev/index.js"],
  ["@shadow-js/web", "./node_modules/@shadow-js/web/dist/server-dev/index.js"],
];

const define = { __DEV__: "true", __SERVER__: "false", __TEST__: "true", __VERSION__: '"0.0.0"' };
const serverDefine = { ...define, __SERVER__: "true" };
// Matched against the file path, not the specifier: every ShadowJS package in node_modules goes through Vite, so they all share one copy of core.
const inline = {
  deps: { inline: [/[/]node_modules[/]@shadow-js[/]/, /[/]node_modules[/]create-shadow-app[/]/] },
};
const client = { alias: exact([...own, ...fromClient]) };
const serverSide = { alias: exact([...own, ...fromServer]) };

export default defineConfig({
  test: {
    // A snapshot that is missing fails the test; it is never written silently.
    snapshotOptions: { updateSnapshot: "none" },
    projects: [
      {
        define,
        resolve: client,
        test: {
          name: "unit",
          environment: "node",
          server: inline,
          testTimeout: 30_000,
          hookTimeout: 30_000,
          include: ["test/**/*.test.ts"],
          exclude: [
            "**/*.dom.test.ts",
            "**/*.server.test.ts",
            "**/*.gc.test.ts",
            "**/*.perf.test.ts",
            "**/*.dist.test.ts",
            "**/node_modules/**",
          ],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        define,
        resolve: client,
        test: {
          name: "dom",
          environment: "happy-dom",
          server: inline,
          testTimeout: 30_000,
          include: ["test/**/*.dom.test.ts"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        define: serverDefine,
        resolve: serverSide,
        test: {
          name: "server",
          environment: "node",
          server: inline,
          include: ["test/**/*.server.test.ts"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        define,
        resolve: client,
        test: {
          name: "perf",
          environment: "happy-dom",
          server: inline,
          // Wall-clock budgets run alone, in their own invocation, so parallel correctness tests do not consume their frame.
          include: ["test/**/*.perf.test.ts"],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 30_000,
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        define,
        resolve: client,
        test: {
          name: "gc",
          environment: "node",
          server: inline,
          include: ["test/**/*.gc.test.ts"],
          execArgv: ["--expose-gc"],
          pool: "forks",
        },
      },
    ],
  },
});
