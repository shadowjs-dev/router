import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SieveCache } from "../../src/core/sieve";

const PROPS = { seed: 5, numRuns: 300 } as const;

describe("SieveCache", () => {
  it("[I-L5] never holds more entries than its capacity", () => {
    const cache = new SieveCache<number, number>(50);
    for (let key = 0; key < 5000; key += 1) {
      cache.set(key, key);
      expect(cache.size).toBeLessThanOrEqual(50);
    }
    expect(cache.size).toBe(50);
  });

  it("evicts an unvisited entry and keeps a visited one (SIEVE example)", () => {
    const cache = new SieveCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1);
    cache.set("d", 4);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.has("d")).toBe(true);
  });

  it("scan resistance: a key read between every insertion survives a long scan", () => {
    const cache = new SieveCache<string, number>(20);
    cache.set("hot", 0);
    for (let key = 0; key < 1000; key += 1) {
      expect(cache.get("hot")).toBe(0);
      cache.set(`cold-${key}`, key);
    }
    expect(cache.get("hot")).toBe(0);
    expect(cache.size).toBe(20);
  });

  it("overwriting an existing key updates the value without growing the cache", () => {
    const cache = new SieveCache<string, number>(2);
    cache.set("x", 1);
    cache.set("x", 2);
    expect(cache.size).toBe(1);
    expect(cache.get("x")).toBe(2);
  });

  it("delete removes the entry, including when the hand points at it", () => {
    const cache = new SieveCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4);
    expect(cache.delete("b")).toBe(true);
    expect(cache.delete("b")).toBe(false);
    cache.set("e", 5);
    cache.set("f", 6);
    expect(cache.size).toBe(3);
    expect(cache.get("f")).toBe(6);
  });

  it("calls onEvict with the evicted key and value", () => {
    const evicted: string[] = [];
    const cache = new SieveCache<string, number>(1, (key, value) => {
      evicted.push(`${key}=${value}`);
    });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(evicted).toEqual(["a=1"]);
  });

  it("clear empties the cache without calling onEvict", () => {
    const evicted: string[] = [];
    const cache = new SieveCache<string, number>(4, (key) => {
      evicted.push(key);
    });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(evicted).toEqual([]);
    cache.set("c", 3);
    expect(cache.get("c")).toBe(3);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new SieveCache<string, number>(0)).toThrow(RangeError);
    expect(() => new SieveCache<string, number>(-1)).toThrow(RangeError);
  });

  it("[I-L5] matches a reference model: size bounded and every present key holds its last value", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            op: fc.constantFrom("set", "get", "delete"),
            key: fc.integer({ min: 0, max: 15 }),
            value: fc.integer(),
          }),
          { maxLength: 200 },
        ),
        (operations) => {
          const cache = new SieveCache<number, number>(8);
          const model = new Map<number, number>();
          for (const operation of operations) {
            if (operation.op === "set") {
              cache.set(operation.key, operation.value);
              model.set(operation.key, operation.value);
            } else if (operation.op === "get") {
              const hit = cache.get(operation.key);
              if (hit !== undefined) expect(hit).toBe(model.get(operation.key));
            } else {
              cache.delete(operation.key);
              model.delete(operation.key);
            }
            expect(cache.size).toBeLessThanOrEqual(8);
          }
          for (const key of model.keys()) {
            if (cache.has(key)) expect(cache.get(key)).toBe(model.get(key));
          }
        },
      ),
      PROPS,
    );
  });
});
