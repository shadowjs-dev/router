import { percentDecodeLenient, percentEncodeComponent } from "./encoding";

/**
 * Search-param codec: parse a query string into a typed record, and back.
 *
 * Decoding rules (the default codec):
 * - Keys and values are percent-decoded once; `+` means a space; malformed escapes stay literal.
 * - A value that looks like JSON is decoded as JSON (max depth {@link MAX_JSON_DEPTH}). Numbers
 *   decode only when `String(number)` gives back the same text, so `12345678901234567890`, `1e3`,
 *   `-0` and `01` stay strings.
 * - A key without `=` is `true`. An empty value (`a=`) is `""`.
 * - A key that appears several times becomes an array in query order.
 * - Keys `__proto__`, `constructor` and `prototype` are dropped, at every level. Objects are null
 *   prototype, so no key can reach `Object.prototype`.
 *
 * Encoding is the inverse with a fixed canonical form: keys sorted, strings quoted when they would
 * decode to something else, arrays of two or more values repeated, other arrays as JSON.
 */

/**
 * A decoded search value. Objects are plain data; arrays are read-only.
 * @since 1.0.0
 */
export type SearchValue =
  | null
  | boolean
  | number
  | string
  | readonly SearchValue[]
  | { readonly [key: string]: SearchValue };

/**
 * The record a query string parses to. Null prototype.
 * @since 1.0.0
 */
export type SearchRecord = Readonly<Record<string, SearchValue>>;

/**
 * A partial update: `undefined` removes a key.
 * @since 1.0.0
 */
export type SearchPatch = Readonly<Record<string, SearchValue | undefined>>;

/**
 * Default cap on the length of a query string, in UTF-16 code units.
 * @example
 * import { MAX_SEARCH_LENGTH } from "@shadow-js/router/core";
 * MAX_SEARCH_LENGTH; // 4096
 * @since 1.0.0
 */
export const MAX_SEARCH_LENGTH = 4096;

/**
 * Maximum nesting depth of a JSON value inside a query string.
 * @example
 * import { MAX_JSON_DEPTH } from "@shadow-js/router/core";
 * MAX_JSON_DEPTH; // 16
 * @since 1.0.0
 */
export const MAX_JSON_DEPTH = 16;

/**
 * Keys that would reach the prototype chain: dropped from every record the router builds.
 * @example
 * FORBIDDEN_KEYS.has("__proto__"); // true
 * @since 1.0.0
 */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Options for {@link parseSearch}.
 * @since 1.0.0
 */
export interface ParseSearchOptions {
  /** Maximum accepted length of the input. Defaults to {@link MAX_SEARCH_LENGTH}. */
  readonly maxLength?: number;
}

/**
 * True when the query is no longer than the cap. Check this before parsing untrusted input.
 *
 * @param query Raw query string, with or without `?`.
 * @param maxLength Cap in UTF-16 code units.
 * @returns Whether the query may be parsed.
 * @example
 * import { isSearchWithinLimit } from "@shadow-js/router/core";
 * isSearchWithinLimit("?page=2"); // true
 * isSearchWithinLimit("?page=2", 3); // false
 * @since 1.0.0
 */
export function isSearchWithinLimit(query: string, maxLength: number = MAX_SEARCH_LENGTH): boolean {
  return query.length <= maxLength;
}

/** Cheap pre-check: can this text possibly be a JSON value we want to decode? */
function mayBeJson(text: string): boolean {
  if (text.length === 0) return false;
  if ('{["-0123456789'.includes(text.charAt(0))) return true;
  return text === "true" || text === "false" || text === "null";
}

/**
 * Scans brackets (ignoring string contents) and reports whether nesting exceeds the limit. Runs
 * before JSON.parse so a hostile value is rejected without being built.
 */
function jsonDepthExceeds(text: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text.charAt(index);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "[" || ch === "{") {
      depth += 1;
      if (depth > limit) return true;
    } else if (ch === "]" || ch === "}") {
      depth -= 1;
    }
  }
  return false;
}

/**
 * Reviver for JSON.parse. Drops forbidden keys and turns every object into a null-prototype
 * object. JSON.parse calls it bottom-up, so each object is copied after its children are final.
 */
function reviveSafe(key: string, value: unknown): unknown {
  if (FORBIDDEN_KEYS.has(key)) return undefined;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const copy: Record<string, unknown> = Object.create(null);
    for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
      if (!FORBIDDEN_KEYS.has(name)) copy[name] = child;
    }
    return copy;
  }
  return value;
}

type JsonOutcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function parseJsonText(text: string): JsonOutcome {
  try {
    return { ok: true, value: JSON.parse(text, reviveSafe) as unknown };
  } catch {
    // Not JSON. That is the expected outcome for most values, so the caller keeps the text.
    return { ok: false };
  }
}

