import { describe, expect, it } from "vitest";
import { analyzeRouteModule } from "../../src/vite/exports";

describe("route cache literals (ISR)", () => {
  it("[ISR-R1] revalidate is read as seconds or false, never as anything else", () => {
    expect(analyzeRouteModule("export const revalidate = 60;", "a.ts").config).toEqual({
      revalidate: 60,
    });
    expect(analyzeRouteModule("export const revalidate = false as const;", "a.ts").config).toEqual({
      revalidate: false,
    });
    expect(analyzeRouteModule("export const revalidate = 0;", "a.ts").config).toEqual({});
    expect(analyzeRouteModule("export const revalidate = -5;", "a.ts").config).toEqual({});
    expect(analyzeRouteModule('export const revalidate = "60";', "a.ts").config).toEqual({});
    expect(analyzeRouteModule("export const revalidate = pick();", "a.ts").config).toEqual({});
  });

  it("[ISR-R2] cache is read from a literal object: staleSeconds, cookies, searchParams", () => {
    const info = analyzeRouteModule(
      `export const cache = { staleSeconds: 300, cookies: ["locale", 'theme'], "searchParams": ["page"] } satisfies object;`,
      "a.ts",
    );
    expect(info.config).toEqual({
      cache: { staleSeconds: 300, cookies: ["locale", "theme"], searchParams: ["page"] },
    });
  });

  it("[ISR-R3] a cache object that is not literal is not read (no partial guesses)", () => {
    expect(analyzeRouteModule("export const cache = make();", "a.ts").config).toEqual({});
    expect(analyzeRouteModule("export const cache = { cookies: names };", "a.ts").config).toEqual(
      {},
    );
    expect(analyzeRouteModule("export const cache = { staleSeconds: -1 };", "a.ts").config).toEqual(
      {},
    );
  });
});
