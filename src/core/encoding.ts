/**
 * Percent-encoding helpers shared by the path, search, matcher and URL-safety modules.
 *
 * Pure: no globals beyond the platform's `encodeURIComponent` and `TextDecoder`. UTF-8 is produced by
 * `encodeURIComponent` and validated by a fatal `TextDecoder`, so malformed input is reported through
 * return values, never thrown to the caller: routing treats a bad escape as "no match", not as a crash.
 */

const SURROGATE_ALONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const UPPER_ASCII = /[A-Z]+/g;
const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;
/** Characters `encodeURIComponent` leaves raw that a query component must escape. */
const QUERY_EXTRA = /[!'()*]/g;
/** Whole texts that need no escaping, so the common case returns the input unchanged. */
const SEGMENT_ONLY = /^[0-9A-Za-z\-._~!$&'()*+,;=:@]*$/;
const COMPONENT_ONLY = /^[0-9A-Za-z\-._~]*$/;
/** Segment text that stays raw (RFC 3986 `pchar` without `%`). Everything else is escaped. */
const SEGMENT_SAFE = /^[0-9A-Za-z\-._~!$&'()*+,;=:@]$/;
/** Unreserved characters (RFC 3986 section 2.3): the only ASCII kept by query components. */
const UNRESERVED = /^[0-9A-Za-z\-._~]$/;

/** The escape of one code unit that `encodeURIComponent` keeps raw but a query must not. */
function escapeExtra(ch: string): string {
  return `%${ch.charCodeAt(0).toString(16).toUpperCase()}`;
}

/**
 * Lowercases ASCII letters only. Non-ASCII text is returned unchanged, so case-insensitive
 * matching never depends on locale or Unicode case tables.
 *
 * @param text Any string.
 * @returns The string with `A-Z` mapped to `a-z`.
 */
export function asciiLowercase(text: string): string {
  return text.replace(UPPER_ASCII, (run) => run.toLowerCase());
}

/** Replaces each lone surrogate by U+FFFD, so the text encodes as valid UTF-8. */
function wellFormed(text: string): string {
  return text.replace(SURROGATE_ALONE, "�");
}

/**
 * Percent-encodes text for a query key or value. Only unreserved characters stay literal, so
 * `&`, `=`, `+`, `;` and space are always escaped.
 *
 * @param text Decoded text.
 * @returns Encoded text safe to place between `&` and `=`.
 */
export function percentEncodeComponent(text: string): string {
  if (COMPONENT_ONLY.test(text)) return text;
  let out = "";
  for (const ch of wellFormed(text)) {
    out += UNRESERVED.test(ch) ? ch : encodeURIComponent(ch).replace(QUERY_EXTRA, escapeExtra);
  }
  return out;
}

/**
 * Percent-encodes text for one path segment. Every character outside the RFC 3986 `pchar` set is
 * escaped as UTF-8, uppercase hex. Lone surrogates become U+FFFD so the output is always valid.
 *
 * @param text Decoded text.
 * @returns Encoded text; contains no `/`, `?`, `#`, `%`-without-two-hex-digits, or raw controls.
 */
export function percentEncodeText(text: string): string {
  if (SEGMENT_ONLY.test(text)) return text;
  let out = "";
  for (const ch of wellFormed(text)) {
    out += SEGMENT_SAFE.test(ch) ? ch : encodeURIComponent(ch);
  }
  return out;
}

/** Octet of the `%XY` escape at `index`, or -1 when there is no well-formed escape there. */
function octetAt(text: string, index: number): number {
  if (text.charAt(index) !== "%") return -1;
  const pair = text.slice(index + 1, index + 3);
  return HEX_PAIR.test(pair) ? Number.parseInt(pair, 16) : -1;
}

/**
 * Decodes percent escapes once. Plus signs are not spaces here (path semantics).
 *
 * @param text Encoded text.
 * @returns The decoded text, or undefined when any escape is malformed.
 */
export function percentDecodeStrict(text: string): string | undefined {
  // The native decoder is strict: a malformed escape or bytes that are not one valid UTF-8 text throw a
  // URIError, and it keeps a byte order mark where `TextDecoder` would drop it (`/%EF%BB%BF` is not the root).
  try {
    return decodeURIComponent(text);
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
}

/** Length in bytes of the UTF-8 sequence that starts with `lead`, or 0 when it cannot start one. */
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/**
 * Decodes percent escapes once, keeping malformed escapes literal instead of failing. A malformed
 * escape stays as its `%` and the rest is read on, so `%41%C3` decodes to `A%C3`.
 *
 * @param text Encoded text.
 * @returns Decoded text; never throws.
 */
export function percentDecodeLenient(text: string): string {
  if (!text.includes("%")) return text;
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text.charAt(index) !== "%") {
      out += text.charAt(index);
      index += 1;
      continue;
    }
    const lead = octetAt(text, index);
    const length = lead < 0 ? 0 : sequenceLength(lead);
    const run = length > 0 ? percentDecodeStrict(text.slice(index, index + length * 3)) : undefined;
    if (run === undefined) {
      out += "%";
      index += 1;
    } else {
      out += run;
      index += length * 3;
    }
  }
  return out;
}
