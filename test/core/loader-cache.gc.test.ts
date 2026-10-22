import { describe, expect, it } from "vitest";
import { createLoaderCache } from "../../src/core/loader-cache";
import { createFakeClock } from "../support/fake-clock";

/** Forces a collection when the runtime exposes one (`--expose-gc`); otherwise a no-op. */
function collect(): void {
  const maybeGc: unknown = Reflect.get(globalThis, "gc");
  if (typeof maybeGc === "function") Reflect.apply(maybeGc, globalThis, []);
}

describe("loader cache under churn", () => {
  it("[I-L5] 100 000 distinct param combinations keep the map at the cap and the heap flat", async () => {
    const clock = createFakeClock(0);
    const cache = createLoaderCache({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      maxEntries: 200,
      staleTime: 1_000_000,
    });
    const heapSamples: number[] = [];
    for (let index = 0; index < 100_000; index += 1) {
      await cache.load({
        routeId: "item",
        params: { a: String(index), b: String(index % 997) },
        intent: "navigate",
        run: () => index,
      });
      expect(cache.size).toBeLessThanOrEqual(200);
      if (index % 20_000 === 19_999) {
        collect();
        heapSamples.push(process.memoryUsage().heapUsed);
      }
    }
    expect(cache.size).toBe(200);
    expect(cache.inFlight).toBe(0);
    expect(clock.pendingTimers).toBe(1);
    const first = heapSamples[0] ?? 0;
    const last = heapSamples[heapSamples.length - 1] ?? 0;
    // Five samples over 100 000 loads: a leak would grow roughly linearly with the load count.
    expect(last - first).toBeLessThan(32 * 1024 * 1024);
    cache.destroy();
    expect(clock.pendingTimers).toBe(0);
  }, 120_000);
});
