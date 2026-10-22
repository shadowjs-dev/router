import { useContext } from "@shadow-js/core";
import { RouterContext } from "../internal/core";
import type { Router } from "../types";

/**
 * The router the calling component renders under, or `undefined` outside a `RouterProvider`. Unlike
 * {@link useRouter} it does not throw, so a component that can run with or without a router (a form
 * that enhances itself, a hook that reads per-page state) can ask.
 *
 * @returns The router, or `undefined`.
 * @example
 * const router = useOptionalRouter();
 * if (router !== undefined) router.navigate("/");
 * @since 1.0.0
 */
export function useOptionalRouter(): Router | undefined {
  const core = useContext(RouterContext);
  return core === null ? undefined : core.router;
}
