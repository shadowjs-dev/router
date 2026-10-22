import type { RouteMatch } from "../core/index";
import type { RenderedMatch } from "../types";

/**
 * The rendered entry of one matched route, in the kind it renders as (`route`, `notFound` or `pending`). Shared by the
 * core and the not-found feature, so both build an entry the same way.
 * @internal
 */
export function toRendered(
  match: RouteMatch,
  kind: RenderedMatch["kind"],
  loaderData: unknown,
  params: Readonly<Record<string, string>>,
): RenderedMatch {
  return { id: match.id, pattern: match.pattern, params, loaderData, depth: match.depth, kind };
}
