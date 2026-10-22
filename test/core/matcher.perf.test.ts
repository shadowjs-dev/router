import { describe, expect, it } from "vitest";
import { createMatcher, type RouteDefinition } from "../../src/core/matcher";

/**
 * Wall-clock budgets for the matcher at route-table scale. They run under the `perf` project only
 * (`npm run test:perf`), on one worker, so parallel correctness tests do not steal the frame.
 */

const LOOKUPS = 1000;
const LARGE = 10_000;
const SMALL = 1000;
const BUILD_RUNS = 5;
const ATTEMPTS = 3;

/** Half static, half parameterized: index even is `/s<i>/items/list`, odd is `/p<i>/:id/detail`. */
function routesOf(count: number): RouteDefinition[] {
  const routes: RouteDefinition[] = [];
  for (let index = 0; index < count; index += 1) {
    routes.push(
      index % 2 === 0
        ? { id: `static-${index}`, path: `/s${index}/items/list` }
        : { id: `param-${index}`, path: `/p${index}/:id/detail` },
    );
  }
  return routes;
}

/**
 * Distinct pathnames over the table, so every lookup misses the match cache. The index step is
 * coprime with the table size, so no index repeats within one run.
 */
function lookupsFor(count: number): { path: string; id: string }[] {
  const lookups: { path: string; id: string }[] = [];
  for (let step = 0; step < LOOKUPS; step += 1) {
    const index = (step * 37) % count;
    if (index % 2 === 0) {
      lookups.push({ path: `/s${index}/items/list`, id: `static-${index}` });
    } else {
      lookups.push({ path: `/p${index}/v${step}/detail`, id: `param-${index}` });
    }
  }
  return lookups;
}

/** Best (smallest) build time over several runs, after one warm-up build. */
function bestBuildMs(count: number): number {
  const tree = routesOf(count);
  createMatcher(tree);
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < BUILD_RUNS; run += 1) {
    const start = performance.now();
    createMatcher(tree);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/** Runs the check up to ATTEMPTS times; passes on the first success, rethrows the last failure. */
function retried(check: () => void): void {
  let failure: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      check();
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

describe("router matcher at route-table scale", () => {
  it("[MATCH-PERF-1] builds a 1,000-route table and matches every sampled route to its own id", () => {
    const matcher = createMatcher(routesOf(SMALL));
    for (const { path, id } of lookupsFor(SMALL)) {
      expect(matcher.match(path).at(-1)?.id).toBe(id);
    }
  });

  it("[MATCH-PERF-2] builds a 10,000-route table and matches the first, middle and last routes", () => {
    const matcher = createMatcher(routesOf(LARGE));
    expect(matcher.match("/s0/items/list").at(-1)?.id).toBe("static-0");
    expect(matcher.match("/p5001/x/detail").at(-1)?.id).toBe("param-5001");
    expect(matcher.match("/s9998/items/list").at(-1)?.id).toBe("static-9998");
    expect(matcher.match("/p9999/x/detail").at(-1)?.params).toEqual({ id: "x" });
  });

  it("[MATCH-PERF-3] the median match over 1,000 lookups in a 10,000-route table is under 1 ms", () => {
    const lookups = lookupsFor(LARGE);
    retried(() => {
      const matcher = createMatcher(routesOf(LARGE));
      const durations: number[] = [];
      for (const { path } of lookups) {
        const start = performance.now();
        matcher.match(path);
        durations.push(performance.now() - start);
      }
      durations.sort((a, b) => a - b);
      const median = durations[Math.floor(durations.length / 2)] ?? Number.POSITIVE_INFINITY;
      expect(median).toBeLessThan(1);
    });
  });

  it("[MATCH-PERF-4] building 10,000 routes takes under 20x the time of building 1,000", () => {
    retried(() => {
      const small = bestBuildMs(SMALL);
      const large = bestBuildMs(LARGE);
      expect(large / small).toBeLessThan(20);
    });
  });
});
