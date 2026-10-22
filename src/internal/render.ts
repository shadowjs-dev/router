import { useContext } from "@shadow-js/core";
import { createComponent } from "@shadow-js/web";
import { RouterContext, type RouterCore, SlotContext, type SlotInfo } from "./core";

/**
 * Rendering helpers shared by the components.
 *
 * Router components are written without JSX (the package is compiled by tsdown, not by the
 * ShadowJS compiler), so they build their output from the runtime's own helpers: `createComponent`
 * for component calls and `element` for elements.
 */

/**
 * Calls a component with props, untracked, inside its own owner. Route components take no
 * meaningful props, so the default is an empty object.
 *
 * @internal
 */
export function callComponent(component: (props: never) => unknown, props: object = {}): unknown {
  return createComponent(component as (value: object) => unknown, props);
}

/**
 * Renders `build()` under a slot context: hooks inside it learn their depth and route, and an
 * `<Outlet />` inside it shows the next depth.
 *
 * The content is built from a getter, so it runs inside the provider's own scope (where the
 * context is visible), not in the scope of the caller.
 *
 * @internal
 */
export function withSlot(info: SlotInfo, build: () => unknown): unknown {
  return SlotContext({
    value: info,
    get children(): unknown {
      return build();
    },
  });
}

/**
 * The router the calling component renders under.
 *
 * @throws TypeError when called outside a `RouterProvider`. The name is used in the message.
 * @internal
 */
export function currentCore(hook: string): RouterCore {
  const core = useContext(RouterContext);
  if (core === null)
    throw new TypeError(
      __DEV__ ? `${hook}() must be used inside <RouterProvider>` : "SHADOW_OUTSIDE_PROVIDER",
    );
  return core;
}
