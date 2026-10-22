import { isServer, onMount, useContext } from "@shadow-js/core";
import { coreOf } from "../create-router";
import { RouterContext, SlotContext } from "../internal/core";
import type { Router } from "../types";

/**
 * Props of {@link RouterProvider}.
 * @since 1.0.0
 */
export interface RouterProviderProps {
  /** The router, from {@link createRouter}. */
  readonly router: Router;
  /** Usually an `<Outlet />`. */
  readonly children?: unknown;
}

/**
 * Makes a router available to the subtree and loads the current location. In the browser the
 * first load starts once the subtree is mounted. On the server nothing starts here: await
 * `router.ready()` before rendering, so the markup has its data.
 *
 * @param props See {@link RouterProviderProps}.
 * @returns The provided children (an accessor, as every ShadowJS component result).
 * @throws TypeError when `router` did not come from `createRouter`.
 * @example
 * render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, document.body);
 * @since 1.0.0
 */
export function RouterProvider(props: RouterProviderProps): unknown {
  const core = coreOf(props.router);
  const parent = useContext(RouterContext);
  if (!isServer) {
    onMount(() => {
      void props.router.ready();
    });
  }
  return RouterContext({
    value: core,
    get children(): unknown {
      // A new router owns its outlet depths, even when mounted inside another router's route.
      if (parent === core) return props.children;
      return SlotContext({
        value: null,
        get children(): unknown {
          return props.children;
        },
      });
    },
  });
}
