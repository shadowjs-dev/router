/**
 * End-to-end type flows of the Router: a route's path, search schema and loader meet the link,
 * navigate and hook call sites. Each `@ts-expect-error` marks a call that must not compile. A plain
 * call under a `gap` comment compiles today; if it stops compiling, the gap has closed and the
 * assertion beside it must be moved to a positive check.
 *
 * Compile with `npx tsc -p packages/router/tsconfig.test-types.json --noEmit`.
 */
import {
  A,
  createRouter,
  defineRoute,
  unsafeHref,
  useLoaderData,
  useNavigate,
  useSearch,
} from "@shadow-js/router";
import type { ParamsOf, SearchRecord } from "@shadow-js/router/core";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// ---------------------------------------------------------------------------------------------
// A route with params, a search schema and a loader: each type is read back from the route.
// ---------------------------------------------------------------------------------------------

const postPage = defineRoute("/posts/:id", {
  id: "post-page",
  validateSearch: (search) => ({
    page: Number(search["page"] ?? 1),
    tag: String(search["tag"] ?? ""),
  }),
  loader: ({ params, search }) => ({ id: params.id, page: search.page, tag: search.tag }),
  component: () => null,
});

const filesRoute = defineRoute("/files/*rest", {
  loader: ({ params }) => params.rest,
});

const blogRoute = defineRoute("/blog/:slug?", { component: () => null });

export const pages = createRouter({ routes: [postPage, filesRoute, blogRoute] });

export function ownHelpers(): unknown {
  const params = postPage.useParams();
  type Params = Expect<Equal<typeof params, ParamsOf<"/posts/:id">>>;

  const search = postPage.useSearch();
  type Search = Expect<Equal<typeof search, { page: number; tag: string }>>;
  const page: number = search.page;

  const loaded = postPage.useLoaderData()();
  type Loaded = Expect<Equal<typeof loaded, { id: string; page: number; tag: string } | undefined>>;

  const rest = filesRoute.useParams();
  type Rest = Expect<Equal<typeof rest, { rest: string }>>;

  return [params, page, loaded, rest];
}

// ParamsOf reads optional and splat segments: an optional slot may be absent, a splat is required.
type OptionalAndSplat = Expect<
  Equal<ParamsOf<"/a/:id/:slug?/*rest">, { id: string; slug?: string; rest: string }>
>;
type OnlyRequired = Expect<Equal<ParamsOf<"/users/:id">, { id: string }>>;
// @ts-expect-error the path has no `slug` param, so an extra key is rejected
export const extraKey: ParamsOf<"/posts/:id"> = { id: "1", slug: "x" };
// @ts-expect-error the splat param is required
export const emptySplat: ParamsOf<"/files/*rest"> = {};
export const splatValue: ParamsOf<"/files/*rest"> = { rest: "a/b/c" };

// ---------------------------------------------------------------------------------------------
// navigate: params and search go together and are checked by their value types.
// ---------------------------------------------------------------------------------------------

export const navWithParamsAndSearch = (): Promise<unknown> =>
  pages.navigate("/posts/:id", { params: { id: "7" }, search: { page: 2, tag: "new" } });
export const navSplat = (): Promise<unknown> =>
  pages.navigate("/files/*rest", { params: { rest: "a/b" } });
export const navSearchRemove = (): Promise<unknown> =>
  pages.navigate("/posts/7", { search: { tag: undefined } });
export const navNumberParam = (): Promise<unknown> =>
  // @ts-expect-error a param value is a string, not a number
  pages.navigate("/posts/:id", { params: { id: 7 } });
export const navFunctionSearch = (): Promise<unknown> =>
  // @ts-expect-error a search value is a JSON value, not a function
  pages.navigate("/posts/7", { search: { page: () => 1 } });
// An escape hatch for a runtime href is the only way to pass a string that is not a literal path.
export const navRuntime = (href: string): Promise<unknown> => pages.navigate(unsafeHref(href));

// The router's own `navigate` takes the open options (a feature or a library may pass any target); the typed entry points
// are `useNavigate()` and `<A>` below. gap: an unknown param name compiles through `router.navigate`.
export const navWrongParamName = (): Promise<unknown> =>
  pages.navigate("/posts/:id", { params: { slug: "7" } });
export const navConcreteHref = (): Promise<unknown> => pages.navigate("/posts/7");
// gap: `search` is not checked per route, so an unknown search key compiles (see bugsFound).
export const navUnknownSearchKey = (): Promise<unknown> =>
  pages.navigate("/posts/7", { search: { nope: 1 } });

// ---------------------------------------------------------------------------------------------
// Links: the same checks through the `A` component.
// ---------------------------------------------------------------------------------------------

export function Links(): unknown {
  return (
    <nav>
      <A to="/posts/:id" params={{ id: "7" }} search={{ page: 2, tag: "new" }} activeClass="on">
        one
      </A>
      <A to={unsafeHref("/anything/at/all")}>escape</A>
      {/* @ts-expect-error a param value is a string, not a number */}
      <A to="/posts/:id" params={{ id: 7 }}>
        bad param
      </A>
      {/* @ts-expect-error a search value is a JSON value, not a function */}
      <A to="/posts/7" search={{ page: () => 1 }}>
        bad search
      </A>
      {/* @ts-expect-error a pattern link needs its params */}
      <A to="/posts/:id">no params</A>
      {/* @ts-expect-error "slug" is not a param of "/posts/:id" */}
      <A to="/posts/:id" params={{ slug: "7" }}>
        wrong param name
      </A>
      <A to="/posts/7">a concrete href needs no params</A>
      <A href="/outside">a raw href needs no params</A>
      <A to="/blog/:slug?">optional params may be left out</A>
    </nav>
  );
}

// ---------------------------------------------------------------------------------------------
// Hooks: the top-level hooks type their results only from explicit generics or the route `from`.
// ---------------------------------------------------------------------------------------------

export function Hooks(): unknown {
  const typed = useSearch<{ page: number; tag: string }>({ from: "/posts/:id" });
  const page: number = typed.page;

  const loaded = useLoaderData<{ id: string; page: number; tag: string }>({ from: "/posts/:id" })();
  type Loaded = Expect<Equal<typeof loaded, { id: string; page: number; tag: string } | undefined>>;

  const go = useNavigate();
  void go("/posts/9", { params: { id: "9" }, search: { page: 3 } });
  void go("/posts/:id", { params: { id: "9" } });
  // @ts-expect-error a pattern with params needs its params
  void go("/posts/:id");
  // @ts-expect-error a pattern with params needs its params, even when other options are given
  void go("/posts/:id", { replace: true });
  // @ts-expect-error "slug" is not a param of "/posts/:id"
  void go("/posts/:id", { params: { slug: "9" } });
  // the params of an optional segment are optional
  void go("/blog/:slug?");
  void go("/posts/9");

  // @ts-expect-error "/nope" is not a registered path
  const unknownSearch = useSearch({ from: "/nope" });
  // @ts-expect-error "/nope" is not a registered path
  const unknownLoader = useLoaderData({ from: "/nope" });

  // gap: without an explicit generic the search is the open record, not the route's schema.
  const untyped = useSearch({ from: "/posts/:id" });
  type UntypedSearch = Expect<Equal<typeof untyped, Readonly<SearchRecord>>>;

  // gap: without an explicit generic the loader data is unknown, not the route's loader return.
  const untypedLoaded = useLoaderData({ from: "/posts/:id" })();
  type UntypedLoaded = Expect<Equal<typeof untypedLoaded, unknown>>;

  return [page, loaded, unknownSearch, unknownLoader];
}
