---
name: shadowjs-router
description: "Work with @shadow-js/router. A type-safe router with nested routes, loaders and link prefetching. Use when a project imports it, or when asked to add, configure or debug it."
---

# @shadow-js/router

Version 1.0.1. A type-safe router with nested routes, loaders and link prefetching.

## Where to read more

- @shadow-js/router: https://router.shadowjs.net
- Source and issues: https://github.com/shadowjs-dev/router
- The package README is the full reference for options and behavior; read it before changing a configuration.

## Install

```sh
npm install @shadow-js/router @shadow-js/core @shadow-js/web
```

## Peer dependencies

| Package | Range | Required |
| --- | --- | --- |
| `@shadow-js/core` | `^1.0.1` | yes |
| `@shadow-js/web` | `^1.0.1` | yes |
| `vite` | `^7.0.0 || ^8.0.0` | no |

## Import paths

Import only from these paths. Never from `dist` or `src`: files that are not listed here are private and change without notice.

- `@shadow-js/router`
- `@shadow-js/router/core`
- `@shadow-js/router/vite`
- `@shadow-js/router/scroll`
- `@shadow-js/router/loaders`
- `@shadow-js/router/head`
- `@shadow-js/router/errors`
- `@shadow-js/router/filters`
- `@shadow-js/router/blockers`
- `@shadow-js/router/transitions`
- `@shadow-js/router/prefetch`
- `@shadow-js/router/prefetch-report`
- `@shadow-js/router/relative`
- `@shadow-js/router/announcer`
- `@shadow-js/router/link-status`
- `@shadow-js/router/search`
- `@shadow-js/router/not-found`
- `@shadow-js/router/pending`

## Quick start

```ts
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

## Working rules

- Run `npm run check` before proposing a change; it lints, builds, type-checks and tests.
- Keep a public change documented: TSDoc on every exported symbol, and a CHANGELOG entry.
- To change this repository rather than use the package, read AGENTS.md: the layout, the commands, the rules and how a pull request is reviewed.
