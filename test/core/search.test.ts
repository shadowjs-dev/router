import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodeSearchValue,
  isSearchWithinLimit,
  MAX_JSON_DEPTH,
  MAX_SEARCH_LENGTH,
  mergeSearch,
  parseSearch,
  type SearchRecord,
  type SearchValue,
  stringifySearch,
} from "../../src/core/search";

const PROPS = { seed: 5, numRuns: 300 } as const;

function plain(record: SearchRecord): Record<string, unknown> {
  return { ...record };
}

/** Nests `[` `]` `depth` times around a number: `[[[1]]]` has depth 3. */
function nestedArray(depth: number): string {
  return `${"[".repeat(depth)}1${"]".repeat(depth)}`;
}

describe("parseSearch: prototype and keys", () => {
  it("[I-S1] the result has a null prototype", () => {
    expect(Object.getPrototypeOf(parseSearch("?a=1"))).toBeNull();
    expect(Object.getPrototypeOf(parseSearch(""))).toBeNull();
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "[I-S1] the key %s is dropped from the query and does not pollute Object",
    (key) => {
      const parsed = parseSearch(`?${key}=1&ok=2`);
      expect(Object.hasOwn(parsed, key)).toBe(false);
      expect(parsed["ok"]).toBe(2);
      expect(({} as Record<string, unknown>)[key]).not.toBe(1);
    },
  );

  it("[I-S1] forbidden keys inside a JSON value are dropped at every level", () => {
    const parsed = parseSearch(
      '?f={"__proto__":{"x":1},"constructor":2,"ok":{"prototype":3,"y":4}}',
    );
    const value = parsed["f"];
    expect(value).toEqual({ ok: { y: 4 } });
    expect(Object.getPrototypeOf(value)).toBeNull();
  });

  it("[I-S1] a JSON key named __proto__ is never copied onto the object prototype", () => {
    parseSearch('?f={"__proto__":{"polluted":true}}');
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("an empty query, a lone '?', and a leading '?' all parse to the same record", () => {
    expect(plain(parseSearch(""))).toEqual({});
    expect(plain(parseSearch("?"))).toEqual({});
    expect(plain(parseSearch("a=1"))).toEqual(plain(parseSearch("?a=1")));
  });

  it("empty segments between ampersands are skipped", () => {
    expect(plain(parseSearch("?a=1&&b=2&"))).toEqual({ a: 1, b: 2 });
  });
});

describe("parseSearch: values", () => {
  it.each([
    ["12345678901234567890", "12345678901234567890"],
    ["9007199254740993", "9007199254740993"],
    ["1e3", "1e3"],
    ["0x10", "0x10"],
    ["-0", "-0"],
    ["01", "01"],
    ["1.0", "1.0"],
    ["1.5", 1.5],
    ["42", 42],
    ["-7", -7],
    ["0.1", 0.1],
    ["true", true],
    ["false", false],
    ["null", null],
  ])("[I-S2] the raw value %j decodes to %j", (raw, expected) => {
    expect(parseSearch(`?v=${raw}`)["v"]).toEqual(expected);
  });

  it("[I-S2] a numeric string that would lose precision stays a string", () => {
    expect(parseSearch("?id=12345678901234567890")["id"]).toBe("12345678901234567890");
  });

  it("[I-S3] duplicate keys become an array in query order", () => {
    expect(parseSearch("?a=1&a=2&a=x")["a"]).toEqual([1, 2, "x"]);
  });

  it("[I-S3] a key without '=' is true, distinct from an empty value", () => {
    expect(parseSearch("?a")["a"]).toBe(true);
    expect(parseSearch("?a=")["a"]).toBe("");
    expect(parseSearch("?a")["a"]).not.toEqual(parseSearch("?a=")["a"]);
  });

  it("[I-S3] a bare key and an explicit true are the same value by design", () => {
    expect(parseSearch("?a")["a"]).toBe(parseSearch("?a=true")["a"]);
  });

  it("the bare key and a duplicate of it form an array", () => {
    expect(parseSearch("?a&a=2")["a"]).toEqual([true, 2]);
  });

  it("decodes '+' as a space and %2B as a plus sign", () => {
    expect(parseSearch("?q=a+b%2Bc")["q"]).toBe("a b+c");
  });

  it("[I-S1] a malformed escape in the query stays literal and never throws", () => {
    expect(parseSearch("?q=%zz&r=100%")["q"]).toBe("%zz");
    expect(parseSearch("?q=%zz&r=100%")["r"]).toBe("100%");
  });

  it("decodes percent-encoded UTF-8 keys and values", () => {
    expect(parseSearch("?%E4%BD%A0=%E5%A5%BD")["\u4f60"]).toBe("\u597d");
  });

  it("a JSON value that is a string literal decodes to the string", () => {
    expect(parseSearch('?q="5"')["q"]).toBe("5");
  });

  it("JSON objects and arrays decode to null-prototype structures", () => {
    const parsed = parseSearch('?f={"x":[1,{"y":"z"}]}');
    expect(parsed["f"]).toEqual({ x: [1, { y: "z" }] });
  });

  it("the JSON depth limit is inclusive: depth 16 decodes, depth 17 stays a string", () => {
    expect(MAX_JSON_DEPTH).toBe(16);
    expect(decodeSearchValue(nestedArray(16))).toEqual(JSON.parse(nestedArray(16)));
    expect(decodeSearchValue(nestedArray(17))).toBe(nestedArray(17));
  });

  it("[I-S4] an unterminated or invalid JSON-looking value stays a string", () => {
    expect(decodeSearchValue("[1,")).toBe("[1,");
    expect(decodeSearchValue("{bad}")).toBe("{bad}");
    expect(decodeSearchValue("-")).toBe("-");
    expect(decodeSearchValue(" 5")).toBe(" 5");
  });

  it("a very deep JSON value is rejected by the cheap depth scan without parsing it", () => {
    const deep = "[".repeat(100_000);
    expect(decodeSearchValue(deep)).toBe(deep);
  });
});

describe("parseSearch: length cap", () => {
  it("[I-U11] rejects a query over the cap quickly with RangeError", () => {
    const huge = `?a=${"x".repeat(1_000_000)}`;
    expect(() => parseSearch(huge)).toThrow(RangeError);
  });

  it("accepts a query exactly at the default cap", () => {
    const exact = `?a=${"x".repeat(MAX_SEARCH_LENGTH - 3)}`;
    expect(exact.length).toBe(MAX_SEARCH_LENGTH);
    expect(parseSearch(exact)["a"]).toHaveLength(MAX_SEARCH_LENGTH - 3);
  });

  it("honors a custom cap", () => {
    expect(() => parseSearch("?a=12345", { maxLength: 5 })).toThrow(RangeError);
    expect(plain(parseSearch("?a=123", { maxLength: 6 }))).toEqual({ a: 123 });
  });

  it("isSearchWithinLimit reports the same decision as the cap", () => {
    expect(isSearchWithinLimit("?a=1", 4)).toBe(true);
    expect(isSearchWithinLimit("?a=12", 4)).toBe(false);
    expect(isSearchWithinLimit("x".repeat(MAX_SEARCH_LENGTH))).toBe(true);
    expect(isSearchWithinLimit("x".repeat(MAX_SEARCH_LENGTH + 1))).toBe(false);
  });
});

describe("stringifySearch", () => {
  it("sorts keys and omits the question mark for an empty record", () => {
    expect(stringifySearch({ b: 1, a: 2 })).toBe("?a=2&b=1");
    expect(stringifySearch({})).toBe("");
  });

  it("drops undefined values and forbidden keys", () => {
    expect(stringifySearch({ a: undefined, b: 1, ["__proto__"]: 2, constructor: 3 })).toBe("?b=1");
  });

  it("encodes reserved characters and spaces in keys and values", () => {
    expect(stringifySearch({ "a b": "c&d=e+f" })).toBe("?a%20b=c%26d%3De%2Bf");
  });

  it("quotes strings that would otherwise decode as something else", () => {
    expect(parseSearch(stringifySearch({ a: "5" }))["a"]).toBe("5");
    expect(parseSearch(stringifySearch({ a: "true" }))["a"]).toBe("true");
    expect(parseSearch(stringifySearch({ a: "null" }))["a"]).toBe("null");
    expect(stringifySearch({ a: "plain" })).toBe("?a=plain");
  });

  it("writes an array of two or more values as repeated keys", () => {
    expect(stringifySearch({ a: [1, 2] })).toBe("?a=1&a=2");
  });

  it("writes an array of zero or one values as one JSON value so its type survives", () => {
    expect(stringifySearch({ a: [1] })).toBe("?a=%5B1%5D");
    expect(stringifySearch({ a: [] })).toBe("?a=%5B%5D");
    expect(parseSearch(stringifySearch({ a: [1] }))["a"]).toEqual([1]);
    expect(parseSearch(stringifySearch({ a: [] }))["a"]).toEqual([]);
  });

  it("a non-finite number is written as its string form", () => {
    expect(parseSearch(stringifySearch({ n: Number.NaN }))["n"]).toBe("NaN");
  });

  it("[I-S5] stringify(parse(q)) is a fixed point for a sample query", () => {
    const once = stringifySearch(parseSearch("?z=%20x&a=1&a=2&m=+"));
    expect(stringifySearch(parseSearch(once))).toBe(once);
  });

  it("[I-S5] stringify(parse(q)) is idempotent for arbitrary query strings", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 40 }), (text) => {
        const query = `?k=${encodeURIComponent(text)}&j=${text.length}`;
        const once = stringifySearch(parseSearch(query));
        expect(stringifySearch(parseSearch(once))).toBe(once);
      }),
      PROPS,
    );
  });

  it("[I-S5] parse(stringify(record)) returns the record for generated records", () => {
    const key = fc
      .string({ unit: "grapheme", minLength: 1, maxLength: 6 })
      .filter((text) => text !== "__proto__" && text !== "constructor" && text !== "prototype");
    const scalar: fc.Arbitrary<SearchValue> = fc.oneof(
      fc.string({ unit: "grapheme", maxLength: 8 }),
      fc.constantFrom("5", "true", "null", "[1]", "", " 7", "1e3"),
      fc.integer({ min: -1_000_000, max: 1_000_000 }),
      fc.constantFrom(0.5, -2.25, 1.125),
      fc.boolean(),
      fc.constant(null),
    );
    const value: fc.Arbitrary<SearchValue> = fc.oneof(
      scalar,
      fc.array(scalar, { maxLength: 3 }),
      fc.dictionary(fc.constantFrom("x", "y", "z"), scalar, { maxKeys: 2 }),
    );
    fc.assert(
      fc.property(fc.dictionary(key, value, { maxKeys: 4 }), (record) => {
        const query = stringifySearch(record);
        expect(plain(parseSearch(query))).toEqual(JSON.parse(JSON.stringify(record)));
      }),
      PROPS,
    );
  });
});

