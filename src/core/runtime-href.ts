import { normalizeNavigationText, resolveSameOrigin } from "./url-safety";

declare const RUNTIME_HREF: unique symbol;

/**
 * A same-origin path that was chosen at run time (a validated `redirect_url`, a stored return path).
 * Typed navigation (`navigate`, `<A to>`, `href`) accepts it next to the registered page patterns.
 * Build one with {@link unsafeHref}, never with a cast. @since 1.0.0
 */
export type RuntimeHref = string & { readonly [RUNTIME_HREF]: true };

/** A base for resolving the same-origin check; any absolute URL works, only the origin is compared. */
const CHECK_BASE = "https://shadowjs.invalid/";

/**
 * True for protocol-relative input (`//host`, `/\host`), with any leading control or space characters skipped:
 * it names another origin unless normalized.
 */
function isProtocolRelative(path: string): boolean {
  let start = 0;
  while (start < path.length && path.charCodeAt(start) <= 0x20) start += 1;
  const first = path.charAt(start);
  const second = path.charAt(start + 1);
  return (first === "/" || first === "\\") && (second === "/" || second === "\\");
}

/**
 * Marks a run-time path as a navigation target the router may use. Use it only for a path that a
 * check has already accepted: a `redirect_url` read from the request and validated, or a return path
 * stored by the app. It is not a way around the registered routes for user input.
 *
 * In development the path must be same-origin: a relative path (`dashboard/files`) or a root path
 * (`/sign-in?x=1`). An absolute URL to another origin, a `javascript:` URL, and a protocol-relative
 * `//host` are refused with a `TypeError`. Production builds return the path unchecked (the check
 * costs a URL parse per call; the validation belongs where the input arrives).
 *
 * @param path The run-time path.
 * @returns The path, branded as {@link RuntimeHref}.
 * @throws TypeError in development when the path is not same-origin.
 * @example
 * const back = unsafeHref(safeReturnTo(searchParams.get("redirect_url")));
 * navigate(back);
 * @since 1.0.0
 */
export function unsafeHref(path: string): RuntimeHref {
  if (__DEV__) {
    // The raw input is tested: normalizing first would turn `//host` into the same-origin `/host`.
    const normalized = normalizeNavigationText(path);
    const sameOrigin =
      normalized !== undefined &&
      !isProtocolRelative(path) &&
      resolveSameOrigin(normalized, CHECK_BASE) !== undefined;
    if (!sameOrigin) {
      throw new TypeError(
        `unsafeHref: ${JSON.stringify(path)} is not a same-origin path. Validate the target first (a relative path or a path starting with "/"), or use a registered route.`,
      );
    }
  }
  return path as RuntimeHref;
}
