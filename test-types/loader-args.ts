/**
 * Compile-time checks of the loader and beforeLoad arguments, which are typed by the route path.
 */
import { defineRoute } from "@shadow-js/router";
import { redirect } from "@shadow-js/router/core";

export const typedLoader = defineRoute("/users/:name/:tab?", {
  loader: ({ params, search, deps }) => {
    const name: string = params.name;
    const tab: string | undefined = params.tab;
    const seen: unknown = search;
    const extra: unknown = deps;
    return { name, tab, seen, extra };
  },
});

export const withSearch = defineRoute("/list", {
  validateSearch: (search) => ({ page: Number(search["page"] ?? 1), q: String(search["q"] ?? "") }),
  loaderDeps: (search) => ({ page: search.page }),
  loader: ({ search }) => {
    const page: number = search.page;
    const q: string = search.q;
    return { page, q };
  },
});

export const typedRedirect = defineRoute("/moved", {
  beforeLoad: () => {
    throw redirect("/elsewhere");
  },
});

export const pathless = defineRoute("", {
  id: "shell",
  children: [defineRoute("/inside", {})],
});

// A route's loader receives its params, not arbitrary keys.
export const badParam = defineRoute("/users/:name", {
  loader: ({ params }) => {
    // @ts-expect-error `missing` is not a param of "/users/:name"
    return params.missing;
  },
});