describe("mergeSearch", () => {
  it("sets new keys and overwrites existing ones", () => {
    const base = parseSearch("?a=1&b=2");
    expect(plain(mergeSearch(base, { b: 3, c: "x" }))).toEqual({ a: 1, b: 3, c: "x" });
  });

  it("removes a key whose partial value is undefined", () => {
    expect(plain(mergeSearch(parseSearch("?a=1&b=2"), { a: undefined }))).toEqual({ b: 2 });
  });

  it("does not mutate the base record", () => {
    const base = parseSearch("?a=1");
    mergeSearch(base, { a: 9, z: 1 });
    expect(plain(base)).toEqual({ a: 1 });
  });

  it("returns a null-prototype record and drops forbidden keys", () => {
    const merged = mergeSearch({}, { ["__proto__"]: { polluted: 1 }, ok: 1 });
    expect(Object.getPrototypeOf(merged)).toBeNull();
    expect(Object.hasOwn(merged, "__proto__")).toBe(false);
    expect(plain(merged)).toEqual({ ok: 1 });
  });

  it("[I-S6] composing two merges equals merging the combined partial (setSearch composition)", () => {
    const base = parseSearch("?a=1");
    const composed = mergeSearch(mergeSearch(base, { b: 2 }), { c: 3 });
    expect(plain(composed)).toEqual(plain(mergeSearch(base, { b: 2, c: 3 })));
  });
});
