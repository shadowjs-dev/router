import { describe, expect, it } from "vitest";
import { ROUTE_UI_QUERY, splitRouteModule } from "../../src/vite/split";

const UI = `./post.tsx?${ROUTE_UI_QUERY}`;

const POST = [
  `import { useLoaderData } from "@shadow-js/router";`,
  `import { Chart } from "./chart";`,
  `import "./post.css";`,
  `import { db } from "./db";`,
  `import { z } from "zod";`,
  ``,
  `const schema = z.object({ page: z.number() });`,
  `export const validateSearch = (s) => schema.parse(s);`,
  `export const loader = ({ params }) => db.find(params.id);`,
  `export const head = () => ({ title: "Post" });`,
  `export default function Post() {`,
  `  const data = useLoaderData();`,
  `  return <Chart data={data()} />;`,
  `}`,
  `export function pending() { return <p>loading</p>; }`,
  ``,
].join("\n");

describe("splitRouteModule", () => {
  it("[FRT-90] splits data and UI, with exact halves", () => {
    const result = splitRouteModule(POST, "post.tsx", UI);
    if (!result.split) throw new Error(`not split: ${result.reason}`);
    expect(result.uiExports).toEqual(["default", "pending"]);
    expect(result.main.code).toBe(
      [
        `import { lazy as $$shadowLazy } from "@shadow-js/web";`,
        `import { db } from "./db";`,
        `import { z } from "zod";`,
        ``,
        `const schema = z.object({ page: z.number() });`,
        `export const validateSearch = (s) => schema.parse(s);`,
        `export const loader = ({ params }) => db.find(params.id);`,
        `export const head = () => ({ title: "Post" });`,
        ``,
        `export default $$shadowLazy(() => import("./post.tsx?shadow-route=ui"));`,
        `export const pending = $$shadowLazy(() => import("./post.tsx?shadow-route=ui").then((m) => ({ default: m.pending })));`,
        ``,
      ].join("\n"),
    );
    expect(result.ui.code).toBe(
      [
        `import { useLoaderData } from "@shadow-js/router";`,
        `import { Chart } from "./chart";`,
        `import "./post.css";`,
        ``,
        `export default function Post() {`,
        `  const data = useLoaderData();`,
        `  return <Chart data={data()} />;`,
        `}`,
        `export function pending() { return <p>loading</p>; }`,
        ``,
      ].join("\n"),
    );
  });

  it("[FRT-91] the data half carries no UI-only import (no leak of UI deps into the route chunk)", () => {
    const result = splitRouteModule(POST, "post.tsx", UI);
    if (!result.split) throw new Error("not split");
    expect(result.main.code).not.toContain("./chart");
    expect(result.main.code).not.toContain("post.css");
    expect(result.ui.code).not.toContain("./db");
    expect(result.ui.code).not.toContain("zod");
  });

  it("[FRT-92] a declaration shared by both halves keeps the module whole (state would be duplicated)", () => {
    const code = [
      `const PAGE_SIZE = 10;`,
      `export const loader = () => PAGE_SIZE;`,
      `export default function P() { return PAGE_SIZE; }`,
    ].join("\n");
    const result = splitRouteModule(code, "p.tsx", UI);
    expect(result).toEqual({ split: false, reason: "shared-declaration", detail: ["PAGE_SIZE"] });
  });

  it("[FRT-93] shared imports are fine", () => {
    const code = [
      `import { shared } from "./shared";`,
      `export const loader = () => shared();`,
      `export default function P() { return shared(); }`,
    ].join("\n");
    const result = splitRouteModule(code, "p.tsx", UI);
    expect(result.split).toBe(true);
    if (result.split) {
      expect(result.main.code).toContain(`import { shared } from "./shared";`);
      expect(result.ui.code).toContain(`import { shared } from "./shared";`);
    }
  });

  it("[FRT-94] top-level effects keep the module whole", () => {
    const code = `register(); export const loader = () => 1; export default function P() {}`;
    expect(splitRouteModule(code, "p.tsx", UI)).toMatchObject({
      split: false,
      reason: "side-effects",
    });
  });

  it("[FRT-95] no UI exports means nothing to split", () => {
    expect(splitRouteModule(`export const loader = () => 1;`, "p.ts", UI)).toMatchObject({
      split: false,
      reason: "no-ui",
    });
  });

  it("[FRT-96] export * and a mixed destructuring export keep the module whole", () => {
    expect(
      splitRouteModule(`export * from "./x"; export default function P() {}`, "p.tsx", UI),
    ).toMatchObject({
      split: false,
      reason: "star-export",
    });
    expect(
      splitRouteModule(
        `export const { loader, pending } = make(); export default function P() {}`,
        "p.tsx",
        UI,
      ),
    ).toMatchObject({ split: false, reason: "mixed-export" });
  });

  it("[FRT-97] export forms: export { X as default }, export default expression, error and notFound", () => {
    const code = [
      `function Page() { return 1; }`,
      `const Err = () => 2;`,
      `export { Page as default, Err as error };`,
      `export const notFound = () => 3;`,
      `export const beforeLoad = () => undefined;`,
    ].join("\n");
    const result = splitRouteModule(code, "p.tsx", UI);
    if (!result.split) throw new Error(`not split: ${result.reason}`);
    expect(result.uiExports).toEqual(["default", "error", "notFound"]);
    expect(result.main.code).toContain("export const beforeLoad = () => undefined;");
    expect(result.main.code).not.toContain("function Page");
    expect(result.ui.code).toContain("function Page()");
    expect(result.ui.code).toContain("export { Page as default, Err as error };");
    expect(result.ui.code).not.toContain("beforeLoad");
  });

  it("[FRT-98] type-only syntax stays in both halves and does not create sharing", () => {
    const code = [
      `import type { Post } from "./types";`,
      `interface Props { post: Post }`,
      `export const loader = async (): Promise<Post> => ({}) as Post;`,
      `export default function P(props: Props) { return props; }`,
    ].join("\n");
    const result = splitRouteModule(code, "p.tsx", UI);
    expect(result.split).toBe(true);
  });

  it("[FRT-99] the halves' source maps point at the original file", () => {
    const result = splitRouteModule(POST, "post.tsx", UI);
    if (!result.split) throw new Error("not split");
    expect(result.main.map?.sources).toEqual(["post.tsx"]);
    expect(result.ui.map?.sourcesContent).toEqual([POST]);
  });
});
