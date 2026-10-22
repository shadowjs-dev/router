import { type LoaderCache, parseSearch } from "../core/index";
import { createLoaderCache } from "../core/loader-cache";
import type { DehydrateContext, HydrationCapability } from "../internal/capabilities";
import { failureOf, failureValueOf, LoaderFailure } from "../internal/failure";
import { depsFor } from "../internal/route-tree";
import type { HydrationMatch, RouterCacheOptions, RouterFeature, RouteSpec } from "../types";

/**
 * The `loaders` feature: the loader cache. It holds loader data by route, params and deps; shares
 * in-flight loads; serves stale data while it refreshes; and makes `preload`, `invalidate`,
 * `dehydrate` and `hydrate` act on the data. A route with a `loader` needs it.
 *
 * @param options Cache limits: `maxEntries` (200), `staleTime` (0: a navigation refetches),
 *   `preloadStaleTime` (30 000 ms), `gcTime` (300 000 ms).
 * @returns The feature.
 * @example
 * import { loaderCache } from the "@shadow-js/router/loaders" subpath;
 * const router = createRouter({ routes, features: [loaderCache({ staleTime: 20_000 })] });
 * @since 1.0.0
 */
export function loaderCache(options: RouterCacheOptions = {}): RouterFeature {
  return {
    id: "loaders",
    install(host): void {
      const cache = createLoaderCache({
        now: host.clock.now,
        setTimeout: host.clock.setTimeout,
        clearTimeout: host.clock.clearTimeout,
        maxEntries: options.maxEntries ?? 200,
        staleTime: options.staleTime ?? 0,
        preloadStaleTime: options.preloadStaleTime ?? 30_000,
        gcTime: options.gcTime ?? 300_000,
        onError: (error: unknown) => host.report(error),
      });
      host.capabilities.loaders = cache;
      const hydration: HydrationCapability = {
        dehydrate: (context) => dehydrateLoaders(cache, context),
        seed: (matches, specs) => seedLoaders(cache, matches, specs),
      };
      host.capabilities.hydration = hydration;
      host.onDispose(() => {
        cache.destroy();
      });
    },
  };
}

/** The loader results of the matched routes, as the cache holds them now (a route with no cached result is left out). */
function dehydrateLoaders(cache: LoaderCache, context: DehydrateContext): HydrationMatch[] {
  const matches: HydrationMatch[] = [];
  for (const match of context.matches) {
    const spec = context.specs.get(match.id);
    if (spec?.loader === undefined) continue;
    const deps = depsFor(
      spec,
      parseSearch(context.search, { maxLength: context.maxSearchLength }),
      context.run,
    );
    const entry = cache.peek(match.id, match.params, deps);
    if (entry === undefined) continue;
    const failed = entry.value instanceof LoaderFailure;
    const value: unknown =
      entry.value instanceof LoaderFailure ? failureValueOf(entry.value.error) : entry.value;
    matches.push({
      id: match.id,
      params: match.params,
      deps,
      updatedAt: entry.updatedAt,
      value,
      failed,
    });
  }
  return matches;
}

/** Seeds the cache with the hydrated results of the routes that have a loader; other routes are skipped. */
function seedLoaders(
  cache: LoaderCache,
  matches: readonly HydrationMatch[],
  specs: ReadonlyMap<string, RouteSpec>,
): void {
  for (const match of matches) {
    const spec = specs.get(match.id);
    if (spec?.loader === undefined) continue;
    if (typeof match.updatedAt !== "number") {
      throw new TypeError(
        __DEV__ ? `hydrate(): "${match.id}" has no updatedAt` : "SHADOW_HYDRATION_UPDATED",
      );
    }
    const value: unknown = match.failed ? new LoaderFailure(failureOf(match.value)) : match.value;
    cache.seed({
      routeId: match.id,
      params: match.params,
      deps: match.deps,
      tags: spec.tags ?? [],
      value,
      updatedAt: match.updatedAt,
    });
  }
}