/**
 * Decodes one already percent-decoded value: JSON when it is well formed JSON that round-trips,
 * otherwise the text itself.
 *
 * @param text Decoded value text.
 * @returns A decoded value.
 * @example decodeSearchValue("42") // 42
 * @example decodeSearchValue("12345678901234567890") // "12345678901234567890"
 * @since 1.0.0
 */
export function decodeSearchValue(text: string): SearchValue {
  if (!mayBeJson(text)) return text;
  if (jsonDepthExceeds(text, MAX_JSON_DEPTH)) return text;
  const outcome = parseJsonText(text);
  if (!outcome.ok) return text;
  const value = outcome.value;
  if (typeof value === "number" && String(value) !== text) return text;
  // reviveSafe guarantees the shape: null, boolean, finite number, string, array or plain object.
  return value as SearchValue;
}

/**
 * Parses a query string into a null-prototype record.
 *
 * @param query Query string, with or without a leading `?`.
 * @param options Length cap.
 * @returns The decoded record.
 * @throws RangeError when the query is longer than the cap. The check runs before any work.
 * @example parseSearch("?page=2&tag=a&tag=b") // { page: 2, tag: ["a", "b"] }
 * @since 1.0.0
 */
export function parseSearch(query: string, options: ParseSearchOptions = {}): SearchRecord {
  const maxLength = options.maxLength ?? MAX_SEARCH_LENGTH;
  if (query.length > maxLength) {
    throw new RangeError(
      __DEV__
        ? `search string of ${query.length} characters exceeds ${maxLength}`
        : "SHADOW_SEARCH_LENGTH",
    );
  }
  const body = query.startsWith("?") ? query.slice(1) : query;
  const collected = new Map<string, SearchValue[]>();
  for (const segment of body.split("&")) {
    if (segment === "") continue;
    const equals = segment.indexOf("=");
    const rawKey = equals < 0 ? segment : segment.slice(0, equals);
    const key = percentDecodeLenient(rawKey.replaceAll("+", " "));
    if (FORBIDDEN_KEYS.has(key)) continue;
    const value: SearchValue =
      equals < 0
        ? true
        : decodeSearchValue(percentDecodeLenient(segment.slice(equals + 1).replaceAll("+", " ")));
    const list = collected.get(key);
    if (list === undefined) {
      collected.set(key, [value]);
    } else {
      list.push(value);
    }
  }
  const record: Record<string, SearchValue> = Object.create(null);
  for (const [key, values] of collected) {
    const [only] = values;
    record[key] = values.length === 1 && only !== undefined ? only : values;
  }
  return record;
}

function isArrayValue(value: SearchValue | undefined): value is readonly SearchValue[] {
  return Array.isArray(value);
}

/** Encodes one non-array value as the text that decodes back to it. */
function encodeValue(value: SearchValue): string {
  if (typeof value === "string") {
    const text = decodeSearchValue(value) === value ? value : JSON.stringify(value);
    return percentEncodeComponent(text);
  }
  if (typeof value === "number") {
    // NaN and the infinities are not JSON; they are written as their string form.
    return percentEncodeComponent(
      Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value)),
    );
  }
  return percentEncodeComponent(JSON.stringify(value));
}

/**
 * Serializes a record to a canonical query string. `stringify(parse(q))` is a fixed point.
 *
 * @param record Values by key. `undefined` values and forbidden keys are skipped.
 * @returns `?k=v&...` in sorted key order, or `""` when nothing is left.
 * @example stringifySearch({ b: 1, a: "x y" }) // "?a=x%20y&b=1"
 * @since 1.0.0
 */
export function stringifySearch(record: SearchPatch): string {
  const keys = Object.keys(record)
    .filter((key) => !FORBIDDEN_KEYS.has(key))
    .sort();
  const parts: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (value === undefined) continue;
    const encodedKey = percentEncodeComponent(key);
    if (isArrayValue(value) && value.length >= 2) {
      for (const element of value) parts.push(`${encodedKey}=${encodeValue(element)}`);
    } else {
      parts.push(`${encodedKey}=${encodeValue(value as SearchValue)}`);
    }
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/**
 * Applies a partial update to a record without mutating it: keys in `patch` replace the base
 * value, and `undefined` removes the key. Composing two merges equals one merge of both patches.
 *
 * @param base Current record.
 * @param patch Changes.
 * @returns A new null-prototype record.
 * @example
 * import { mergeSearch } from "@shadow-js/router/core";
 * mergeSearch({ page: "1", tag: "a" }, { page: "2", tag: undefined }); // { page: "2" }
 * @since 1.0.0
 */
export function mergeSearch(base: SearchRecord, patch: SearchPatch): SearchRecord {
  const merged: Record<string, SearchValue> = Object.create(null);
  for (const key of Object.keys(base)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const value = Object.hasOwn(patch, key) ? patch[key] : base[key];
    if (value !== undefined) merged[key] = value;
  }
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_KEYS.has(key) || Object.hasOwn(base, key)) continue;
    const value = patch[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}
