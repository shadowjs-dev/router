import { describe, expect, it } from "vitest";
import { sameData } from "../../src/internal/equal";

describe("sameData (plain data compares by content)", () => {
  it("[EQ-1] equal plain data is equal, and different data is not", () => {
    expect(sameData({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(true);
    expect(sameData({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameData({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameData([1, 2], [2, 1])).toBe(false);
    expect(sameData(Number.NaN, Number.NaN)).toBe(true);
    expect(sameData({ n: 0 }, { n: -0 })).toBe(true);
  });

  it("[EQ-2] values that are not plain data compare by identity only", () => {
    class Point {
      readonly x: number;
      constructor(x: number) {
        this.x = x;
      }
    }
    expect(sameData(new Point(1), new Point(1))).toBe(false);
    const point = new Point(1);
    expect(sameData(point, point)).toBe(true);
  });

  it("[EQ-3] a cycle, or more pairs than the budget, counts as different instead of looping", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const copy: Record<string, unknown> = {};
    copy["self"] = copy;
    expect(sameData(cyclic, copy)).toBe(false);
    const big = Array.from({ length: 20_000 }, (_, index) => index);
    expect(sameData(big, [...big])).toBe(false);
  });
});
