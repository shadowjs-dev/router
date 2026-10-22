/**
 * Compile-time checks for the route pattern types. Vitest does not run this file; `tsc -p
 * packages/router/tsconfig.json` does, so a wrong type fails the typecheck.
 */
import { describe, expectTypeOf, it } from "vitest";
import { buildPath, type ParamsOf } from "../../src/core/path";

describe("ParamsOf", () => {
  it("[P-14] extracts required, optional and splat params with their types", () => {
    expectTypeOf<ParamsOf<"/a/:id/:slug?/*rest">>().toEqualTypeOf<{
      id: string;
      slug?: string;
      rest: string;
    }>();
  });

  it("[P-14] a bare splat is keyed by '*'", () => {
    expectTypeOf<ParamsOf<"/files/*">>().toEqualTypeOf<{ "*": string }>();
  });

  it("[P-14] a pattern without params has no keys", () => {
    expectTypeOf<keyof ParamsOf<"/about/team">>().toEqualTypeOf<never>();
    expectTypeOf<keyof ParamsOf<"/">>().toEqualTypeOf<never>();
  });

  it("[P-14] a trailing slash adds nothing", () => {
    expectTypeOf<ParamsOf<"/users/:id/">>().toEqualTypeOf<{ id: string }>();
  });
});

describe("buildPath types", () => {
  it("[P-15] required params must be supplied", () => {
    expectTypeOf(buildPath<"/users/:id">)
      .parameter(1)
      .toEqualTypeOf<{ id: string }>();
    // @ts-expect-error the required `id` param is missing
    buildPath("/users/:id", {});
  });

  it("[P-15] optional params may be omitted", () => {
    buildPath("/a/:x?", {});
    buildPath("/a/:x?", { x: "1" });
  });
});
