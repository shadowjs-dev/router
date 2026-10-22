import { type HeadInput, useHead } from "@shadow-js/web";
import type { RouteHeadInput, RouterFeature } from "../types";

/**
 * The `head` feature: a route's `head` export is applied through the web head registry while the
 * route renders. It is the only place that imports the head registry, so an app that sets no head
 * does not carry it. A route with `head` needs this feature.
 *
 * @example
 * import { headManagement } from the "@shadow-js/router/head" subpath;
 * const router = createRouter({ routes, features: [headManagement()] });
 * @returns The feature.
 * @since 1.0.0
 */
export function headManagement(): RouterFeature {
  return {
    id: "head",
    install(host): void {
      host.capabilities.head = (core, depth, head): void => {
        useHead(() =>
          checkedHead(
            head({ params: core.paramsAt(depth)() ?? {}, loaderData: core.loaderAt(depth)() }),
          ),
        );
      };
    },
  };
}

/**
 * A route's head as the registry takes it. The registry validates every tag when it applies it
 * (an unknown name such as `script` throws a TypeError), so the wider `tag: string` of a route
 * module's head is checked there at run time, not trusted.
 */
function checkedHead(input: RouteHeadInput): HeadInput {
  return input as HeadInput;
}
