import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildPath,
  buildPathFromParams,
  canonicalizePathname,
  decodeSegment,
  encodeSegment,
  expandOptionals,
  type PatternSegment,
  PatternSyntaxError,
  parsePattern,
  splitPathname,
} from "../../src/core/path";

const PROPS = { seed: 5, numRuns: 300 } as const;

/** Arbitrary well-formed strings: fast-check's full-unicode generator without lone surrogates. */
const wellFormedText = fc.string({ unit: "grapheme" }).filter((text) => {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code !== undefined && code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
});

const PCHAR_ONLY = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-F]{2})*$/;

describe("parsePattern", () => {
  it("[P-1] parses static, param, optional and splat segments in declaration order", () => {
    const parsed = parsePattern("/users/:id/:slug?/*rest");
    expect(parsed.segments.map((segment) => segment.kind)).toEqual([
      "static",
      "param",
      "optional",
      "splat",
    ]);
    expect(parsed.segments[1]).toEqual({ kind: "param", name: "id" });
    expect(parsed.segments[2]).toEqual({ kind: "optional", name: "slug" });
    expect(parsed.segments[3]).toEqual({ kind: "splat", name: "rest" });
  });

  it("[P-2] a bare splat is named '*' and '/' or '' have no segments", () => {
    expect(parsePattern("/*").segments).toEqual([{ kind: "splat", name: "*" }]);
    expect(parsePattern("/").segments).toEqual([]);
    expect(parsePattern("").segments).toEqual([]);
  });

  it("[P-3] a single trailing slash in the pattern is ignored", () => {
    expect(parsePattern("/about/").segments).toEqual(parsePattern("/about").segments);
  });

  it("[P-4] a leading slash is optional", () => {
    expect(parsePattern("users/:id").segments).toEqual(parsePattern("/users/:id").segments);
  });

  it.each([
    ["duplicate param names", "/a/:id/:id"],
    ["an interior empty segment", "/a//b"],
    ["a splat that is not last", "/*rest/tail"],
    ["a param without a name", "/a/:"],
    ["a name starting with a digit", "/a/:1x"],
    ["a doubled optional marker on a splat", "/a/*rest??"],
    ["an optional marker without a name", "/a/:?"],
    ["more than eight optional segments", "/:a?/:b?/:c?/:d?/:e?/:f?/:g?/:h?/:i?"],
  ])("[P-5] rejects %s with PatternSyntaxError", (_label, pattern) => {
    expect(() => parsePattern(pattern)).toThrow(PatternSyntaxError);
  });

  it("[P-6] static segments are stored in canonical form", () => {
    const parsed = parsePattern("/café/a%b");
    expect(parsed.segments).toEqual([
      { kind: "static", text: "café", canonical: "caf%C3%A9" },
      { kind: "static", text: "a%b", canonical: "a%25b" },
    ]);
  });
});

describe("expandOptionals", () => {
  const shape = (variant: readonly PatternSegment[]): string =>
    variant.map((segment) => segment.kind.charAt(0)).join("");

  it("[P-7] an optional segment yields the present variant before the absent one", () => {
    const variants = expandOptionals(parsePattern("/a/:x?").segments);
    expect(variants.map(shape)).toEqual(["so", "s"]);
  });

  it("[I-U7] adjacent optionals do not produce duplicate-equivalent routes", () => {
    const variants = expandOptionals(parsePattern("/:a?/:b?/:c?").segments);
    expect(variants.map(shape)).toEqual(["ooo", "oo", "o", ""]);
    expect(variants[1]).toEqual([
      { kind: "optional", name: "a" },
      { kind: "optional", name: "b" },
    ]);
  });

  it("[P-8] a pattern without optionals expands to exactly itself", () => {
    const segments = parsePattern("/a/:b/*c").segments;
    expect(expandOptionals(segments)).toEqual([segments]);
  });

  it("[P-9] an optional followed by a required param expands to two distinct variants", () => {
    const variants = expandOptionals(parsePattern("/:x?/:y").segments);
    expect(variants.map(shape)).toEqual(["op", "p"]);
  });

  it("[P-10] variant structure keys follow the case policy", () => {
    const variants = expandOptionals(
      [
        { kind: "optional", name: "x" },
        { kind: "static", text: "A", canonical: "A" },
      ],
      false,
    );
    expect(variants.map(shape)).toEqual(["os", "s"]);
    const sensitive = expandOptionals(
      [
        { kind: "static", text: "a", canonical: "a" },
        { kind: "optional", name: "x" },
        { kind: "static", text: "A", canonical: "A" },
      ],
      true,
    );
    expect(sensitive.map(shape)).toEqual(["sos", "ss"]);
  });
});

