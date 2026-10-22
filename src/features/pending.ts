import type { PendingCapability, PendingContext, PendingUi } from "../internal/capabilities";
import type { RouterFeature } from "../types";

/**
 * The `pending` feature: the pending UI of a route. While a navigation into a route whose loader data is not cached is
 * in progress (past `pendingMs`), the route's `pending` component replaces what its depth shows. A route that exports
 * `pending` needs this feature in `createRouter({ features })`. The decision lives here, not in the core, so an app
 * without pending UI does not carry it.
 *
 * @example
 * import { pendingUi } from "@shadow-js/router/pending";
 * const router = createRouter({ routes, features: [pendingUi()] });
 * @returns The feature.
 * @since 1.0.0
 */
export function pendingUi(): RouterFeature {
  return {
    id: "pending",
    install(host): void {
      const capability: PendingCapability = { find: findPending, same: samePending };
      host.capabilities.pending = capability;
    },
  };
}

/** The pending UI of a navigation: the deepest route on the way whose `pending` component the target enters with. */
function findPending(context: PendingContext): PendingUi | undefined {
  const depth = divergenceDepth(context.screen, context.matches);
  if (depth === undefined) return undefined;
  if (!context.uncached(depth)) return undefined;
  for (let at = depth; at >= 0; at -= 1) {
    const match = context.matches[at];
    const spec = match === undefined ? undefined : context.specs.get(match.id);
    if (match !== undefined && spec?.pending !== undefined) {
      return { depth, id: match.id, component: spec.pending };
    }
  }
  return undefined;
}

function samePending(a: PendingUi | undefined, b: PendingUi | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.depth === b.depth && a.id === b.id && a.component === b.component;
}

/** The first depth where the screen and the target chains disagree, or undefined when they agree. */
function divergenceDepth(
  current: readonly { readonly id: string }[],
  target: readonly { readonly id: string }[],
): number | undefined {
  for (let at = 0; at < target.length; at += 1) {
    const next = target[at];
    if (next === undefined) return undefined;
    const now = current[at];
    if (now === undefined || now.id !== next.id) return at;
  }
  return undefined;
}
