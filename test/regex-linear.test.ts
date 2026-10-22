import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalizePathname, decodeSegment, encodeSegment, resolvePath } from "../src/core/path";
import {
  isSafeNavigationTarget,
  normalizeNavigationText,
  resolveSameOrigin,
} from "../src/core/url-safety";
import { isExternalTarget, pathOnly, withoutTrailingSlashes } from "../src/internal/links";

/**
 * Every regular expression the router applies to a location, a path or a link target, run through the function that
 * owns it. Each family runs at a small size and at 32 times that size; linear code takes about 32 times longer,
 * quadratic code about 1,000 times longer, and the bound is 64 times (see the same test in the Dusk package).
 */

function best(task: () => void, runs = 5): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    task();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

const SMALL = 4_000;
const LARGE = SMALL * 32;
const FLOOR_MS = 0.25;

type Use = (text: string) => void;

const swallow =
  (use: (text: string) => unknown): Use =>
  (text) => {
    try {
      use(text);
    } catch {
      // A refusal is a fast answer; only the time matters here.
    }
  };

const FAMILIES: ReadonlyArray<
  readonly [id: string, name: string, use: Use, build: (size: number) => string]
> = [
  [
    "01",
    "trailing slashes of a location (announcer and scroll keys): slashes before a last segment",
    swallow(withoutTrailingSlashes),
    (n) => `${"/".repeat(n)}a/`,
  ],
  ["02", "trailing slashes: only slashes", swallow(withoutTrailingSlashes), (n) => "/".repeat(n)],
  ["03", "link target path: query and hash markers", swallow(pathOnly), (n) => `${"a".repeat(n)}?`],
  [
    "04",
    "link target kind: a scheme that never ends",
    swallow(isExternalTarget),
    (n) => "a".repeat(n),
  ],
  [
    "05",
    "navigation safety: a scheme that never ends",
    swallow(isSafeNavigationTarget),
    (n) => `${"a".repeat(n)}:`,
  ],
  [
    "06",
    "navigation text: escapes that never end",
    swallow(normalizeNavigationText),
    (n) => `/${"%".repeat(n)}`,
  ],
  [
    "07",
    "same-origin resolution: slashes",
    swallow((text) => resolveSameOrigin(text, "https://app.test/")),
    (n) => "/".repeat(n),
  ],
  [
    "08",
    "same-origin resolution: backslashes and dots",
    swallow((text) => resolveSameOrigin(text, "https://app.test/")),
    (n) => "\\.".repeat(n / 2),
  ],
  [
    "09",
    "canonical pathname: capital letters in escapes",
    swallow((text) => canonicalizePathname(text, "preserve")),
    (n) => `/${"%C3%A9A".repeat(n / 7)}`,
  ],
  [
    "10",
    "canonical pathname: broken escapes",
    swallow((text) => canonicalizePathname(text, "preserve")),
    (n) => `/${"%".repeat(n)}`,
  ],
  [
    "11",
    "canonical pathname: a run of slashes",
    swallow((text) => canonicalizePathname(text, "preserve")),
    (n) => `/${"/".repeat(n)}`,
  ],
  ["12", "segment encoding: lone surrogates", swallow(encodeSegment), (n) => "\ud800".repeat(n)],
  ["13", "segment encoding: capital letters", swallow(encodeSegment), (n) => "Ab".repeat(n / 2)],
  ["14", "segment decoding: escapes that never end", swallow(decodeSegment), (n) => "%".repeat(n)],
  ["15", "segment decoding: broken UTF-8", swallow(decodeSegment), (n) => "%C3".repeat(n / 3)],
  [
    "16",
    "relative path resolution: parent segments",
    swallow((text) => resolvePath("/a/b", text)),
    (n) => "../".repeat(n / 3),
  ],
  [
    "17",
    "relative path resolution: current segments",
    swallow((text) => resolvePath("/a/b", text)),
    (n) => "./".repeat(n / 2),
  ],
];

describe("regular expressions on locations and link targets are linear", () => {
  for (const [id, name, use, build] of FAMILIES) {
    it(`[RTR-REDOS-${id}] ${name}: 32x the input stays under 64x the time`, () => {
      const little = build(SMALL);
      const big = build(LARGE);
      use(little);
      const small = Math.max(
        best(() => use(little)),
        FLOOR_MS,
      );
      // Both sizes run once before they are timed, so neither measures a cold function (compilation, first allocation).
      use(big);
      const large = best(() => use(big), 7);
      expect(large).toBeLessThan(small * 64);
    });
  }

  it("[RTR-REDOS-18] the trailing slash of a location is dropped, and only that", () => {
    expect(withoutTrailingSlashes("/a/")).toBe("/a");
    expect(withoutTrailingSlashes("/a//")).toBe("/a");
    expect(withoutTrailingSlashes("/a")).toBe("/a");
    expect(withoutTrailingSlashes("/")).toBe("");
    expect(withoutTrailingSlashes("")).toBe("");
    expect(withoutTrailingSlashes("//a/b/")).toBe("//a/b");
  });

  it("[RTR-REDOS-19] the announcer and the scroll feature take their page key from the linear helper", () => {
    for (const file of ["announcer.ts", "scroll.ts"]) {
      const source = readFileSync(new URL(`../src/features/${file}`, import.meta.url), "utf8");
      expect(source).toContain("withoutTrailingSlashes(location.pathname)");
      expect(source).not.toContain("replace(/\\/+$/");
    }
  });
});
