/**
 * The members of an element a fragment navigation (a hash) moves to. A DOM element has all of them; a test
 * double needs only the ones it uses, so each is optional.
 * @internal
 */
export interface FragmentTarget {
  scrollIntoView?(): void;
  focus?(options?: { readonly preventScroll?: boolean }): void;
  hasAttribute?(name: string): boolean;
  setAttribute?(name: string, value: string): void;
  removeAttribute?(name: string): void;
  addEventListener?(
    type: string,
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
}

/**
 * Moves focus to the target of a fragment navigation, the way a browser does. An element with no `tabindex` gets
 * `tabindex="-1"` while it has focus, and loses it on blur, so a non-interactive target never joins the tab order.
 * An element that cannot take focus is left alone.
 *
 * @param target The element the hash names.
 * @internal
 */
export function focusFragmentTarget(target: FragmentTarget): void {
  if (target.focus === undefined) return;
  if (target.hasAttribute?.("tabindex") === false && target.setAttribute !== undefined) {
    target.setAttribute("tabindex", "-1");
    target.addEventListener?.(
      "blur",
      () => {
        target.removeAttribute?.("tabindex");
      },
      { once: true },
    );
  }
  target.focus({ preventScroll: true });
}