describe("encodeSegment and decodeSegment", () => {
  it("[I-U3] %2F, %25 and %5C decode to their characters inside a single segment", () => {
    expect(decodeSegment("a%2Fb")).toBe("a/b");
    expect(decodeSegment("100%25")).toBe("100%");
    expect(decodeSegment("x%5Cy")).toBe("x\\y");
  });

  it("[I-U3] a single decode only: %2541 is the literal text %41", () => {
    expect(decodeSegment("%2541")).toBe("%41");
  });

  it.each([
    "%",
    "%z",
    "%4",
    "%zz",
    "%C3",
    "%C3%28",
    "%C0%AF",
    "%ED%A0%80",
    "%F4%90%80%80",
    "%80",
    "ok%E4%BD",
  ])("[I-U3] malformed sequence %s yields undefined and never throws", (raw) => {
    expect(decodeSegment(raw)).toBeUndefined();
  });

  it("[I-U4] plus, at, colon, dollar, ampersand, comma, semicolon and equals are kept literal", () => {
    expect(decodeSegment("a+b@c:d$e&f,g;h=i")).toBe("a+b@c:d$e&f,g;h=i");
    expect(encodeSegment("a+b@c:d$e&f,g;h=i")).toBe("a+b@c:d$e&f,g;h=i");
  });

  it("[I-U5] non-ASCII text is encoded as UTF-8 percent escapes", () => {
    expect(encodeSegment("你好")).toBe("%E4%BD%A0%E5%A5%BD");
    expect(encodeSegment("\u{1f600}")).toBe("%F0%9F%98%80");
  });

  it("[I-U5] lone surrogates are replaced by U+FFFD when encoded", () => {
    expect(encodeSegment("\ud800")).toBe("%EF%BF%BD");
  });

  it.each([
    [" ", "%20"],
    ['"', "%22"],
    ["<", "%3C"],
    [">", "%3E"],
    ["`", "%60"],
    ["{", "%7B"],
    ["}", "%7D"],
    ["\\", "%5C"],
    ["|", "%7C"],
    ["\u0007", "%07"],
    ["\u007f", "%7F"],
    ["?", "%3F"],
    ["#", "%23"],
    ["/", "%2F"],
    ["%", "%25"],
  ])("[I-U3] re-encodes %j as %s", (raw, expected) => {
    expect(encodeSegment(raw)).toBe(expected);
  });

  it("[I-U5] decode(encode(text)) returns the text for any well-formed unicode string", () => {
    fc.assert(
      fc.property(wellFormedText, (text) => {
        expect(decodeSegment(encodeSegment(text))).toBe(text);
      }),
      PROPS,
    );
  });

  it("[I-U3] encoded output only contains RFC 3986 pchar characters and valid escapes", () => {
    fc.assert(
      fc.property(wellFormedText, (text) => {
        expect(PCHAR_ONLY.test(encodeSegment(text))).toBe(true);
      }),
      PROPS,
    );
  });
});

describe("splitPathname", () => {
  it.each([
    ["/a/b", ["a", "b"]],
    ["/a/b/", ["a", "b"]],
    ["/", []],
    ["", []],
    ["a/b", ["a", "b"]],
    ["/\\x", ["\\x"]],
  ])("splits %j into %j", (input, expected) => {
    expect(splitPathname(input)).toEqual(expected);
  });

  it("[I-U1] interior empty segments make the pathname invalid", () => {
    expect(splitPathname("/a//b")).toBeUndefined();
    expect(splitPathname("//")).toBeUndefined();
  });

  it("[I-U2] a doubled leading slash is never a path", () => {
    expect(splitPathname("//evil.example")).toBeUndefined();
  });
});

