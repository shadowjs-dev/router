import type { HydrationData } from "./types";

/**
 * Hydration data as text for an inline `<script type="application/json">`. `<`, `>`, `&`, U+2028 and
 * U+2029 are written as escapes, so no value can end the script element or change what the parser
 * reads. The text parses with `JSON.parse` and contains no executable code.
 *
 * @param data The data from `router.dehydrate()`.
 * @returns JSON text, safe inside a script element.
 * @example
 * const html = `<script type="application/json" id="__shadow_data">${serializeHydrationData(router.dehydrate())}</script>`;
 * @since 1.0.0
 */
export function serializeHydrationData(data: HydrationData): string {
  return JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, escapeChar);
}

/** The JSON unicode escape of one character that must not appear raw in a script element. */
function escapeChar(ch: string): string {
  return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

function isHydrationData(value: unknown): value is HydrationData {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { readonly version?: unknown; readonly matches?: unknown };
  return record.version === 1 && Array.isArray(record.matches);
}

/**
 * Parses text produced by {@link serializeHydrationData}.
 *
 * @param text JSON text.
 * @returns The data, ready for `router.hydrate`.
 * @throws TypeError when the text is not hydration data.
 * @example
 * import { parseHydrationData } from "@shadow-js/router";
 * const data = parseHydrationData(text); // text: the JSON of the __shadow_data script element
 * router.hydrate(data);
 * @since 1.0.0
 */
export function parseHydrationData(text: string): HydrationData {
  const parsed: unknown = JSON.parse(text);
  if (!isHydrationData(parsed)) throw new TypeError("parseHydrationData(): not hydration data");
  return parsed;
}
