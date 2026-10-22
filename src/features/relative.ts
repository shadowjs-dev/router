import { resolvePath } from "../core/index";
import type { RelativeContext } from "../internal/capabilities";
import type { NavigateToOptions, RouterFeature } from "../types";

/**
 * The `relative` feature: a relative `to` (one that does not start with `/`) is resolved for `navigate`,
 * `href`, `preload` and `<A>` when the link says `relative: "path"` (against the current pathname, as a
 * directory) or `relative: "route"` (against the pattern of the deepest route matched there, keeping its
 * params). Install it in `createRouter({ features })` to use the `relative` option.
 *
 * @example
 * import { relativeLinks } from the "@shadow-js/router/relative" subpath;
 * const router = createRouter({ routes, features: [relativeLinks()] });
 * @returns The feature.
 * @since 1.0.0
 */
export function relativeLinks(): RouterFeature {
  return {
    id: "relative",
    install(host): void {
      host.capabilities.relative = resolveRelative;
    },
  };
}

/** Resolves a relative target: its absolute pattern and params. */
function resolveRelative(
  to: string,
  options: NavigateToOptions,
  context: RelativeContext,
): { readonly to: string; readonly params: Readonly<Record<string, string>> | undefined } {
  if (options.relative === "path")
    return { to: resolvePath(context.here, to), params: options.params };
  const chain = context.matcher.match(context.here);
  const pattern = `/${chain
    .map((match) => match.pattern.replace(/^\/+/, ""))
    .filter((part) => part !== "")
    .join("/")}`;
  const deepest = chain[chain.length - 1];
  return {
    to: resolvePath(pattern, to),
    params: { ...(deepest?.params ?? {}), ...(options.params ?? {}) },
  };
}