describe("canonicalizePathname", () => {
  it("[I-U1] '/a//b' is rejected while '/a/b' is accepted", () => {
    expect(canonicalizePathname("/a//b")).toBeUndefined();
    expect(canonicalizePathname("/a/b")).toBe("/a/b");
  });

  it.each([
    ["//evil.example", undefined],
    ["/\\evil.example", "/%5Cevil.example"],
    ["/%5Cevil.example", "/%5Cevil.example"],
  ])("[I-U2] %j becomes %j and never a protocol-relative path", (input, expected) => {
    expect(canonicalizePathname(input)).toBe(expected);
  });

  it("[I-U2] for any input starting with a double slash or slash-backslash, the result is never protocol-relative", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant("//"), fc.constant("/\\"), fc.constant("/\\\\"), fc.constant("/\t/")),
        wellFormedText,
        (prefix, tail) => {
          const result = canonicalizePathname(prefix + tail);
          if (result !== undefined) {
            expect(result.startsWith("//")).toBe(false);
            expect(result.startsWith("/\\")).toBe(false);
          }
        },
      ),
      PROPS,
    );
  });

  it("[I-U3] escaped slash, percent and backslash stay escaped in the canonical form", () => {
    expect(canonicalizePathname("/a%2Fb/c%25d/e%5Cf")).toBe("/a%2Fb/c%25d/e%5Cf");
  });

  it("[I-U3] malformed percent sequences give undefined instead of throwing", () => {
    expect(canonicalizePathname("/100%")).toBeUndefined();
    expect(canonicalizePathname("/%zz")).toBeUndefined();
  });

  it("[I-U3] canonicalizing arbitrary strings never throws", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (text) => {
        const result = canonicalizePathname(`/${text}`);
        expect(result === undefined || result.startsWith("/")).toBe(true);
      }),
      PROPS,
    );
  });

  it("[I-U5] CJK and accented text canonicalize to their UTF-8 escapes", () => {
    expect(canonicalizePathname("/café/你")).toBe("/caf%C3%A9/%E4%BD%A0");
    expect(canonicalizePathname("/caf%C3%A9")).toBe("/caf%C3%A9");
  });

  it("[I-U3] unreserved escapes are decoded: %7E becomes ~", () => {
    expect(canonicalizePathname("/%7Eabc")).toBe("/~abc");
  });

  it("[I-U4] sub-delimiters and colon, at-sign stay unescaped", () => {
    expect(canonicalizePathname("/a+b@c:d$e&f,g;h=i")).toBe("/a+b@c:d$e&f,g;h=i");
  });

  it.each([
    ["never", "/about/", "/about"],
    ["never", "/about", "/about"],
    ["always", "/about", "/about/"],
    ["always", "/about/", "/about/"],
    ["preserve", "/about/", "/about/"],
    ["preserve", "/about", "/about"],
    ["never", "/", "/"],
    ["always", "/", "/"],
    ["preserve", "", "/"],
  ] as const)("[I-U13] trailing policy %s maps %j to %j", (policy, input, expected) => {
    expect(canonicalizePathname(input, policy)).toBe(expected);
  });

  it("[I-U13] canonicalization is idempotent for every policy", () => {
    fc.assert(
      fc.property(
        wellFormedText.filter((text) => text.length > 0),
        fc.constantFrom("never", "always", "preserve"),
        (text, policy) => {
          const once = canonicalizePathname(`/${encodeSegment(text)}/`, policy);
          expect(once).toBeDefined();
          if (once !== undefined) {
            expect(canonicalizePathname(once, policy)).toBe(once);
          }
        },
      ),
      PROPS,
    );
  });
});

describe("buildPath", () => {
  it("builds static and param segments with RFC 3986 escaping", () => {
    expect(buildPath("/users/:id", { id: "a b/ü" })).toBe("/users/a%20b%2F%C3%BC");
  });

  it("[I-U5] builds CJK static segments as UTF-8 escapes", () => {
    expect(buildPath("/你好", {})).toBe("/%E4%BD%A0%E5%A5%BD");
  });

  it("[I-U3] percent and backslash inside params are escaped", () => {
    expect(buildPath("/f/:v", { v: "50%\\x" })).toBe("/f/50%25%5Cx");
  });

  it("returns '/' for a pattern without segments", () => {
    expect(buildPath("/", {})).toBe("/");
  });

  it("[P-11] a missing required param throws", () => {
    expect(() => buildPathFromParams("/users/:id", {})).toThrow(RangeError);
  });

  it("[P-11] an empty required param throws because it would create an empty segment", () => {
    expect(() => buildPathFromParams("/users/:id", { id: "" })).toThrow(RangeError);
  });

  it("[P-12] an absent optional segment is omitted", () => {
    expect(buildPathFromParams("/a/:x?", {})).toBe("/a");
    expect(buildPathFromParams("/a/:x?", { x: "1" })).toBe("/a/1");
  });

  it("[P-12] a present optional after a missing optional throws, since it would match another variant", () => {
    expect(() => buildPathFromParams("/:x?/:y?", { y: "2" })).toThrow(RangeError);
  });

  it("[P-13] a required param may follow a missing optional", () => {
    expect(buildPathFromParams("/:x?/:y", { y: "2" })).toBe("/2");
  });

  it("[A3-R4] a splat keeps its slashes; an empty required splat is an error; an optional one adds nothing", () => {
    expect(buildPathFromParams("/files/*rest", { rest: "a/b c" })).toBe("/files/a/b%20c");
    expect(() => buildPathFromParams("/files/*rest", { rest: "" })).toThrow(RangeError);
    expect(() => buildPathFromParams("/files/*", {})).toThrow(RangeError);
    expect(buildPathFromParams("/files/*?", {})).toBe("/files");
  });

  it("a splat with an empty interior piece throws", () => {
    expect(() => buildPathFromParams("/files/*rest", { rest: "a//b" })).toThrow(RangeError);
  });
});
