import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalKey } from "../../src/core/canonical";
import { createLoaderCache, type LoaderCache, type LoadRequest } from "../../src/core/loader-cache";
import { createFakeClock, type FakeClock } from "../support/fake-clock";

const PROPS = { seed: 5, numRuns: 300 } as const;

/** Lets pending promise callbacks run. Enough ticks for the cache's short promise chains. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 30; tick += 1) await Promise.resolve();
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function expectAbort(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe("AbortError");
}

function harness(overrides: Partial<Parameters<typeof createLoaderCache>[0]> = {}): {
  cache: LoaderCache;
  clock: FakeClock;
} {
  const clock = createFakeClock(0);
  const cache = createLoaderCache({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...overrides,
  });
  return { cache, clock };
}

function request<T>(
  run: (signal: AbortSignal) => Promise<T> | T,
  overrides: Partial<LoadRequest<T>> = {},
): LoadRequest<T> {
  return {
    routeId: "post",
    params: { id: "1" },
    intent: "navigate",
    run,
    ...overrides,
  };
}

describe("canonicalKey", () => {
  it("[I-L3] object key order does not change the key", () => {
    expect(canonicalKey({ b: 1, a: [true] })).toBe(canonicalKey({ a: [true], b: 1 }));
  });

  it("[I-L3] array order matters, and quoting stops separators inside strings from colliding", () => {
    expect(canonicalKey([1, 2])).not.toBe(canonicalKey([2, 1]));
    expect(canonicalKey(["a,b"])).not.toBe(canonicalKey(["a", "b"]));
    expect(canonicalKey(['x"y'])).not.toBe(canonicalKey(["x", "y"]));
  });

  it("null, undefined, and the strings that look like them are all distinct", () => {
    const keys = [
      canonicalKey(null),
      canonicalKey(undefined),
      canonicalKey("null"),
      canonicalKey("undefined"),
    ];
    expect(new Set(keys).size).toBe(4);
  });

  it("0 and -0 are the same key, NaN is stable", () => {
    expect(canonicalKey(0)).toBe(canonicalKey(-0));
    expect(canonicalKey(Number.NaN)).toBe(canonicalKey(Number.NaN));
  });

  it.each([
    ["a Map", new Map([["k", 1]])],
    ["a Set", new Set([1])],
    ["a Date", new Date(0)],
    ["a class instance", new (class Thing {})()],
    ["a RegExp", /x/],
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["a BigInt", BigInt(1)],
  ])("[I-L3] rejects %s with TypeError instead of colliding", (_label, value) => {
    expect(() => canonicalKey(value)).toThrow(TypeError);
  });

  it("[I-L3] rejects a non-plain value nested inside a plain one", () => {
    expect(() => canonicalKey({ ok: { inner: new Map() } })).toThrow(TypeError);
    expect(() => canonicalKey([1, [2, BigInt(3)]])).toThrow(TypeError);
  });

  it("[I-L3] rejects cycles", () => {
    const loop: Record<string, unknown> = {};
    loop["self"] = loop;
    expect(() => canonicalKey(loop)).toThrow(TypeError);
    const list: unknown[] = [];
    list.push(list);
    expect(() => canonicalKey(list)).toThrow(TypeError);
  });

  it("accepts objects with a null prototype", () => {
    const bare: Record<string, unknown> = Object.create(null);
    bare["x"] = 1;
    expect(canonicalKey(bare)).toBe(canonicalKey({ x: 1 }));
  });

  it("serializes very deep nesting without exhausting the call stack", () => {
    let deep: unknown = 1;
    for (let level = 0; level < 50_000; level += 1) deep = [deep];
    expect(canonicalKey(deep).length).toBeGreaterThan(50_000);
  });

  it("[I-L3] equal JSON data gives equal keys regardless of construction order (property)", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const copy = JSON.parse(JSON.stringify(value)) as unknown;
        expect(canonicalKey(copy)).toBe(canonicalKey(value));
      }),
      PROPS,
    );
  });
});

describe("loader cache: keys", () => {
  it("the key includes the route id, the params and the deps", async () => {
    const { cache } = harness();
    let calls = 0;
    const run = (): number => {
      calls += 1;
      return calls;
    };
    await cache.load(request(run, { params: { id: "1" } }));
    await cache.load(request(run, { params: { id: "2" } }));
    await cache.load(request(run, { routeId: "other" }));
    await cache.load(request(run, { deps: { page: 2 } }));
    expect(calls).toBe(4);
    expect(cache.size).toBe(4);
  });

  it("params given in a different key order are the same key", async () => {
    const { cache } = harness({ staleTime: 1000 });
    let calls = 0;
    await cache.load(request(() => ++calls, { params: { a: "1", b: "2" } }));
    await cache.load(request(() => ++calls, { params: { b: "2", a: "1" } }));
    expect(calls).toBe(1);
  });

  it("[I-L3] a non-plain deps value rejects the load instead of colliding", async () => {
    const { cache } = harness();
    await expect(cache.load(request(() => 1, { deps: new Map() }))).rejects.toThrow(TypeError);
  });
});

describe("loader cache: freshness", () => {
  it("a fresh entry is returned without running the loader", async () => {
    const { cache } = harness({ staleTime: 1000 });
    let calls = 0;
    await cache.load(request(() => ++calls));
    expect(await cache.load(request(() => ++calls))).toBe(1);
    expect(calls).toBe(1);
  });

  it("[I-L7] staleTime 0 returns the stale value at once and refreshes in the background", async () => {
    const { cache } = harness();
    let calls = 0;
    expect(await cache.load(request(() => ++calls))).toBe(1);
    expect(await cache.load(request(() => ++calls))).toBe(1);
    await settle();
    expect(calls).toBe(2);
    expect(await cache.load(request(() => ++calls))).toBe(2);
  });

  it("[I-L7] staleReload blocking waits for the fresh value", async () => {
    const { cache } = harness();
    let calls = 0;
    await cache.load(request(() => ++calls));
    expect(await cache.load(request(() => ++calls, { staleReload: "blocking" }))).toBe(2);
    expect(calls).toBe(2);
  });

  it("a background refresh that fails keeps the old value and reports the error", async () => {
    const errors: { error: unknown; routeId: string }[] = [];
    const { cache } = harness({
      onError: (error, routeId) => {
        errors.push({ error, routeId });
      },
    });
    await cache.load(request(() => "first"));
    expect(await cache.load(request(() => Promise.reject(new Error("down"))))).toBe("first");
    await settle();
    expect(errors.map((item) => [item.routeId, (item.error as Error).message])).toEqual([
      ["post", "down"],
    ]);
    expect(cache.peek("post", { id: "1" })?.value).toBe("first");
  });

  it("[I-L1] preload uses preloadStaleTime: fresh within the window, refetched after it", async () => {
    const { cache, clock } = harness({ preloadStaleTime: 30_000 });
    let calls = 0;
    await cache.load(request(() => ++calls));
    clock.advance(29_999);
    expect(await cache.load(request(() => ++calls, { intent: "preload" }))).toBe(1);
    expect(calls).toBe(1);
    clock.advance(1);
    expect(await cache.load(request(() => ++calls, { intent: "preload" }))).toBe(2);
    expect(calls).toBe(2);
  });

  it("hydrate treats a seeded entry as fresh even when it is stale by age", async () => {
    const { cache } = harness();
    cache.seed({ routeId: "post", params: { id: "1" }, value: "server", updatedAt: 0 });
    let calls = 0;
    expect(await cache.load(request(() => ++calls, { intent: "hydrate" }))).toBe("server");
    expect(calls).toBe(0);
  });

  it("[I-L10] after hydration, a navigation uses the stale rules and refreshes in the background", async () => {
    const { cache } = harness();
    cache.seed({ routeId: "post", params: { id: "1" }, value: "server", updatedAt: 0 });
    let calls = 0;
    expect(await cache.load(request(() => ++calls, { intent: "hydrate" }))).toBe("server");
    expect(await cache.load(request(() => ++calls))).toBe("server");
    await settle();
    expect(calls).toBe(1);
    expect(cache.peek("post", { id: "1" })?.value).toBe(1);
  });

  it("reload always runs the loader", async () => {
    const { cache } = harness({ staleTime: 1_000_000 });
    let calls = 0;
    await cache.load(request(() => ++calls));
    expect(await cache.load(request(() => ++calls, { intent: "reload" }))).toBe(2);
  });

  it("[I-L5] an error is not cached: the next load runs the loader again", async () => {
    const { cache } = harness();
    let calls = 0;
    await expect(
      cache.load(
        request(() => {
          calls += 1;
          throw new Error("first");
        }),
      ),
    ).rejects.toThrow("first");
    expect(await cache.load(request(() => ++calls))).toBe(2);
  });

  it("peek reports the stale flag from staleTime", async () => {
    const { cache, clock } = harness({ staleTime: 100 });
    await cache.load(request(() => "v"));
    expect(cache.peek("post", { id: "1" })?.stale).toBe(false);
    clock.advance(100);
    expect(cache.peek("post", { id: "1" })?.stale).toBe(true);
  });

  it("peek does not change recency", async () => {
    const { cache } = harness({ maxEntries: 2 });
    await cache.load(request(() => "a", { params: { id: "a" } }));
    await cache.load(request(() => "b", { params: { id: "b" } }));
    cache.peek("post", { id: "a" });
    await cache.load(request(() => "c", { params: { id: "c" } }));
    expect(cache.peek("post", { id: "a" })).toBeUndefined();
    expect(cache.peek("post", { id: "b" })).toBeDefined();
  });
});

describe("loader cache: in-flight sharing and reference counting", () => {
  it("two loads of the same key share one loader call", async () => {
    const { cache } = harness();
    const gate = deferred<number>();
    let calls = 0;
    const run = (): Promise<number> => {
      calls += 1;
      return gate.promise;
    };
    const first = cache.load(request(run));
    const second = cache.load(request(run));
    expect(cache.inFlight).toBe(1);
    gate.resolve(9);
    expect(await first).toBe(9);
    expect(await second).toBe(9);
    expect(calls).toBe(1);
    expect(cache.inFlight).toBe(0);
  });

  it("[I-N5] aborting a preload does not abort a navigation that shares its flight", async () => {
    const { cache } = harness();
    const gate = deferred<string>();
    let seen: AbortSignal | undefined;
    const run = (signal: AbortSignal): Promise<string> => {
      seen = signal;
      return gate.promise;
    };
    const preload = new AbortController();
    const navigation = new AbortController();
    const preloading = cache.load(request(run, { intent: "preload", signal: preload.signal }));
    const navigating = cache.load(request(run, { signal: navigation.signal }));
    preload.abort();
    await expect(preloading).rejects.toThrow();
    expect(seen?.aborted).toBe(false);
    gate.resolve("data");
    expect(await navigating).toBe("data");
  });

  it("[I-N5] the flight aborts only when its last consumer has left", async () => {
    const { cache } = harness();
    const gate = deferred<string>();
    let seen: AbortSignal | undefined;
    const run = (signal: AbortSignal): Promise<string> => {
      seen = signal;
      return gate.promise;
    };
    const first = new AbortController();
    const second = new AbortController();
    const a = cache.load(request(run, { signal: first.signal }));
    const b = cache.load(request(run, { signal: second.signal }));
    await settle();
    expect(seen?.aborted).toBe(false);
    first.abort();
    second.abort();
    expect(seen?.aborted).toBe(true);
    await a.then(
      () => {
        throw new Error("a should not resolve");
      },
      (error: unknown) => expectAbort(error),
    );
    await b.then(
      () => {
        throw new Error("b should not resolve");
      },
      (error: unknown) => expectAbort(error),
    );
    expect(cache.inFlight).toBe(0);
  });

  it("[I-N5] a consumer that starts after the others left begins a fresh flight", async () => {
    const { cache } = harness();
    let calls = 0;
    const controller = new AbortController();
    const first = cache.load(
      request(
        () => {
          calls += 1;
          return new Promise<number>(() => undefined);
        },
        { signal: controller.signal },
      ),
    );
    controller.abort();
    await first.catch((error: unknown) => expectAbort(error));
    expect(await cache.load(request(() => ++calls))).toBe(1);
    expect(calls).toBe(1);
  });

  it("an aborted flight never starts its loader", async () => {
    const { cache } = harness();
    const controller = new AbortController();
    let calls = 0;
    const pending = cache.load(request(() => ++calls, { signal: controller.signal }));
    controller.abort();
    await pending.catch((error: unknown) => expectAbort(error));
    await settle();
    expect(calls).toBe(0);
  });

  it("a pre-aborted signal rejects without starting the loader", async () => {
    const { cache } = harness();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await cache
      .load(request(() => ++calls, { signal: controller.signal }))
      .catch((error: unknown) => {
        expectAbort(error);
      });
    expect(calls).toBe(0);
  });

  it("[I-L2] the loader receives an AbortSignal", async () => {
    const { cache } = harness();
    let seen: unknown;
    await cache.load(
      request((signal) => {
        seen = signal;
        return 1;
      }),
    );
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it("the flight can be capped: beyond maxEntries flights still run but are not shared", async () => {
    const { cache } = harness({ maxEntries: 2 });
    const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
    const loads = gates.map((gate, index) =>
      cache.load(request(() => gate.promise, { params: { id: String(index) } })),
    );
    expect(cache.inFlight).toBe(2);
    for (const [index, gate] of gates.entries()) gate.resolve(index);
    expect(await Promise.all(loads)).toEqual([0, 1, 2]);
  });
});

describe("loader cache: clearing and invalidation", () => {
  it("[I-L6] clearAll aborts in-flight loads, even if the loader ignores its signal", async () => {
    const { cache } = harness();
    const gate = deferred<string>();
    let seen: AbortSignal | undefined;
    const pending = cache.load(
      request((signal) => {
        seen = signal;
        return gate.promise;
      }),
    );
    await settle();
    cache.clearAll();
    expect(seen?.aborted).toBe(true);
    gate.resolve("late");
    await pending.then(
      () => {
        throw new Error("a cleared load must not resolve");
      },
      (error: unknown) => expectAbort(error),
    );
    expect(cache.peek("post", { id: "1" })).toBeUndefined();
    expect(cache.inFlight).toBe(0);
  });

  it("[I-L6] clearAll empties the cache: the next load runs the loader again", async () => {
    const { cache } = harness({ staleTime: 1_000_000 });
    let calls = 0;
    await cache.load(request(() => ++calls));
    cache.clearAll();
    expect(cache.size).toBe(0);
    expect(await cache.load(request(() => ++calls))).toBe(2);
  });

  it("[I-L4] invalidate by routeId is an exact match, not a prefix", async () => {
    const { cache } = harness({ staleTime: 1_000_000 });
    await cache.load(request(() => "p", { routeId: "post" }));
    await cache.load(request(() => "l", { routeId: "post-list" }));
    cache.invalidate({ routeId: "post" });
    expect(cache.peek("post", { id: "1" })?.stale).toBe(true);
    expect(cache.peek("post-list", { id: "1" })?.stale).toBe(false);
  });

  it("[I-L4] invalidate by params matches the whole params object exactly", async () => {
    const { cache } = harness({ staleTime: 1_000_000 });
    await cache.load(request(() => "1", { params: { id: "2" } }));
    await cache.load(request(() => "2", { params: { id: "20" } }));
    cache.invalidate({ params: { id: "2" } });
    expect(cache.peek("post", { id: "2" })?.stale).toBe(true);
    expect(cache.peek("post", { id: "20" })?.stale).toBe(false);
  });

  it("[I-L4] invalidate by tag is an exact string match", async () => {
    const { cache } = harness({ staleTime: 1_000_000 });
    await cache.load(request(() => "u", { routeId: "users", tags: ["users"] }));
    await cache.load(request(() => "a", { routeId: "admins", tags: ["users:admin"] }));
    cache.invalidate({ tag: "users" });
    expect(cache.peek("users", { id: "1" })?.stale).toBe(true);
    expect(cache.peek("admins", { id: "1" })?.stale).toBe(false);
  });

  it("filters combine: every given field must match", async () => {
    const { cache } = harness({ staleTime: 1_000_000 });
    await cache.load(request(() => "a", { tags: ["t"] }));
    await cache.load(request(() => "b", { routeId: "other", tags: ["t"] }));
    cache.invalidate({ routeId: "post", tag: "t" });
    expect(cache.peek("post", { id: "1" })?.stale).toBe(true);
    expect(cache.peek("other", { id: "1" })?.stale).toBe(false);
  });

  it("an empty filter invalidates everything", async () => {
    const { cache } = harness({ staleTime: 1_000_000 });
    await cache.load(request(() => "a"));
    cache.invalidate({});
    expect(cache.peek("post", { id: "1" })?.stale).toBe(true);
  });

  it("invalidated data is still served while it refreshes in the background", async () => {
    const { cache } = harness({ staleTime: 1_000_000 });
    let calls = 0;
    await cache.load(request(() => ++calls));
    cache.invalidate({ routeId: "post" });
    expect(await cache.load(request(() => ++calls))).toBe(1);
    await settle();
    expect(await cache.load(request(() => ++calls))).toBe(2);
  });

  it("a load that started before invalidation still stores its result", async () => {
    const { cache } = harness({ staleTime: 1_000_000 });
    const gate = deferred<string>();
    const pending = cache.load(request(() => gate.promise));
    cache.invalidate({});
    gate.resolve("fresh");
    expect(await pending).toBe("fresh");
    expect(cache.peek("post", { id: "1" })?.value).toBe("fresh");
  });
});

describe("loader cache: bounds, GC and lifecycle", () => {
  it("[I-L5] never holds more entries than maxEntries", async () => {
    const { cache } = harness({ maxEntries: 200 });
    for (let index = 0; index < 500; index += 1) {
      await cache.load(request(() => index, { params: { id: String(index) } }));
      expect(cache.size).toBeLessThanOrEqual(200);
    }
    expect(cache.size).toBe(200);
  });

  it("[I-L5] eviction keeps an entry that was read since it was stored (SIEVE)", async () => {
    const { cache } = harness({ maxEntries: 2, staleTime: 1_000_000 });
    await cache.load(request(() => "a", { params: { id: "a" } }));
    await cache.load(request(() => "b", { params: { id: "b" } }));
    await cache.load(request(() => "a", { params: { id: "a" } }));
    await cache.load(request(() => "c", { params: { id: "c" } }));
    expect(cache.peek("post", { id: "a" })).toBeDefined();
    expect(cache.peek("post", { id: "b" })).toBeUndefined();
    expect(cache.peek("post", { id: "c" })).toBeDefined();
  });

  it("[I-L5] an entry unused for gcTime is removed by the sweep", async () => {
    const { cache, clock } = harness({ gcTime: 1000, staleTime: 1_000_000 });
    await cache.load(request(() => "v"));
    expect(cache.size).toBe(1);
    clock.advance(1000);
    expect(cache.size).toBe(0);
  });

  it("[I-L5] reading an entry postpones its removal", async () => {
    const { cache, clock } = harness({ gcTime: 1000, staleTime: 1_000_000 });
    await cache.load(request(() => "v"));
    clock.advance(500);
    await cache.load(request(() => "x"));
    clock.advance(600);
    expect(cache.size).toBe(1);
    clock.advance(1000);
    expect(cache.size).toBe(0);
  });

  it("[I-L5] the GC uses a single timer however many entries exist", async () => {
    const { cache, clock } = harness({ maxEntries: 200, staleTime: 1_000_000 });
    for (let index = 0; index < 150; index += 1) {
      await cache.load(request(() => index, { params: { id: String(index) } }));
    }
    expect(clock.pendingTimers).toBe(1);
  });

  it("[I-L5] destroy clears the GC timer and rejects further loads", async () => {
    const { cache, clock } = harness({ staleTime: 1_000_000 });
    await cache.load(request(() => "v"));
    expect(clock.pendingTimers).toBe(1);
    cache.destroy();
    expect(clock.pendingTimers).toBe(0);
    await expect(cache.load(request(() => "again"))).rejects.toThrow();
    cache.destroy();
  });

  it("seed stores data that a later hydrate load returns", () => {
    const { cache } = harness();
    cache.seed({
      routeId: "post",
      params: { id: "9" },
      value: { title: "t" },
      tags: ["p"],
      updatedAt: 0,
    });
    expect(cache.peek("post", { id: "9" })).toEqual({
      value: { title: "t" },
      updatedAt: 0,
      stale: true,
    });
  });

  it("seed without updatedAt stamps the current time", () => {
    const { cache, clock } = harness();
    clock.advance(42);
    cache.seed({ routeId: "post", params: { id: "9" }, value: 1 });
    expect(cache.peek("post", { id: "9" })?.updatedAt).toBe(42);
  });

  it("[I-L11] a stored value is returned by identity, not copied", async () => {
    const { cache } = harness({ staleTime: 1_000_000 });
    const value = { title: "t" };
    await cache.load(request(() => value));
    expect(await cache.load(request(() => ({ title: "other" })))).toBe(value);
  });
});
