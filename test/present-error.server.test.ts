import { describe, expect, it } from "vitest";
import { load } from "./support/compile";

/** The markup without hydration keys and region markers, which carry no meaning for these assertions. */
function plain(html: string): string {
  return html.replace(/ data-hk="[^"]*"/g, "").replace(/<!--\[-->|<!--\]-->/g, "");
}

interface PresentModule {
  renderBoom(presentError?: (error: unknown) => unknown): Promise<string>;
}

/**
 * A route whose component throws and whose `error` component shows the message it receives. The
 * server renders it with and without `presentError`.
 */
const APP = `
  import { createRouter, defineRoute, RouterProvider, Outlet, createMemoryHistory } from "@router";
  import { renderToString } from "@shadow-js/web/server";

  const boom = defineRoute("/boom", {
    id: "boom",
    component: () => { throw new Error("secret render detail"); },
    error: ({ error }) => <p class="boom">{error.message}</p>,
  });

  export async function renderBoom(presentError) {
    const router = createRouter({ features: everyFeature(),
      routes: [boom],
      history: createMemoryHistory({ initialEntries: ["/boom"] }),
      ...(presentError === undefined ? {} : { presentError }),
    });
    await router.ready();
    const html = renderToString(() => <RouterProvider router={router}><Outlet /></RouterProvider>);
    router.dispose();
    return html;
  }
`;

describe("presentError: what a route's error component receives", () => {
  it("[SSR-40] by default the error component receives the error that was thrown", async () => {
    const mod = await load<PresentModule>(APP, "ssr");
    const html = await mod.renderBoom();
    expect(plain(html)).toContain('<p class="boom">secret render detail</p>');
  });

  it("[SSR-41] presentError maps the error the error component receives; the original is not shown", async () => {
    const mod = await load<PresentModule>(APP, "ssr");
    const html = await mod.renderBoom((error) => new Error(`public: ${(error as Error).name}`));
    expect(plain(html)).toContain('<p class="boom">public: Error</p>');
    expect(plain(html)).not.toContain("secret render detail");
  });
});
