import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EnvironmentModuleNode, Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { ModuleParseError } from "./ast";
import { generateRouteTree } from "./generate";
import { type RouteIssue, RouteScanError } from "./issues";
import { type RouteEntry, type ScanCache, type ScanResult, scanRoutes } from "./scan";
import { SERVER_ONLY_ROUTE_EXPORTS, stripServerOnlyExports } from "./server-only";
import { ROUTE_UI_QUERY, splitRouteModule } from "./split";
import { writeIfChanged } from "./write";

/**
 * `shadowRouter()`: the Vite plugin of file routes. It scans the routes directory, writes
 * `routeTree.gen.ts` (only when the text changes), keeps both up to date while the dev server runs,
 * and splits route modules into a data half and a lazily loaded UI half.
 */

/** Options of {@link shadowRouter}. @since 1.0.0 */
export interface ShadowRouterOptions {
  /** Routes directory relative to the Vite root. Default `src/routes`. */
  readonly routesDir?: string;
  /** Generated route tree relative to the Vite root. Default `src/routeTree.gen.ts`. */
  readonly generatedTree?: string;
  /** Static segments compare ASCII case exactly. Default false. */
  readonly caseSensitive?: boolean;
  /** URL prefixes no route may use. Default `["/_dusk"]`. */
  readonly reservedPrefixes?: readonly string[];
  /** Split route modules into data and lazy UI halves in client bundles. Default true. */
  readonly split?: boolean;
}

/** What other plugins (Dusk) read from the router plugin. @since 1.0.0 */
export interface ShadowRouterApi {
  /** Absolute routes directory. */
  readonly routesDir: string;
  /** Absolute path of `routeTree.gen.ts`. */
  readonly generatedFile: string;
  /**
   * The latest successful scan, after any scan in progress finished.
   * @throws RouteScanError when the routes directory currently has problems.
   */
  getScan(): Promise<ScanResult>;
  /** Called after every successful scan, with the scan. Returns an unsubscribe function. */
  onScan(listener: (scan: ScanResult) => void): () => void;
  /**
   * Runs a scan now and tells the listeners (dev: after a file change the plugin did not see).
   * @since 1.0.0
   */
  refresh(): Promise<void>;
  /**
   * Brings the generated tree up to date with the routes directory before a request uses it, and
   * resolves once the tree on disk reflects the files at the time of the call. The listeners are told
   * only when the routes' structure changed (or the watcher reported a change), so a request that finds
   * nothing new invalidates nothing.
   *
   * A file removed a moment ago is still named by the tree until the watcher reports it; a request that
   * loads the tree in that window would fail, so the dev server calls this first.
   * @since 1.0.0
   */
  sync(): Promise<void>;
}

