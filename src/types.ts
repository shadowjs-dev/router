export type Split<S extends string> = S extends ""
  ? []
  : S extends `/${infer R}`
    ? Split<R>
    : S extends `${infer A}/${infer B}`
      ? [A, ...Split<B>]
      : [S];

type SegParam<S extends string> = S extends `:${infer P}`
  ? P extends `${infer Name}?`
    ? Name
    : P
  : S extends "*"
    ? "*"
    : never;

type CollectParams<
  Segs extends string[],
  Acc extends Record<string, string> = {},
> = Segs extends [infer H, ...infer T]
  ? H extends string
    ? T extends string[]
      ? SegParam<H> extends "*"
        ? CollectParams<T, Acc & { splat: string }>
        : SegParam<H> extends string
          ? CollectParams<T, Acc & { [K in SegParam<H>]: string }>
          : CollectParams<T, Acc>
      : Acc
    : Acc
  : Acc;

export type PathParams<P extends string> = CollectParams<Split<P>>;

export type ComponentType<P = {}> = (props: P) => unknown;

export type Transition =
  | "none"
  | "fade"
  | {
      enter?: (el: HTMLElement) => void | Promise<void>;
    };

export type NavigateOptions<T = unknown> = {
  replace?: boolean;
  state?: T;
};

export type ScrollContext = {
  action: "PUSH" | "REPLACE" | "POP";
  from: { pathname: string; search: string };
  to: { pathname: string; search: string };
};

export type ScrollBehavior = "auto" | "top" | ((ctx: ScrollContext) => void);

export type RouteConfig<P extends string = string, T = unknown> = {
  path: P;
  component?: ComponentType<{}>;
  layout?: ComponentType<{ children?: unknown }>;
  children?: RouteConfig<string, T>[];
  redirect?: string | ((params: Record<string, string>) => string);
  transition?: Transition; // per-route transition (leaf)
};
