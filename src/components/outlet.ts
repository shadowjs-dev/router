import { type Accessor, onCleanup, untrack, useContext, useMemo } from "@shadow-js/core";
import type { ErrorBoundaryProps } from "@shadow-js/web";
import { type RouterCore, type Slot, SlotContext, type SlotInfo } from "../internal/core";
import { LoaderFailure } from "../internal/failure";
import { callComponent, currentCore, withSlot } from "../internal/render";
import type { RenderedMatch, RouteErrorProps, RouteSpec } from "../types";

/**
 * The children type a boundary takes. The content a route builds is a valid child at runtime; naming
 * the type from the boundary's own props keeps this file in step with the runtime's declarations.
 */
type BoundaryChildren = NonNullable<ErrorBoundaryProps["children"]>;

/**
 * Renders the child route of the current depth.
 *
 * The depth is one more than the nearest route above (the root Outlet is depth 0). The Outlet
 * rebuilds only when the route at its depth changes id, so a layout keeps its state across
 * navigations between its children. A route that leaves the match list is disposed with everything
 * it created. A route's `error` needs the `errors` feature and its `head` the `head` feature; the
 * router refuses either one when the feature is missing.
 *
 * @returns An accessor of the content, to be inserted where the outlet sits.
 * @example
 * const layout = () => <main><Outlet /></main>;
 * @since 1.0.0
 */
export function Outlet(): Accessor<unknown> {
  const core = currentCore("Outlet");
  const parent = useContext(SlotContext);
  const depth = parent === null ? 0 : parent.depth + 1;
  const slot = core.slotAt(depth);
  return useMemo<unknown>(() => {
    const current = slot();
    return untrack(() => renderSlot(core, current));
  });
}

/** The content of one slot, built inside the owner the Outlet's memo provides. */
function renderSlot(core: RouterCore, slot: Slot): unknown {
  if (slot.kind === "none") return null;
  if (slot.kind === "pending") {
    const pending = slot.pending;
    if (pending === undefined) return null;
    const info: SlotInfo = { depth: slot.depth, routeId: undefined, kind: "pending" };
    return withSlot(info, () => callComponent(pending));
  }
  const entry = slot.entry;
  if (entry === undefined) return null;
  const spec = core.specOf(entry.id);
  if (spec === undefined) return null;
  const info: SlotInfo = { depth: slot.depth, routeId: entry.id, kind: entry.kind };
  const body = (): unknown => withSlot(info, () => routeBody(core, slot.depth, entry, spec));
  const error = spec.error;
  if (entry.kind === "route" && error !== undefined) {
    const boundary = core.capabilities.boundary;
    if (boundary === undefined) return body();
    return boundary({
      // The boundary's error, as the router is configured to show it (see RouterOptions.presentError).
      fallback: (failure: unknown, reset: () => void): unknown =>
        errorContent(core, error, core.presentError(failure), reset),
      get children(): BoundaryChildren {
        return body() as BoundaryChildren;
      },
    });
  }
  return body();
}

/**
 * The route's own content. A loader failure is thrown here, which is inside the error boundary (when
 * the route has one), so the error component receives it.
 */
function routeBody(
  core: RouterCore,
  depth: number,
  entry: RenderedMatch,
  spec: RouteSpec,
): unknown {
  if (entry.kind === "notFound") {
    // The not-found UI is the leaf of its chain: its own metadata (`notFoundMetadata`) applies, as on the server.
    core.capabilities.metadata?.(core, depth);
    const notFound = spec.notFound;
    return notFound === undefined ? null : callComponent(notFound);
  }
  if (entry.loaderData instanceof LoaderFailure) throw entry.loaderData.error;
  const head = spec.head;
  if (head !== undefined) core.capabilities.head?.(core, depth, head);
  core.capabilities.metadata?.(core, depth);
  const component = spec.component;
  if (component !== undefined) return callComponent(component);
  return Outlet();
}

/**
 * The error component of a route. It is registered for reset, so the next navigation rebuilds the
 * route, and the registration is dropped when the fallback goes away.
 */
function errorContent(
  core: RouterCore,
  render: (props: RouteErrorProps) => unknown,
  error: unknown,
  reset: () => void,
): unknown {
  onCleanup(core.registerReset(reset));
  // Revalidates the loaders on screen, as `invalidate()` does (a reload runs them all), then rebuilds the boundary.
  const retry = (): void => {
    void core.router.invalidate().finally(reset);
  };
  return callComponent(render, { error, reset, retry });
}
