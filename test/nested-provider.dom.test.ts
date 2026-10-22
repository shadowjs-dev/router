import { createComponent, hydrate, render } from "@shadow-js/web";
import { renderToString } from "@shadow-js/web/server";
import { describe, expect, it } from "vitest";
import type { Router } from "../src/types";
import { load } from "./support/compile";

const SOURCE = `
import { createMemoryHistory, createRouter, defineRoute, Outlet, RouterProvider } from "@router";
import { render } from "@shadow-js/web";
export let ready;
export let stop;
export let inner;
const home = defineRoute("/", { component: () => <h3>Home</h3> });
function mount(el) {
  if (el === undefined) return;
  inner = createRouter({ routes: [home], history: createMemoryHistory({ initialEntries: ["/"] }) });
  ready = inner.ready();
  stop = render(() => <RouterProvider router={inner}><Outlet /></RouterProvider>, el);
}
const outerHome = defineRoute("/", {
  component: () => <section><div class="nested" ref={mount} /><p class="sibling">Sibling</p></section>,
});
export const outer = createRouter({ routes: [outerHome], history: createMemoryHistory({ initialEntries: ["/"] }) });
export function App() {
  return <RouterProvider router={outer}><Outlet /></RouterProvider>;
}
`;

interface Mod {
  App: () => unknown;
  ready: Promise<unknown>;
  stop: () => void;
  inner: Router;
  outer: Router;
}

describe("nested router providers", () => {
  it("[RTR-NEST-02] re-providing the same router inside a layout preserves its child outlet depth", async () => {
    const module = await load<{
      make(): { App: () => unknown; router: Router; calls: { parent: number } };
    }>(`
      import { createMemoryHistory, createRouter, defineRoute, Outlet, RouterProvider } from "@router";
      export function make() {
        const calls = { parent: 0 };
        function Parent() {
          calls.parent += 1;
          if (calls.parent > 2) throw new Error("the provider restarted its layout");
          return <RouterProvider router={router}><Outlet /></RouterProvider>;
        }
        const router = createRouter({
          history: createMemoryHistory(),
          routes: [defineRoute("", { id: "same-layout", component: Parent, children: [defineRoute("/", { component: () => <p>Child route</p> })] })],
        });
        const App = () => <RouterProvider router={router}><Outlet /></RouterProvider>;
        return { App, router, calls };
      }
    `);
    const app = module.make();
    const host = document.createElement("div");
    let stop: (() => void) | undefined;
    try {
      await app.router.ready();
      stop = render(() => createComponent(app.App, {}), host);
      expect(host.textContent).toBe("Child route");
      expect(app.calls.parent).toBe(1);
    } finally {
      stop?.();
      app.router.dispose();
    }
  });

  it.each(["render", "hydrate"] as const)(
    "[RTR-NEST-01] %s starts a router mounted from a route ref at its own root depth",
    async (mode) => {
      const server = await load<Mod>(SOURCE, "ssr");
      const client = await load<Mod>(SOURCE, "dom");
      const host = document.createElement("div");
      await server.outer.ready();
      host.innerHTML =
        mode === "hydrate" ? renderToString(() => createComponent(server.App, {})) : "";
      document.body.append(host);
      const sibling = host.querySelector(".sibling");
      let stop: (() => void) | undefined;
      try {
        await client.outer.ready();
        stop = (mode === "hydrate" ? hydrate : render)(() => createComponent(client.App, {}), host);
        await client.ready;
        expect(host.querySelector(".nested")?.textContent).toBe("Home");
        if (mode === "hydrate") expect(host.querySelector(".sibling")).toBe(sibling);
        expect(host.querySelectorAll("[data-hk]")).toHaveLength(0);
        client.stop();
        expect(host.querySelector(".nested")?.childNodes).toHaveLength(0);
        expect(host.querySelector(".sibling")?.textContent).toBe("Sibling");
      } finally {
        client.stop?.();
        client.inner?.dispose();
        client.outer.dispose();
        server.outer.dispose();
        stop?.();
        host.remove();
      }
    },
  );
});
