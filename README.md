<p align="center"><img src="https://raw.githubusercontent.com/shadowjs-dev/router/main/.github/banner.png" alt="ShadowJS" width="100%"></p>

# @shadow-js/router

[![npm](https://img.shields.io/npm/v/@shadow-js/router.svg)](https://www.npmjs.com/package/@shadow-js/router)
[![CI](https://github.com/shadowjs-dev/router/actions/workflows/ci.yml/badge.svg)](https://github.com/shadowjs-dev/router/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](https://github.com/shadowjs-dev/router/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue.svg)](https://www.typescriptlang.org/)

A typed client router for ShadowJS. Routes are plain objects built with `defineRoute`; the router
matches them against a history, runs `beforeLoad` hooks and loaders, and renders the matched chain
through `<Outlet />`. Params, search and loader data are read through hooks that update only the
keys that changed.

The package has two layers. `@shadow-js/router` is the reactive layer (router instance, components,
hooks). `@shadow-js/router/core` is the pure core underneath it: path patterns, matching, three
history implementations, the navigation state machine and the loader cache, with no DOM and no
reactivity.

## Install

```sh
npm install @shadow-js/router
```

`@shadow-js/core` and `@shadow-js/web` are peer dependencies. ShadowJS 1.0.0 is not on npm yet.
Until it is published, install it from a local checkout of this repository.

## Usage

### Matching and building paths with the core

`@shadow-js/router/core` is plain functions. A route is `{ id, path?, children? }`; `matchRoutes`
returns the chain from the root to the leaf, with the params declared along the way. `buildPath`
is the inverse, with the params typed by the pattern.

```ts title="matching.ts" run output="home\nposts > post\n{\"id\":\"7\"}\n/posts/a%20b\nnone"
import { buildPath, matchRoutes } from "@shadow-js/router/core";

const routes = [
  { id: "home", path: "/" },
  { id: "posts", path: "/posts", children: [{ id: "post", path: ":id" }] },
];

const ids = (pathname: string): string =>
  matchRoutes(routes, pathname)
    .map((match) => match.id)
    .join(" > ") || "none";

console.log(ids("/"));
console.log(ids("/posts/7"));
console.log(JSON.stringify(matchRoutes(routes, "/posts/7").at(-1)?.params));
console.log(buildPath("/posts/:id", { id: "a b" }));
console.log(ids("/missing"));
```

### A router with a layout, links and a loader

`createRouter` takes the routes and, optionally, a history. Without one it uses the browser
history of the global `window`, or an in-memory history when there is no window. Here the history
is explicit, so the example runs without a browser. `RouterProvider` makes the router available to
the subtree and loads the current location once it is mounted; on the server, await
`router.ready()` before rendering instead.

```tsx title="app.tsx" run output="Home|Post 7|Welcome\n/\nPost 7 (id 7)\n/posts/7"
import { flushSync } from "@shadow-js/core";
import {
  A,
  createMemoryHistory,
  createRouter,
  defineRoute,
  Outlet,
  RouterProvider,
  useLoaderData,
  useParams,
} from "@shadow-js/router";
import { loaderCache } from "@shadow-js/router/loaders";
import { render } from "@shadow-js/web";

function Layout() {
  return (
    <div>
      <nav>
        <A to="/">Home</A>|<A to="/posts/:id" params={{ id: "7" }}>Post 7</A>
      </nav>
      <Outlet />
    </div>
  );
}

function Post() {
  const params = useParams({ from: "/posts/:id" });
  const post = useLoaderData<{ title: string }>({ from: "/posts/:id" });
  return (
    <h1>
      {post()?.title} (id {params.id})
    </h1>
  );
}

const home = defineRoute("/", { component: () => <p>Welcome</p> });
const post = defineRoute("/posts/:id", {
  loader: ({ params }) => ({ title: `Post ${params.id}` }),
  component: Post,
});
const layout = defineRoute("", { id: "layout", component: Layout, children: [home, post] });

const router = createRouter({
  routes: [layout],
  history: createMemoryHistory({ initialEntries: ["/"] }),
  features: [loaderCache()],
});

const container = document.createElement("div");
const dispose = render(
  () => (
    <RouterProvider router={router}>
      <Outlet />
    </RouterProvider>
  ),
  container,
);

await router.ready();
flushSync();
const links = [...container.querySelectorAll("a")].map((a) => a.textContent).join("|");
console.log(`${links}|${container.querySelector("p")?.textContent}`);
console.log(router.state.location()?.pathname);

await router.navigate("/posts/7");
flushSync();
console.log(container.querySelector("h1")?.textContent);
console.log(router.state.location()?.pathname);

dispose();
router.dispose();
```

`navigate` resolves with an outcome and never throws for a redirect, a not-found or a canceled
navigation. A loader or `beforeLoad` throws `redirect(to)` or `notFound()` to steer the
navigation. `<A>` renders a real `<a href>`, navigates on a plain click, and by default preloads on
hover, focus or touch.

## File routes

`@shadow-js/router/vite` turns a folder of files into the route tree that `defineRoute` builds by hand. It is the
build-time half of Dusk and runs in Node only; nothing from it is bundled into an app. The file-name grammar
is a pure function, so it can be tried without a project:

```ts title="file-routes.ts" run target="ssr" output="index.tsx -> /\nposts/[id].tsx -> /posts/:id\ndocs/[...rest].tsx -> /docs/*rest\n(shop)/cart.tsx -> /cart\n_layout.tsx -> layout of /\n-helpers.ts -> ignored"
import { parseRouteFile, patternOf } from "@shadow-js/router/vite";

for (const file of [
  "index.tsx",
  "posts/[id].tsx",
  "docs/[...rest].tsx",
  "(shop)/cart.tsx",
  "_layout.tsx",
  "-helpers.ts",
]) {
  const parsed = parseRouteFile(file);
  if (parsed.status !== "ok") {
    console.log(`${file} -> ignored`);
    continue;
  }
  const segments = parsed.leaf === undefined ? parsed.dirs : [...parsed.dirs, parsed.leaf];
  console.log(`${file} -> ${parsed.layout ? "layout of " : ""}${patternOf(segments)}`);
}
```

`index.tsx` is the index of its folder, `[id]` a param, `[[id]]` an optional param, `[...rest]` a splat (last segment
only), `(group)/` a folder that adds no URL segment, `_layout.tsx` the layout of its folder, and a name that starts with
`-` or `.` is ignored. A file with HTTP-method exports and no default export is an API route. `scanRoutes` builds the
tree and reports every conflict with the files involved (`RouteScanError`), `generateRouteTree` writes
`routeTree.gen.ts` including the `Register` augmentation that types `A`, `navigate` and the hooks, and `shadowRouter()`
is the Vite plugin that scans, generates, watches and splits each route module into its data half and its lazily
loaded UI half.

## API

Entry `@shadow-js/router`. The exports are:

### Routes and the router

| Export | Description |
| --- | --- |
| `defineRoute` | Builds a typed route: path, component, `pending`, `error`, `notFound`, `validateSearch`, `beforeLoad`, `loader`, `head`, `children`. |
| `createRouter` | Creates a router; `navigate`, `preload`, `invalidate`, `ready`, `href`, `dehydrate`, `hydrate`, `dispose`, and live `state` accessors. |
| `RouterProvider` | Makes a router available to a subtree and loads the current location. |
| `Outlet` | Renders the child route of the current depth. |
| `A`, `Navigate` | A client-side anchor with preloading (`preload`: `"intent"`, `"viewport"`, `"render"`, `"none"`), an active class and a per-link `viewTransition={false}`; a component that navigates when it renders. |
| `redirect`, `notFound`, `isRedirect`, `isNotFound` | Control-flow signals thrown from `beforeLoad` and loaders, and their guards. |

### Hooks

| Export | Description |
| --- | --- |
| `useParams`, `useSearch`, `useLoaderData` | Params, validated search and loader data of the route a component renders under, or of `from`. |
| `useMatch`, `useMatches` | The rendered match, or the whole chain. |
| `useRouter`, `useNavigate`, `useLocation`, `useHref` | The router, a bound navigate function, the current location, a resolved href. |
| `useNavigation` | State of the navigation in flight, for pending indicators. |
| `useBlocker`, `useBeforeLeave` | Hold or observe transitions, for unsaved-changes prompts. From `@shadow-js/router/blockers`; the router needs `blockers()` in `features`. |

### Features

A router is built with the features it uses, each imported from its own subpath and passed in
`createRouter({ features })`. A feature you do not import is not in your bundle.

| Import | Feature | Needed by |
| --- | --- | --- |
| `@shadow-js/router/scroll` | `scrollRestoration()` | scroll per history entry (optional) |
| `@shadow-js/router/loaders` | `loaderCache(options?)` | a route with `loader`; `staleTime`, `preloadStaleTime`, `gcTime`, `maxEntries` |
| `@shadow-js/router/head` | `headManagement()` | a route with `head` |
| `@shadow-js/router/errors` | `errorBoundaries()` | a route with `error` |
| `@shadow-js/router/filters` | `matchFilters()` | a route with `matchFilters` |
| `@shadow-js/router/search` | `searchValidation()` | a route with `validateSearch` |
| `@shadow-js/router/not-found` | `notFoundUi()` | a route with `notFound` |
| `@shadow-js/router/pending` | `pendingUi()` | a route with `pending` |
| `@shadow-js/router/blockers` | `blockers()`, `useBlocker`, `useBeforeLeave` | blocking transitions |
| `@shadow-js/router/transitions` | `viewTransitions()` | view transitions on commit, typed `forward` / `back` / `replace`, with `viewTransition: false` to opt out (optional) |
| `@shadow-js/router/prefetch` | `prefetch(options?)` | link prefetch strategies `"none"`, `"intent"`, `"viewport"`, `"render"` with a concurrency cap, data-saver rules and lazy-chunk warming; the `"render"` and `"none"` link strategies |
| `@shadow-js/router/relative` | `relativeLinks()` | a `relative` link or navigation |

A route that needs a feature the router does not have is refused by `createRouter` with a `TypeError` that
names the feature.

### Histories and data transfer

| Export | Description |
| --- | --- |
| `createBrowserHistory`, `createHashHistory`, `createMemoryHistory` | History over `window.history`, the URL fragment, or memory. |
| `serializeHydrationData`, `parseHydrationData` | Loader data as text for an inline script, and back. |

The package also exports the types `Router`, `RouterOptions`, `RouteOptions`, `RouteDefinition`,
`RouteArgs`, `LoaderArgs`, `RenderedMatch`, `RouterState`, `NavigateToOptions`, `HrefOf`,
`ParamsView`, `Register`, `RegisteredPath`, `HydrationData`, `BlockerState`, `RouterClock` and
`RouterWindow`. Declare your paths once with `declare module "@shadow-js/router"` and the
`Register` interface to make `<A to>` and `navigate` accept only those paths.

### Subpath entries

| Entry | Contents |
| --- | --- |
| `@shadow-js/router/vite` | `shadowRouter`, `scanRoutes`, `generateRouteTree`, `parseRouteFile`, `patternOf`, `RouteScanError`, and the syntax-tree helpers Dusk builds its transforms on (`parseModule`, `pruneModule`, `splitRouteModule`). Node only. |
| `@shadow-js/router/core` | `matchRoutes`, `createMatcher`, `findConflicts`, `parsePattern`, `buildPath`, `canonicalizePathname`, `parseSearch`, `stringifySearch`, `mergeSearch`, the three history factories, `createNavigator`, `createLoaderCache`, `isSafeNavigationTarget`, `resolveSameOrigin`, and their types. |

## Links

- [`@shadow-js/web`](https://shadowjs.net/reference/web/), [`@shadow-js/core`](https://shadowjs.net/reference/core/)

## Dependencies

- Runtime `magic-string` `^1.4.3`: edits route modules during the build (`src/vite/prune.ts`).
- Runtime `oxc-parser` `0.153.0`: parses route modules to read their exports (`src/vite/ast.ts`).
- Peers: `@shadow-js/core` and `@shadow-js/web` `^1.0.0`: the runtime and rendering routes use.
- Optional peers: `vite` `^8.0.0`, needed only when using the Vite plugin.

## Types

- Names from the root: `RouteDefinition`, `LoaderArgs`, `RegisteredPath`.
- Type tests in `test-types/` run with `npx tsc -p tsconfig.test-types.json`.

## Support

- Node.js `>=22.12.0`. ESM only: use `import`; `require` is not supported.
- Browsers: current evergreen releases.
- Versioning: every `@shadow-js/*` package releases together at one version. Upgrade them as one set.
- Documentation: [ShadowJS documentation](https://shadowjs.net).

## Using, changing and contributing

- **Use the package** (a person or a coding agent that builds with it): this README, and [SKILL.md](SKILL.md), the short page an agent reads first.
- **Change the package** (fix a bug, add a feature): [AGENTS.md](AGENTS.md) says how the repository is laid out, how to implement and test a change, and how a pull request is reviewed. It is written for people and coding agents alike.
- **Take part**: [CONTRIBUTING.md](CONTRIBUTING.md) is the short guide; [SECURITY.md](SECURITY.md) is for vulnerabilities.
