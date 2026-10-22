/**
 * Compile-time checks for the typed router API. Nothing here runs: `tsc -p
 * packages/router/tsconfig.test-types.json` must pass, and every `@ts-expect-error` line must be an
 * error (if one stops being an error, the directive itself fails the check).
 */
import {
  A,
  createRouter,
  defineRoute,
  Outlet,
  type Register,
  RouterProvider,
  useLoaderData,
  useNavigate,
  useParams,
  useSearch,
} from "@shadow-js/router";
import type { ParamsOf } from "@shadow-js/router/core";

declare module "@shadow-js/router" {
  interface Register {
    paths: "/" | "/posts/:id" | "/files/*rest" | "/blog/:slug?";
  }
}

const post = defineRoute("/posts/:id", {
  id: "/posts/:id",
  validateSearch: (search) => ({ page: Number(search["page"] ?? 1) }),
  loader: ({ params, search }) => ({ id: params.id, page: search.page + 1 }),
  component: () => null,
});

const router = createRouter({ routes: [post] });

// Positive: registered paths, patterns with params, and hrefs that match a pattern.
export const goodPattern = (): Promise<unknown> =>
  router.navigate("/posts/:id", { params: { id: "7" } });
export const goodHref = (): Promise<unknown> => router.navigate("/posts/7");
export const goodRoot = (): Promise<unknown> => router.navigate("/");
export const goodSplat = (): Promise<unknown> => router.navigate("/files/a/b/c");

// Negative: a path that is not registered.
// @ts-expect-error "/nope" is not a registered path
export const badPath = (): Promise<unknown> => router.navigate("/nope");
// @ts-expect-error a registered pattern needs its params, not a different shape
export const badShape = (): Promise<unknown> => router.navigate("/posts");

export function Links(): unknown {
  return (
    <nav>
      <A to="/posts/:id" params={{ id: "1" }} activeClass="on">
        one
      </A>
      <A to="/">home</A>
      {/* @ts-expect-error "/nope" is not a registered path */}
      <A to="/nope">nope</A>
    </nav>
  );
}

export function Typed(): unknown {
  const params = useParams({ from: "/posts/:id" });
  const id: string = params.id;
  // @ts-expect-error params are strings, not numbers
  const asNumber: number = params.id;
  // @ts-expect-error "/nope" is not a registered path
  const unknownFrom = useParams({ from: "/nope" });
  const search = useSearch<{ page: number }>({ from: "/posts/:id" });
  const page: number = search.page;
  const data = useLoaderData<{ id: string; page: number }>({ from: "/posts/:id" });
  const go = useNavigate();
  void go("/posts/9");
  return [id, asNumber, unknownFrom, page, data];
}

// The route's own helpers are typed by its path and loader.
export const typedParams: ParamsOf<"/posts/:id"> = { id: "3" };
export function ownHelpers(): unknown {
  const params = post.useParams();
  const id: string = params.id;
  // @ts-expect-error the route declares no `slug` param
  const slug: string | undefined = params.slug;
  const loaded = post.useLoaderData();
  const page: number | undefined = loaded()?.page;
  return [id, slug, page, RouterProvider, Outlet];
}

// Register is the augmentation point and is exported.
export type RegisteredPaths = Register["paths"];
const paths: RegisteredPaths = "/";

export { paths };
