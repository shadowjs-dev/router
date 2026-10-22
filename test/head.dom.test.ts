import { describe, expect, it } from "vitest";
import { host, settle } from "./support/app";
import { load } from "./support/compile";
import { createFakeClock } from "./support/fake-clock";
import { RouterTestWindow } from "./support/router-window";

interface HeadModule {
  start(
    host: HTMLElement,
    win: RouterTestWindow,
    clock: unknown,
  ): { navigate(to: string): Promise<unknown>; dispose(): void };
  post: { useLoaderData(): () => unknown };
}

const APP = `
  import { createRouter, defineRoute, RouterProvider, Outlet, useParams } from "@router";
  import { render } from "@shadow-js/web";
  export const post = defineRoute("/posts/:id", {
    id: "post",
    loader: ({ params }) => ({ title: "Post " + params.id }),
    head: ({ params, loaderData }) => ({ tag: "title", children: (loaderData?.title ?? "loading") + " #" + params.id }),
    component: () => <p class="post">post</p>,
  });
  export const about = defineRoute("/about", {
    id: "about",
    head: () => ({ tag: "title", children: "About us" }),
    component: () => <p class="about">about</p>,
  });
  export function start(host, win, clock) {
    const router = createRouter({ features: everyFeature(), routes: [post, about], window: win, clock });
    render(() => <RouterProvider router={router}><Outlet /></RouterProvider>, host);
    return router;
  }
`;

async function app(): Promise<HeadModule> {
  return load<HeadModule>(APP);
}

describe("route head", () => {
  it("[HEAD-01 I-M3] the route head sets the document title once the route renders", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/posts/4"), createFakeClock(0));
    await settle();
    expect(document.title).toBe("Post 4 #4");
    router.dispose();
  });

  it("[HEAD-02 I-M3] a navigation to another route with a head replaces the title", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/posts/4"), createFakeClock(0));
    await settle();
    await router.navigate("/about");
    await settle();
    expect(document.title).toBe("About us");
    router.dispose();
  });

  it("[HEAD-03 I-M3] a param change on the same route updates the title reactively", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/posts/4"), createFakeClock(0));
    await settle();
    await router.navigate("/posts/5");
    await settle();
    expect(document.title).toBe("Post 5 #5");
    router.dispose();
  });

  it("[HEAD-04 I-M3] a route without a head leaves the title as it was", async () => {
    const mod = await app();
    const root = host();
    const router = mod.start(root, new RouterTestWindow("/about"), createFakeClock(0));
    await settle();
    const title = document.title;
    expect(title).toBe("About us");
    router.dispose();
  });
});
