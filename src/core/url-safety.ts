import { asciiLowercase } from "./encoding";

/**
 * Checks for user-supplied navigation targets.
 *
 * The scheme check runs on a copy of the target with every control character, space-like and
 * invisible character removed. Browsers strip some of these before parsing, so
 * `java\tscript:` must be seen as `javascript:` here, not as a relative path.
 */

const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto", "tel"]);

/** Code points removed before the scheme check: C0 and C1 controls, space-like, invisible. */
function isIgnorableForScheme(code: number): boolean {
  if (code <= 0x20 || code === 0x7f) return true;
  if (code >= 0x80 && code <= 0x9f) return true;
  if (code === 0xa0 || code === 0x1680 || code === 0xfeff) return true;
  if (code >= 0x2000 && code <= 0x200f) return true;
  if (code >= 0x2028 && code <= 0x202f) return true;
  if (code >= 0x205f && code <= 0x206f) return true;
  return code === 0x3000;
}

function stripForSchemeCheck(href: string): string {
  let out = "";
  for (const ch of href) {
    const code = ch.codePointAt(0) ?? 0;
    if (!isIgnorableForScheme(code)) out += ch;
  }
  return out;
}

function isSlash(ch: string): boolean {
  return ch === "/" || ch === "\\";
}

function isValidSchemeText(text: string): boolean {
  if (text.length === 0) return false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const letter = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    const digitOrSymbol =
      (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2d || code === 0x2e;
    if (index === 0 ? !letter : !(letter || digitOrSymbol)) return false;
  }
  return true;
}

/**
 * True when the href is a relative reference or an absolute URL with an allowed scheme
 * (`http`, `https`, `mailto`, `tel`). Everything else is rejected: `javascript:`, `data:`,
 * `blob:`, `vbscript:`, `file:` and any other scheme, matched case-insensitively after removing
 * embedded and leading control or invisible characters.
 *
 * Protocol-relative forms (`//host`, `/\host`) are rejected here, because they name another
 * origin unless normalized. Pass them to {@link resolveSameOrigin} instead.
 *
 * @param href Target as the caller received it.
 * @returns Whether the target may be navigated to without further resolution.
 * @example isSafeNavigationTarget("java\tscript:alert(1)") // false
 * @since 1.0.0
 */
export function isSafeNavigationTarget(href: string): boolean {
  const cleaned = stripForSchemeCheck(href);
  if (cleaned.length >= 2 && isSlash(cleaned.charAt(0)) && isSlash(cleaned.charAt(1))) {
    return false;
  }
  const colon = cleaned.indexOf(":");
  if (colon < 0) return true;
  const head = cleaned.slice(0, colon);
  // A colon after a slash or a query marker belongs to a path or query: the reference is relative.
  if (head.includes("/") || head.includes("?")) return true;
  // Entity-like or escape-like text before the colon could decode into a scheme once the value is
  // serialized into HTML or percent-decoded, so it is rejected outright.
  if (head.includes("#") || head.includes("&") || head.includes("%")) return false;
  const scheme = asciiLowercase(head);
  return isValidSchemeText(scheme) && ALLOWED_SCHEMES.has(scheme);
}

/**
 * Normalizes a navigation target the way the URL standard does before parsing: removes tab,
 * newline and carriage return, trims outer spaces and controls, collapses leading slashes and
 * backslashes into one slash (so `//host` becomes the path `/host`).
 *
 * @param target Raw target.
 * @returns The normalized text, or undefined when it still contains an inner control character.
 * @example
 * import { normalizeNavigationText } from "@shadow-js/router/core";
 * normalizeNavigationText("//host/path"); // "/host/path"
 * normalizeNavigationText("/a\u0001b"); // undefined: an inner control character
 * @since 1.0.0
 */
export function normalizeNavigationText(target: string): string | undefined {
  let text = "";
  for (const ch of target) {
    if (ch !== "\t" && ch !== "\n" && ch !== "\r") text += ch;
  }
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end -= 1;
  text = text.slice(start, end);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return collapseLeadingSlashes(text);
}

/** Collapses a run of leading slashes or backslashes into a single slash. */
function collapseLeadingSlashes(text: string): string {
  let index = 0;
  while (index < text.length && isSlash(text.charAt(index))) index += 1;
  if (index === 0) return text;
  return `/${text.slice(index)}`;
}

/**
 * Resolves a user-supplied target against the current URL and returns the same-origin path,
 * query and fragment, or undefined when the target would leave the origin or is not allowed.
 * Protocol-relative input (`//host/x`, `/\host`) becomes the same-origin path `/host/x`.
 *
 * @param target Target as the caller received it.
 * @param base Absolute URL of the current page.
 * @returns A path beginning with `/`, or undefined. Never throws.
 * @example resolveSameOrigin("//evil.example/x", "https://app.test/") // "/evil.example/x"
 * @example resolveSameOrigin("https://evil.example", "https://app.test/") // undefined
 * @since 1.0.0
 */
export function resolveSameOrigin(target: string, base: string): string | undefined {
  const candidate = normalizeNavigationText(target);
  if (candidate === undefined) return undefined;
  if (!isSafeNavigationTarget(candidate)) return undefined;
  if (!URL.canParse(base)) return undefined;
  if (!URL.canParse(candidate, base)) return undefined;
  const baseOrigin = new URL(base).origin;
  if (baseOrigin === "null") return undefined;
  const resolved = new URL(candidate, base);
  if (resolved.origin !== baseOrigin) return undefined;
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
