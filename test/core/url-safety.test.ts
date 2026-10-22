import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isSafeNavigationTarget, resolveSameOrigin } from "../../src/core/url-safety";

const PROPS = { seed: 5, numRuns: 300 } as const;
const BASE = "https://app.test/base/page?x=1";

/** Characters browsers strip or ignore inside a scheme, plus invisible and space-like ones. */
const JUNK = ["\t", "\n", "\r", "\0", "\x01", "\x1f", "\x7f", " ", " ", "​", "﻿"];

/** Random-case copy of `word`, with junk characters inserted between letters. */
function obfuscate(word: string, flips: readonly boolean[], junk: readonly string[]): string {
  let out = "";
  for (let index = 0; index < word.length; index += 1) {
    const ch = word.charAt(index);
    const upper = flips[index % Math.max(flips.length, 1)] === true;
    const cased = upper ? ch.toUpperCase() : ch.toLowerCase();
    const separator = junk[index % Math.max(junk.length, 1)];
    out += index > 0 && separator !== undefined ? `${separator}${cased}` : cased;
  }
  return out;
}

describe("isSafeNavigationTarget", () => {
  it.each([
    "https://app.test/x",
    "http://example.org",
    "mailto:someone@example.org",
    "tel:+15555550100",
    "/relative/path?q=1#h",
    "relative/path",
    "?query-only=1",
    "#hash-only",
    "",
    "./down",
    "../up",
  ])("allows %j", (href) => {
    expect(isSafeNavigationTarget(href)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "JAVASCRIPT:alert(1)",
    " javascript:alert(1)",
    "\tjavascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "jav\rascript:alert(1)",
    "java\u0000script:alert(1)",
    "javascript\u0001:alert(1)",
    " javascript:alert(1)",
    "java​script:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "DATA:text/html;base64,AAAA",
    "blob:https://app.test/uuid",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://example.org/x",
    "ws://example.org",
    "about:blank",
    "&#106;avascript:alert(1)",
    "%6Aavascript:alert(1)",
    "a:b",
  ])("rejects %j", (href) => {
    expect(isSafeNavigationTarget(href)).toBe(false);
  });

  it("[I-U10] rejects protocol-relative forms, which must go through resolveSameOrigin", () => {
    expect(isSafeNavigationTarget("//evil.example")).toBe(false);
    expect(isSafeNavigationTarget("/\\evil.example")).toBe(false);
    expect(isSafeNavigationTarget("\\\\evil.example")).toBe(false);
  });

  it("[I-U10] a colon after a slash is part of a path, not a scheme", () => {
    expect(isSafeNavigationTarget("/a:javascript")).toBe(true);
    expect(isSafeNavigationTarget("./x:y")).toBe(true);
    expect(isSafeNavigationTarget("?a=javascript:x")).toBe(true);
  });

  it("[I-U10] fuzz: obfuscated javascript:, data:, blob:, vbscript: are always rejected", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("javascript", "data", "blob", "vbscript", "file"),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }),
        fc.array(fc.constantFrom(...JUNK), { minLength: 1, maxLength: 12 }),
        fc.array(fc.constantFrom(...JUNK), { maxLength: 3 }),
        fc.string({ unit: "grapheme", maxLength: 20 }),
        (scheme, flips, junk, leading, tail) => {
          const hidden = `${leading.join("")}${obfuscate(scheme, flips, junk)}:${tail}`;
          expect(isSafeNavigationTarget(hidden)).toBe(false);
        },
      ),
      PROPS,
    );
  });

  it("[I-U10] fuzz: obfuscated http and https are still allowed after junk removal", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("http", "https"),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
        fc.array(fc.constantFrom("\t", "\n", "\r"), { minLength: 1, maxLength: 6 }),
        (scheme, flips, junk) => {
          expect(isSafeNavigationTarget(`${obfuscate(scheme, flips, junk)}://x.test`)).toBe(true);
        },
      ),
      PROPS,
    );
  });

  it("[I-U10] never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 80 }), (href) => {
        expect(typeof isSafeNavigationTarget(href)).toBe("boolean");
      }),
      PROPS,
    );
  });
});

describe("resolveSameOrigin", () => {
  it.each([
    ["/a?b=1#c", "/a?b=1#c"],
    ["rel", "/base/rel"],
    ["../up", "/up"],
    ["?q=2", "/base/page?q=2"],
    ["#h", "/base/page?x=1#h"],
    ["https://app.test/z", "/z"],
    ["https://app.test:443/z", "/z"],
  ])("resolves %j against the base to %j", (target, expected) => {
    expect(resolveSameOrigin(target, BASE)).toBe(expected);
  });

  it.each([
    ["//evil.example/x", "/evil.example/x"],
    ["/\\evil.example", "/evil.example"],
    ["\\\\evil.example", "/evil.example"],
    ["\\/evil.example", "/evil.example"],
  ])("[I-U2] %j normalizes to the same-origin path %j", (target, expected) => {
    expect(resolveSameOrigin(target, BASE)).toBe(expected);
  });

  it.each([
    "https://evil.example/z",
    "https://app.test.evil.example/z",
    "https://app.test@evil.example/z",
    "http://app.test/z",
    "mailto:a@b.test",
    "tel:+1",
    "javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,x",
  ])("[I-U10] %j is rejected", (target) => {
    expect(resolveSameOrigin(target, BASE)).toBeUndefined();
  });

  it("rejects control characters that are not tab, newline or carriage return", () => {
    expect(resolveSameOrigin("/a\u0001b", BASE)).toBeUndefined();
  });

  it("strips tab, newline and carriage return that the URL standard would strip", () => {
    expect(resolveSameOrigin("/a\tb\nc\r", BASE)).toBe("/abc");
  });

  it("returns undefined for an unusable base instead of throwing", () => {
    expect(resolveSameOrigin("/x", "not a url")).toBeUndefined();
  });

  it("[I-U2] for any path-like target the result is a same-origin path", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("/", "//", "/\\", "\\\\"),
        fc
          .string({ unit: "grapheme", maxLength: 24 })
          .filter((text) => !text.includes("\t") && !text.includes("\n") && !text.includes("\r")),
        (prefix, tail) => {
          const resolved = resolveSameOrigin(prefix + tail, BASE);
          if (resolved !== undefined) {
            expect(resolved.startsWith("/")).toBe(true);
            expect(resolved.startsWith("//")).toBe(false);
          }
        },
      ),
      PROPS,
    );
  });
});