/** The plugin returned by {@link shadowRouter}: a Vite plugin with an `api`. @since 1.0.0 */
export interface ShadowRouterPlugin extends Plugin<ShadowRouterApi> {
  readonly name: "shadowjs:router";
  readonly api: ShadowRouterApi;
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function contains(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function optionError(message: string): Error {
  return new Error(`[ROUTE_OPTION_INVALID] ${message}`);
}

function sha(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/**
 * The file-route plugin.
 *
 * Put it before `shadow()` in the plugin list: the split transform must see the original source,
 * not the compiled JSX.
 *
 * @param options See {@link ShadowRouterOptions}.
 * @returns A Vite plugin; `plugin.api` gives other plugins the scan.
 * @example
 * // vite.config.ts
 * import shadow from "@shadow-js/vite";
 * import { shadowRouter } from "@shadow-js/router/vite";
 * export default { plugins: [shadowRouter(), shadow()] };
 * @since 1.0.0
 */
export function shadowRouter(options: ShadowRouterOptions = {}): ShadowRouterPlugin {
  const splitEnabled = options.split !== false;
  const cache: ScanCache = new Map();
  const listeners = new Set<(scan: ScanResult) => void>();

  let config: ResolvedConfig | undefined;
  /** True while the server starts: the tree the first scan writes is not a change the browser has to reload for. */
  let startingUp = false;
  /**
   * The text of the tree written by the start-up scan, until a route changes. Vite reports the write to the watcher after
   * the server started, and a page that loaded in the meantime would be reloaded for a change it already has.
   */
  let startupTree: string | undefined;
  let routesDir = "";
  let realRoutesDir = "";
  let generatedFile = "";
  let current: ScanResult | undefined;
  let currentError: Error | undefined;
  let running: Promise<void> | undefined;
  let dirty = false;
  /** A run asked to tell the listeners (a watcher event, or `refresh`), until a run takes the request. */
  let notifyPending = false;
  /** The structure of the last scan the listeners were told about (its JSON). */
  let announced: string | undefined;
  /** The message of the problem last reported, so a repeated problem is not logged again on every request. */
  let reportedMessage: string | undefined;
  let server: ViteDevServer | undefined;
  /** Route files by normalized absolute path (real path and given path both). */
  let routeFiles = new Map<string, RouteEntry>();
  /** Hash of each split route's data half, to decide if an edit changes only the UI. */
  const dataHashes = new Map<string, string>();

  const api: ShadowRouterApi = {
    get routesDir(): string {
      return routesDir;
    },
    get generatedFile(): string {
      return generatedFile;
    },
    async getScan(): Promise<ScanResult> {
      if (running !== undefined) await running;
      if (currentError !== undefined) throw currentError;
      if (current === undefined) {
        await schedule(true);
        if (currentError !== undefined) throw currentError;
      }
      if (current === undefined) throw new Error("shadowRouter: no scan available");
      return current;
    },
    onScan(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh(): Promise<void> {
      return schedule(true);
    },
    sync(): Promise<void> {
      return schedule(false);
    },
  };

  function index(scan: ScanResult): void {
    const next = new Map<string, RouteEntry>();
    for (const entry of scan.entries) {
      next.set(toPosix(entry.absolutePath), entry);
      next.set(toPosix(join(realRoutesDir, ...entry.file.split("/"))), entry);
    }
    routeFiles = next;
    for (const key of [...dataHashes.keys()]) if (!next.has(key)) dataHashes.delete(key);
  }

  /** Keeps the last good tree, remembers the problem, and shows it in the overlay and the log. */
  function report(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    // A request runs `sync` before it loads the tree, so the same problem is found again on every request: it is
    // logged and sent to the overlay once, until it changes.
    const repeated = reportedMessage === failure.message;
    currentError = failure;
    reportedMessage = failure.message;
    if (repeated) return;
    server?.environments.client.hot.send({
      type: "error",
      err: { message: failure.message, stack: "", plugin: "shadowjs:router" },
    });
    config?.logger.error(failure.message, { timestamp: true });
  }

  /**
   * One scan of the routes directory and the write of the tree. The tree is written atomically before the listeners
   * run, so a listener (the dev server) that invalidates the modules that import the tree always finds the new file.
   * `notify` asks for the listeners even when the structure is the same (a content edit the watcher reported).
   */
  async function regenerate(notify: boolean): Promise<void> {
    try {
      const scan = await scanRoutes({
        routesDir,
        cache,
        allowMissing: true,
        ...(options.caseSensitive === undefined ? {} : { caseSensitive: options.caseSensitive }),
        ...(options.reservedPrefixes === undefined
          ? {}
          : { reservedPrefixes: options.reservedPrefixes }),
      });
      const hadError = currentError !== undefined;
      currentError = undefined;
      reportedMessage = undefined;
      const structure = JSON.stringify(scan);
      const changed = structure !== announced;
      if (changed) {
        current = scan;
        index(scan);
        announced = structure;
      }
      const tree = generateRouteTree(scan, { generatedFile });
      const written = await writeIfChanged(generatedFile, tree);
      if (written) startupTree = startingUp ? tree : undefined;
      // A fixed error leaves no HMR trace when the tree is byte-identical: clear the overlay with an update that changes no
      // module. A full reload here would be a second reload for the same save (the one the broken save caused is still
      // loading), and the second one aborts the page load of the first.
      if (hadError && !written)
        server?.environments.client.hot.send({ type: "update", updates: [] });
      if (changed || notify) for (const listener of [...listeners]) listener(scan);
    } catch (error) {
      report(error);
    }
  }

  /**
   * Runs scans until no request is pending. Every caller gets a promise that resolves after a run that started after
   * its call, so a request never waits for a scan older than itself (and never sees a tree being written).
   */
  function schedule(notify: boolean): Promise<void> {
    dirty = true;
    notifyPending = notifyPending || notify;
    if (running === undefined) {
      running = (async () => {
        try {
          while (dirty) {
            dirty = false;
            const tell = notifyPending;
            notifyPending = false;
            await regenerate(tell);
          }
        } finally {
          running = undefined;
        }
      })();
    }
    return running;
  }

  function entryOf(id: string): RouteEntry | undefined {
    const clean = toPosix(id.split("?")[0] ?? id);
    return routeFiles.get(clean);
  }

  function isUiRequest(id: string): boolean {
    const query = id.split("?")[1];
    return query === undefined ? false : query.split("&").includes(ROUTE_UI_QUERY);
  }

  const plugin: ShadowRouterPlugin = {
    name: "shadowjs:router",
    enforce: "pre",
    api,
    sharedDuringBuild: true,
    configResolved(resolved) {
      config = resolved;
      const root = resolved.root;
      routesDir = resolve(root, options.routesDir ?? "src/routes");
      generatedFile = resolve(root, options.generatedTree ?? "src/routeTree.gen.ts");
      if (!contains(root, routesDir)) {
        throw optionError(`routesDir "${routesDir}" must be inside the project root "${root}"`);
      }
      if (!contains(root, generatedFile)) {
        throw optionError(
          `generatedTree "${generatedFile}" must be inside the project root "${root}"`,
        );
      }
      if (contains(routesDir, generatedFile)) {
        throw optionError("generatedTree must not be inside routesDir");
      }
      try {
        realRoutesDir = realpathSync(routesDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        realRoutesDir = routesDir;
      }
    },
    async buildStart() {
      if (config?.command !== "build") return;
      await schedule(true);
      if (currentError !== undefined) this.error(currentError.message);
    },
    async configureServer(devServer) {
      server = devServer;
      startingUp = true;
      try {
        await schedule(true);
      } finally {
        startingUp = false;
      }
      const watcher = devServer.watcher;
      watcher.add(routesDir);
      const onEvent = (file: string): void => {
        const path = toPosix(file);
        if (path === toPosix(generatedFile)) return;
        const inside = contains(toPosix(routesDir), path) || contains(toPosix(realRoutesDir), path);
        if (!inside) return;
        // `startupTree` is not cleared here: a late report of a file the start-up scan already read changes nothing, and a
        // scan that does change the tree clears it when it writes (see `schedule`).
        void schedule(true);
      };
      for (const event of ["add", "unlink", "addDir", "unlinkDir", "change"] as const) {
        watcher.on(event, onEvent);
      }
      devServer.httpServer?.once("close", () => {
        for (const event of ["add", "unlink", "addDir", "unlinkDir", "change"] as const) {
          watcher.off(event, onEvent);
        }
      });
    },
    transform(code, id, transformOptions) {
      const entry = entryOf(id);
      if (entry === undefined) return null;
      const serverSide =
        this.environment?.config.consumer === "server" || transformOptions?.ssr === true;
      if (serverSide) return null;
      const file = id.split("?")[0] ?? id;
      // Server-only exports (a route's `middleware`) leave the browser copy before anything else.
      const stripped = stripServerOnlyExports(code, file, SERVER_ONLY_ROUTE_EXPORTS);
      const source = stripped === undefined ? code : stripped.code;
      const unchanged = stripped === undefined ? null : { code: stripped.code, map: stripped.map };
      if (!splitEnabled) return unchanged;
      const uiRequest = isUiRequest(id);
      const result = splitRouteModule(source, file, `./${basename(file)}?${ROUTE_UI_QUERY}`);
      if (!result.split) {
        if (!uiRequest && result.reason !== "no-ui") {
          this.warn(
            `route "${entry.id}" (${entry.file}) is not code-split: ${describeNoSplit(result.reason, result.detail)}`,
          );
        }
        return unchanged;
      }
      const half = uiRequest ? result.ui : result.main;
      if (!uiRequest) dataHashes.set(toPosix(file), sha(result.main.code));
      return { code: half.code, map: half.map };
    },
    hotUpdate: {
      order: "pre",
      async handler(context) {
        if (
          startupTree !== undefined &&
          context.type !== "delete" &&
          toPosix(context.file) === toPosix(generatedFile) &&
          (await context.read()) === startupTree
        ) {
          // The start-up scan's own write, seen late by the watcher: the page has that tree already (see `startupTree`).
          return [];
        }
        if (this.environment.config.consumer === "client" && context.type !== "update") {
          const path = toPosix(context.file);
          if (contains(toPosix(routesDir), path) || contains(toPosix(realRoutesDir), path)) {
            // A route file added or removed. Vite would reload the page for the file itself (a route module is a dead
            // end), and that reload could load the tree before it names the change. The tree is written first, and the
            // page is reloaded once, by the tree's own change: this file's change is answered here.
            const wasRoute = entryOf(context.file) !== undefined;
            await schedule(true);
            return wasRoute || entryOf(context.file) !== undefined ? [] : undefined;
          }
        }
        if (!splitEnabled || this.environment.config.consumer !== "client") return;
        const entry = entryOf(context.file);
        if (entry === undefined || context.type !== "update") return;
        const current = await context.read();
        const file = toPosix(context.file);
        let result: ReturnType<typeof splitRouteModule>;
        try {
          // The same text the transform hands to the split: server-only exports are not in it.
          const stripped = stripServerOnlyExports(current, context.file, SERVER_ONLY_ROUTE_EXPORTS);
          result = splitRouteModule(
            stripped === undefined ? current : stripped.code,
            context.file,
            `./${basename(context.file)}?${ROUTE_UI_QUERY}`,
          );
        } catch (error) {
          // A file with a syntax error: Vite's normal update runs, and the transform reports the
          // error with its code frame when the module is requested.
          if (error instanceof ModuleParseError) return;
          throw error;
        }
        if (!result.split) return;
        const previous = dataHashes.get(file);
        const next = sha(result.main.code);
        dataHashes.set(file, next);
        if (previous !== next) return;
        // Only the UI half changed: update just that module, so the component hot-swaps and
        // the route's data half (and the router importing it) is left alone.
        const ui = context.modules.filter((module: EnvironmentModuleNode) =>
          isUiRequest(module.id ?? module.url),
        );
        return ui;
      },
    },
  };
  return plugin;
}

function describeNoSplit(reason: string, detail: readonly string[]): string {
  switch (reason) {
    case "shared-declaration":
      return `${detail.join(", ")} ${detail.length === 1 ? "is" : "are"} used by both the component and the loader side; move ${
        detail.length === 1 ? "it" : "them"
      } to its own module to enable splitting`;
    case "side-effects":
      return "the module has top-level statements with side effects";
    case "star-export":
      return "the module has `export *`";
    case "mixed-export":
      return `one export statement defines both UI and data exports (${detail.join(", ")})`;
    default:
      return reason;
  }
}

/**
 * Formats scanner issues for a Vite error. Re-exported for tools that print them.
 *
 * @example describeIssues(scanError.issues);
 * @since 1.0.0
 */
export function describeIssues(issues: readonly RouteIssue[]): string {
  return new RouteScanError(issues).message;
}
