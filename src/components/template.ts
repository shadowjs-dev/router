import { type Accessor, untrack, useMemo } from "@shadow-js/core";
import { useLocation } from "../hooks/navigation";
import { callComponent } from "../internal/render";
import type { RouteComponent } from "../types";

/**
 * Wraps the component of a `_template` file so that it remounts whenever the matched path changes.
 *
 * A layout is built once per route id, so its state survives a navigation between its children. A
 * template is built again on every change of the pathname (a sibling page, a new param, a deeper
 * route), and everything under it is built again with it: the signals it created start from their
 * first value and the previous instance is disposed with everything it owned. A change of search or
 * hash alone keeps the instance, because neither is part of the matched path.
 *
 * The generated route tree calls this around the default export of each `_template` file; it is
 * exported so that a hand-written tree can do the same. The wrapped component renders `<Outlet />`
 * where the matched child goes, as a layout does.
 *
 * Nothing in the router refers to this function, so an app without templates does not bundle it.
 *
 * @param component The template's component.
 * @returns A route component to give a pathless route (`defineRoute("", { id, component, children })`).
 * @example
 * const template = defineRoute("", {
 *   id: "/_template",
 *   component: defineTemplate(() => <section class="enter"><Outlet /></section>),
 *   children: [home, about],
 * });
 * @since 1.0.0
 */
export function defineTemplate(component: RouteComponent): RouteComponent {
  return function Template(): Accessor<unknown> {
    const location = useLocation();
    // The pathname alone is the key: this memo notifies only when the string changes, so a search or hash
    // change (which replaces the location) does not rebuild the template.
    const path = useMemo<string>(() => location.pathname);
    return useMemo<unknown>(() => {
      path();
      // Built untracked, inside this memo's owner: the next change of path disposes the whole instance.
      return untrack(() => callComponent(component));
    });
  };
}
