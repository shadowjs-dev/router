# Changelog

## 1.0.4

### Changed

- Released at 1.0.4 with the other packages, which share one version. No change to this package.

## 1.0.3

### Fixed

- `resolveSameOrigin` collapses leading slashes left by dot segments (`/.//host`, `/%2e//x`, `/./\x`) so the result is always a same-origin path, and `unsafeHref` refuses that shape.
- The `useSearchParams` setter merges into the current query, so `setParams({ a: 3 })` on `?a=1&b=2` gives `?a=3&b=2`.
- `useBlocker` returns to `idle` when a later navigation replaces the held one and gets through.
- With a base path and a trailing-slash policy of `always` or `preserve`, a target keeps its slash under the base (the root becomes `/app/`).
- A malformed path (`/%zz`, `/a//b`) commits like an unmatched one: the not-found UI renders and `navigate` moves the URL.
- A native fragment navigation is adopted as a new history entry, so Back and Forward work after a `#fragment` click.
- `invalidate()`, `reload` and `hydrate` wait for a navigation in flight instead of canceling it.
- A percent-encoded byte order mark (`/%EF%BB%BF`) is no longer dropped from a path segment.
- Seeded loader data dated after the client's clock is read as loaded now, so it expires after `staleTime`.

## 1.0.2

### Fixed

- A loader that failed is refetched at the next visit instead of being served as fresh data for the rest of `staleTime`.
- A load that an `invalidate` overtook lands as stale, and a reload no longer joins it.
- `navigate`, `preload`, `invalidate`, `ready` and `href` run untracked, and blockers run their predicates untracked, so an effect that navigates no longer subscribes to what `beforeLoad` or a blocker reads.
- Destroying a router with a visible pending UI no longer leaves its minimum-display timer running.
- A preload no longer leaves a listener on the caller's `AbortSignal`.
- `useSearchParams` reads queries up to the router's `maxSearchLength` instead of the 4096 default.
- A `%2e` or `%2E` dot segment in a navigation target is resolved like `.` and `..`, as the browser does, so the router's location matches the address bar.
- `<A>` is active at the same page written in another case when the router ignores case.
- A prefetch task that throws synchronously is reported to the router's error handler.
- `redirect(to, { replace })` (and the object form's `replace`) is honored by the navigator: `true` replaces the current entry and `false` pushes, whichever the redirected navigation did. Without it the navigation keeps its own mode; the documentation now says so.
- `buildPath` and `buildPathFromParams` throw a `RangeError` for a param value (or splat piece) of `.` or `..`, which a browser collapses into another page.

## 1.0.1

### Changed

- Released at 1.0.1 with the other packages, which share one version. No change to this package.

## 1.0.0

### Added

- Typed routes, parameters and links with one shared client/server matcher.
- A navigation requests the lazy UI chunk of every matched route when its loaders start, so the code and the data arrive together (the cost of a navigation is the slower of the two, not their sum).
- Optional loader caching, search validation, blockers, scroll restoration, head management and error UI.
- Server hydration and independent nested routers with preserved layout depth.
- `prefetch()` (`@shadow-js/router/prefetch`): link prefetch strategies `"none"`, `"intent"`, `"viewport"` and `"render"` per link
  (`<A preload>`) or as a router default, with a first-in first-out concurrency cap, data-saver and slow-network rules,
  idle scheduling, one shared `IntersectionObserver` per document, and warming of the lazy component chunks of the target routes.
  `router.preload(to, { signal })` accepts an `AbortSignal` that releases the preload.
- `@shadow-js/router/prefetch-report`: `createPrefetchReport()` for `prefetch({ report })` records the loads that started, finished or were canceled, the links that were skipped and why, and the navigations that used a prefetched target, with `summary()` (counts and hit rate per strategy) and `summarizePrefetch(events)`.
- View transitions: `viewTransition: false` on `navigate` and `<A viewTransition={false}>` opts one navigation out; where the
  browser supports transition types, transitions are typed `forward`, `back` or `replace`; a commit during a running
  transition applies at once, a superseded commit is dropped, and disposing the router skips the running transition.
- Vite 7.0 and newer are supported next to Vite 8 (peer range `^7.0.0 || ^8.0.0`).
