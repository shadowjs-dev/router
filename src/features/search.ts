import { runSearchValidator } from "../core/search-validation";
import type { RouterFeature } from "../types";

/**
 * The `validateSearch` feature: a route's `validateSearch` (a function from the raw query to the typed search, or a
 * Standard Schema such as Zod, Valibot or ArkType) runs when the route is entered. The validator runner lives here,
 * not in the core, so an app whose routes validate no search does not carry it. A route with `validateSearch` needs
 * this feature in `createRouter({ features })`, and creation names the route and the import when it is missing.
 *
 * @example
 * import { searchValidation } from "@shadow-js/router/search";
 * const router = createRouter({ routes, features: [searchValidation()] });
 * @returns The feature.
 * @since 1.0.0
 */
export function searchValidation(): RouterFeature {
  return {
    id: "search",
    install(host): void {
      host.capabilities.validateSearch = runSearchValidator;
    },
  };
}
