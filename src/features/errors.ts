import { ErrorBoundary } from "@shadow-js/web";
import type { RouterFeature } from "../types";

/**
 * The `errors` feature: the error boundary a route's `error` component is shown in. A route that
 * throws while it renders (or its loader fails) shows its `error` instead of the app crashing; the
 * next navigation rebuilds it. A route with `error` needs this feature.
 *
 * @example
 * import { errorBoundaries } from the "@shadow-js/router/errors" subpath;
 * const router = createRouter({ routes, features: [errorBoundaries()] });
 * @returns The feature.
 * @since 1.0.0
 */
export function errorBoundaries(): RouterFeature {
  return {
    id: "errors",
    install(host): void {
      host.capabilities.boundary = ErrorBoundary;
    },
  };
}
