import type { ParamFilter, ParamSchema, ParamSchemaResult } from "../core/index";
import type { RouterFeature } from "../types";

/**
 * The `matchFilters` feature: rules for the params of a route (a RegExp, a list of strings, a
 * predicate or a Standard Schema). The compiler lives here, not in the matcher, so an app that
 * declares no filters does not carry it. A route with `matchFilters` needs this feature in
 * `createRouter({ features })`; a link built with params is checked against the same rules.
 *
 * @example
 * import { matchFilters } from the "@shadow-js/router/filters" subpath;
 * const router = createRouter({ routes, features: [matchFilters()] });
 * @since 1.0.0
 */

/** A compiled rule: true when the value passes. */
type Predicate = (value: string) => boolean;

function isSchema(filter: ParamFilter): filter is ParamSchema {
  return typeof filter === "object" && !Array.isArray(filter) && "~standard" in filter;
}

function isStringList(filter: ParamFilter): filter is readonly string[] {
  return Array.isArray(filter);
}

function isThenable(
  result: ParamSchemaResult | Promise<ParamSchemaResult>,
): result is Promise<ParamSchemaResult> {
  return "then" in result && typeof result.then === "function";
}

/**
 * Compiles one rule. Validation happens here, when the router is built, so a bad rule fails at
 * start-up with the route and the param named. A schema whose validator is asynchronous is caught
 * when it first runs, because only the call shows whether it answers a Promise.
 */
export function compileMatchFilter(routeId: string, name: string, filter: ParamFilter): Predicate {
  if (filter instanceof RegExp) {
    if (filter.global || filter.sticky) {
      throw new TypeError(
        __DEV__
          ? `matchFilters.${name} of route "${routeId}" is a RegExp with the g or y flag; its match state would change results`
          : "SHADOW_FILTER_FLAGS",
      );
    }
    return (value) => filter.test(value);
  }
  if (typeof filter === "function") return (value) => Boolean(filter(value));
  if (isSchema(filter)) {
    return (value) => {
      const result = filter["~standard"].validate(value);
      if (isThenable(result)) {
        throw new TypeError(
          __DEV__
            ? `matchFilters.${name} of route "${routeId}" is a Standard Schema whose validate returns a Promise; matching is synchronous, so use a synchronous validator`
            : "SHADOW_FILTER_ASYNC",
        );
      }
      return result.issues === undefined;
    };
  }
  if (!isStringList(filter)) {
    throw new TypeError(
      __DEV__
        ? `matchFilters.${name} of route "${routeId}" must be a RegExp, a list of strings, a predicate or a Standard Schema`
        : "SHADOW_FILTER_TYPE",
    );
  }
  return (value) => filter.includes(value);
}

/**
 * The `matchFilters` feature. Install it in `createRouter({ features })` for routes that declare
 * `matchFilters`.
 *
 * @returns The feature.
 * @example createRouter({ routes, features: [matchFilters()] })
 * @since 1.0.0
 */
export function matchFilters(): RouterFeature {
  return {
    id: "filters",
    install(host): void {
      host.capabilities.compileFilter = compileMatchFilter;
    },
  };
}
