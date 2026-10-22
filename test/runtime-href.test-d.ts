import { type HrefOf, unsafeHref } from "../src/index";

/*
 * [RH-04] Typed navigation takes a RuntimeHref next to the registered patterns, and still refuses a
 * plain string that matches no registered pattern. tsc (packages/router) checks this file.
 */
type Registered = HrefOf<"/posts/:id">;
export const accepted: Registered = unsafeHref("/x");
// @ts-expect-error a plain string is not a registered page or a RuntimeHref
export const refused: Registered = "/x";
