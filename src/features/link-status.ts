import { createContext, useContext, useSignal } from "@shadow-js/core";
import type { LinkStatusCapability } from "../internal/capabilities";
import type { RouterFeature } from "../types";

/**
 * What the content of an `<A>` sees: whether the navigation that link started is still pending. Read it with
 * {@link useLinkPending}.
 * @since 1.0.0
 */
export interface LinkPending {
  /**
   * True from the click until the navigation commits or is canceled. Only the last clicked link is pending. Read
   * it where it is rendered: the value is reactive.
   */
  readonly pending: boolean;
}

/** Outside any link: nothing is pending. */
const NOT_IN_LINK: LinkPending = Object.freeze({ pending: false });
const LinkContext = createContext<LinkPending>(NOT_IN_LINK, { name: "LinkPending" });

/**
 * The pending state of the `<A>` the calling component is inside of (mirrors Next's `useLinkStatus`). Without the
 * `link-status` feature, or outside a link, `pending` is always false.
 *
 * @returns The link's pending state.
 * @example
 * function Spinner() {
 *   const link = useLinkPending();
 *   return <span hidden={!link.pending}>loading</span>;
 * }
 * <A to="/reports"><Spinner /> Reports</A>
 * @since 1.0.0
 */
export function useLinkPending(): LinkPending {
  return useContext(LinkContext);
}

/**
 * The `link-status` feature: the links that navigate show, to their children, whether their navigation is still
 * pending (see {@link useLinkPending}). A new click replaces the pending link, and a navigation that is superseded or
 * fails clears its link. An app that does not pass this feature pays nothing for it: `<A>` checks for it once per
 * render.
 *
 * @example
 * import { linkStatus, useLinkPending } from "@shadow-js/router/link-status";
 * const router = createRouter({ routes, features: [linkStatus()] });
 * @returns The feature.
 * @since 1.0.0
 */
export function linkStatus(): RouterFeature {
  return {
    id: "link-status",
    install(host): void {
      // Each click makes a new ticket, so a superseded navigation can tell that it no longer owns the pending state.
      const [pendingTicket, setPendingTicket] = useSignal<{ readonly link: object } | undefined>(
        undefined,
      );
      const capability: LinkStatusCapability = {
        track(key: object, navigation: Promise<unknown>): void {
          const ticket = { link: key };
          setPendingTicket(ticket);
          void navigation.finally(() => {
            if (pendingTicket() === ticket) setPendingTicket(undefined);
          });
        },
        inside(key: object, children: () => unknown): unknown {
          const value: LinkPending = {
            get pending(): boolean {
              return pendingTicket()?.link === key;
            },
          };
          return LinkContext({
            value,
            get children(): unknown {
              return children();
            },
          });
        },
      };
      host.capabilities.linkStatus = capability;
    },
  };
}
