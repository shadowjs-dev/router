import { describe, expect, it } from "vitest";
import {
  percentDecodeLenient,
  percentDecodeStrict,
  percentEncodeComponent,
  percentEncodeText,
} from "../../src/core/encoding";

describe("percent encoding (TextEncoder / TextDecoder)", () => {
  it("[ENC-1] lenient decoding keeps a malformed escape literal and reads on past it", () => {
    expect(percentDecodeLenient("%41%C3")).toBe("A%C3");
    expect(percentDecodeLenient("%C3%A9%")).toBe("é%");
    expect(percentDecodeLenient("%E2%82%AC")).toBe("€");
  });

  it("[ENC-2] strict decoding refuses overlong, surrogate and truncated UTF-8", () => {
    expect(percentDecodeStrict("%C0%AF")).toBeUndefined();
    expect(percentDecodeStrict("%ED%A0%80")).toBeUndefined();
    expect(percentDecodeStrict("%C3")).toBeUndefined();
    expect(percentDecodeStrict("%G1")).toBeUndefined();
    expect(percentDecodeStrict("%F0%9F%98%80")).toBe("😀");
  });

  it("[ENC-3] encoding replaces a lone surrogate with U+FFFD, so the output is valid", () => {
    expect(percentEncodeText("\uD800")).toBe("%EF%BF%BD");
    expect(percentEncodeText("a/b c")).toBe("a%2Fb%20c");
    expect(percentEncodeComponent("a!b(c)")).toBe("a%21b%28c%29");
    expect(percentEncodeComponent("a-._~z9")).toBe("a-._~z9");
  });
});
