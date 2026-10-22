import { type Accessor, useContext } from "@shadow-js/core";
import type { SearchRecord } from "../core/index";
import { type RouterCore, SlotContext, type SlotInfo } from "../internal/core";
import { LoaderFailure } from "../internal/failure";
import { keyedView } from "../internal/keyed-view";
import { currentCore } from "../internal/render";
import type { ParamsView, RegisteredPath, RenderedMatch } from "../types";

/**
 * Hooks that read the match a component renders under. Each takes an optional `from`, a route id
 * (ids default to the path). Without it, the route is the one the component is rendered in, or the
 * deepest match when the component sits outside any route.
 */

/** Which depth a read refers to, as an accessor (it changes with the location). */
function depthAccessor(
  core: RouterCore,
  from: string | undefined,
  slot: SlotInfo | null,
): Accessor<number> {
  if (from !== undefined) return core.depthOf(from);
  if (slot !== null) {
    const depth = slot.depth;
    return (): number => depth;
  }
  return core.deepest();
}

/** A validated search that is a plain record, or undefined for anything else. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

/**
 * The params view behind {@link useParams} and `route.useParams`.
 * @example
 * const params = paramsHook("post"); // inside a component: params.id reads the "post" route param
 * @since 1.0.0
 */
export function paramsHook(from: string | undefined): unknown {
  const core = currentCore("useParams");
  const depth = depthAccessor(core, from, useContext(SlotContext));
  return keyedView<Readonly<Record<string, string | undefined>>>(() => {
    const at = depth();
    return at < 0 ? undefined : core.paramsAt(at)();
  });
}

/**
 * The search view behind {@link useSearch} and `route.useSearch`.
 * @example
 * const search = searchHook("post"); // inside a component: search.page reads the search of the "post" route
 * @since 1.0.0
 */
export function searchHook(from: string | undefined): unknown {
  const core = currentCore("useSearch");
  const depth = depthAccessor(core, from, useContext(SlotContext));
  return keyedView<Readonly<Record<string, unknown>>>(() => {
    const at = depth();
    return at < 0 ? undefined : asRecord(core.searchAt(at)());
  });
}

/**
 * The loader accessor behind {@link useLoaderData} and `route.useLoaderData`.
 * @example
 * const data = loaderHook("post"); // inside a component: data() is the loader data of the "post" route
 * @since 1.0.0
 */
export function loaderHook(from: string | undefined): Accessor<unknown> {
  const core = currentCore("useLoaderData");
  const depth = depthAccessor(core, from, useContext(SlotContext));
  return (): unknown => {
    const at = depth();
    if (at < 0) return undefined;
    const data = core.loaderAt(at)();
    return data instanceof LoaderFailure ? undefined : data;
  };
}

/**
 * Options of the hooks that take a route id.
 * @since 1.0.0
 */
export interface FromOptions<P extends RegisteredPath> {
  /** A route id. Typed by the registered paths. */
  readonly from?: P;
}

/**
 * The params of the route (and its ancestors), as a view with one memo per key: a reader of one
 * key does not rerun when another key changes. Read it inside a component or an effect.
 *
 * @param options `from` names the route. Without it, the route is the one rendering the component.
 * @returns A read-only view of the params, typed by `from` when paths are registered.
 * @example
 * const params = useParams({ from: "/posts/:id" });
 * insert(el, () => `Post ${params.id}`);
 * @since 1.0.0
 */
export function useParams<P extends RegisteredPath = RegisteredPath>(
  options: FromOptions<P> = {},
): ParamsView<P> {
  return paramsHook(options.from) as ParamsView<P>;
}

/**
 * The validated search of the route, as a view with one memo per key. Changing `?page` does not
 * rerun a reader of `?tab`.
 *
 * @param options `from` names the route. Without it, the route is the one rendering the component.
 * @returns A read-only view of the search. Typed as `S` (the route's validator type) when given.
 * @example
 * const search = useSearch<{ page: number }>({ from: "/posts" });
 * @since 1.0.0
 */
export function useSearch<S extends object = Readonly<SearchRecord>>(
  options: { readonly from?: RegisteredPath } = {},
): S {
  return searchHook(options.from) as S;
}

/**
 * The match a component renders under, or the one `from` names. Reactive.
 *
 * @param options `from` names the route.
 * @returns An accessor of the match, or `undefined` when it is not on screen.
 * @example
 * import { useMatch } from "@shadow-js/router";
 * const match = useMatch({ from: "post" });
 * match()?.params; // the params of the "post" match, or undefined when it is not on screen
 * @since 1.0.0
 */
export function useMatch<P extends RegisteredPath = RegisteredPath>(
  options: FromOptions<P> = {},
): Accessor<RenderedMatch | undefined> {
  const core = currentCore("useMatch");
  const depth = depthAccessor(core, options.from, useContext(SlotContext));
  return (): RenderedMatch | undefined => {
    const at = depth();
    return at < 0 ? undefined : core.entryAt(at)();
  };
}

/**
 * Every match on screen, outermost first. Reactive.
 *
 * @returns An accessor of the chain.
 * @example
 * import { useMatches } from "@shadow-js/router";
 * const chain = useMatches();
 * chain().map((match) => match.id); // the ids, outermost first
 * @since 1.0.0
 */
export function useMatches(): Accessor<readonly RenderedMatch[]> {
  const core = currentCore("useMatches");
  return () => core.router.state.matches();
}

/**
 * The loader data of the route the component renders under, or of `from`. Reactive.
 *
 * @param options `from` names the route.
 * @returns An accessor of the data (`undefined` before it loads, or when a loader failed).
 * @example
 * const post = useLoaderData<Post>({ from: "/posts/:id" });
 * @since 1.0.0
 */
export function useLoaderData<T = unknown, P extends RegisteredPath = RegisteredPath>(
  options: FromOptions<P> = {},
): Accessor<T | undefined> {
  const read = loaderHook(options.from);
  return (): T | undefined => read() as T | undefined;
}
