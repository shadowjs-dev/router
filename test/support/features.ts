import { blockers } from "../../src/features/blockers";
import { errorBoundaries } from "../../src/features/errors";
import { matchFilters } from "../../src/features/filters";
import { headManagement } from "../../src/features/head";
import { loaderCache } from "../../src/features/loaders";
import { notFoundUi } from "../../src/features/not-found";
import { pendingUi } from "../../src/features/pending";
import { relativeLinks } from "../../src/features/relative";
import { scrollRestoration } from "../../src/features/scroll";
import { searchValidation } from "../../src/features/search";
import { viewTransitions } from "../../src/features/transitions";
import type { RouterFeature, RouterFeatureId } from "../../src/types";

/**
 * The features a test router is built with by default: every feature except view transitions, which
 * changes what a commit does and is turned on by the tests that check it. A router built with all of
 * them behaves as the router did before the features existed.
 */
export function everyFeature(): RouterFeature[] {
  return [
    scrollRestoration(),
    loaderCache(),
    headManagement(),
    errorBoundaries(),
    matchFilters(),
    blockers(),
    relativeLinks(),
    searchValidation(),
    notFoundUi(),
    pendingUi(),
  ];
}

/**
 * The default features with some replaced (by id) and others added. A replacement keeps the position of
 * the feature it replaces.
 */
export function featuresWith(...overrides: readonly RouterFeature[]): RouterFeature[] {
  const byId = new Map<RouterFeatureId, RouterFeature>(
    overrides.map((feature) => [feature.id, feature]),
  );
  const merged = everyFeature().map((feature) => byId.get(feature.id) ?? feature);
  for (const feature of overrides) {
    if (!merged.includes(feature)) merged.push(feature);
  }
  return merged;
}

/** The default features without the one with this id. */
export function featuresWithout(id: RouterFeatureId): RouterFeature[] {
  return everyFeature().filter((feature) => feature.id !== id);
}

export { compileMatchFilter } from "../../src/features/filters";
export { loaderCache, scrollRestoration, viewTransitions };
