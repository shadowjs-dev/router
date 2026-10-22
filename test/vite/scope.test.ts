import { describe, expect, it } from "vitest";
import { parseModule } from "../../src/vite/ast";
import { freeReferences } from "../../src/vite/scope";

/** Free references of the whole program (every statement), sorted. */
function free(code: string, file = "x.tsx"): string[] {
  const { body } = parseModule(code, file);
  const refs = new Set<string>();
  for (const statement of body) for (const name of freeReferences(statement)) refs.add(name);
  return [...refs].sort();
}

describe("freeReferences", () => {
  it.each<[string, string, string[]]>([
    ["plain expression", "a + b;", ["a", "b"]],
    ["arrow params shadow", "const f = (x) => x + y;", ["y"]],
    [
      "default param sees earlier params and outer names",
      "function f(a, b = a + c) { return b + d; }",
      ["c", "d"],
    ],
    ["block scoping", "{ const a = 1; a + b; }", ["b"]],
    ["block binding does not leak", "{ const a = 1; } a;", ["a"]],
    ["let in for head", "for (let i = 0; i < n; i++) { i; }", ["n"]],
    ["var hoists to the function", "function f() { if (x) { var a = 1; } return a; }", ["x"]],
    [
      "var hoists out of nested blocks only inside the function",
      "if (x) { var a = 1; } a;",
      ["a", "x"],
    ],
    ["catch param", "try { f(); } catch (e) { g(e); }", ["f", "g"]],
    ["destructured catch param", "try {} catch ({ message }) { log(message); }", ["log"]],
    [
      "named function expression binds its own name",
      "const f = function g() { return g + h; };",
      ["h"],
    ],
    ["class name inside the class", "class A { m() { return A; } }", []],
    [
      "class heritage and members",
      "class A extends B { static x = c; m() { return d; } [k]() {} }",
      ["B", "c", "d", "k"],
    ],
    ["member property is not a reference", "o.p.q;", ["o"]],
    ["computed member property is", "o[p];", ["o", "p"]],
    ["object literal", "({ a: b, c, [d]: e, f() { return g; } });", ["b", "c", "d", "e", "g"]],
    [
      "destructuring defaults and computed keys",
      "const { a = d, [k]: z, ...rest } = o;",
      ["d", "k", "o"],
    ],
    ["array destructuring", "const [a, , b = c] = arr;", ["arr", "c"]],
    ["labels are not references", "L: for (;;) { break L; }", []],
    ["typeof and delete", "typeof z; delete o.p;", ["o", "z"]],
    ["template literals", "`$" + "{a} and $" + "{b}`;", ["a", "b"]],
    ["optional chains", "a?.b?.(c);", ["a", "c"]],
    [
      "assignment targets are references",
      "[a, b] = c; ({ d } = e); f = 1;",
      ["a", "b", "c", "d", "e", "f"],
    ],
    [
      "new.target and import.meta are not names",
      "function f() { return new.target; } import.meta.env;",
      [],
    ],
    ["arguments is local to functions", "function f() { return arguments[0]; }", []],
    [
      "switch lexical scope",
      "switch (x) { case 1: { let a; } default: let b = 2; b; a; }",
      ["a", "x"],
    ],
    [
      "nested function shadows",
      "const g = () => { const h = () => a; const a = 1; return h; };",
      [],
    ],
    [
      "function declaration inside a block is block scoped",
      "{ function inner() {} } inner();",
      ["inner"],
    ],
    [
      "async/await/yield bodies",
      "async function f() { await g(); for await (const x of h) x; }",
      ["g", "h"],
    ],
    ["import() and dynamic", "import(spec).then((m) => m.default(extra));", ["extra", "spec"]],
    ["tagged templates", `tag\`a\${b}\`;`, ["b", "tag"]],
    ["sequence and conditional", "(a, b) ? c : d;", ["a", "b", "c", "d"]],
  ])("[FRT-60] %s", (_name, code, expected) => {
    expect(free(code)).toEqual(expected);
  });

  it.each<[string, string, string[]]>([
    [
      "component names reference, intrinsics do not",
      "const v = <Foo a={b}><div c={d} /><x.Y /></Foo>;",
      ["Foo", "b", "d", "x"],
    ],
    [
      "lowercase components reference only via member roots",
      "const v = <foo-bar a={b} {...c} />;",
      ["b", "c"],
    ],
    ["fragments and children expressions", "const v = <>{a}{b && <C />}</>;", ["C", "a", "b"]],
    ["closing tag is not a second reference", "const v = <Foo>text</Foo>;", ["Foo"]],
    ["attribute names are not references", 'const v = <div title={t} data-x="1" />;', ["t"]],
  ])("[FRT-61] JSX: %s", (_name, code, expected) => {
    expect(free(code)).toEqual(expected);
  });

  it.each<[string, string, string[]]>([
    [
      "type annotations and aliases are ignored",
      "const a: Bar = c; type T = Baz; interface I { x: Qux }",
      ["c"],
    ],
    [
      "as, satisfies and non-null keep the expression",
      "const a = (x as Foo).y; const b = z satisfies Bar; const c = w!;",
      ["w", "x", "z"],
    ],
    ["type arguments are ignored", "f<Foo>(g<Bar>());", ["f", "g"]],
    ["typeof in a type position is a type", "type T = typeof secret; let a: typeof other;", []],
    ["enum initializers are runtime code", "enum E { A = 1, B = A << base }", ["base"]],
    [
      "parameter types are ignored",
      "function f(a: Foo, b: Bar<Baz> = d): Ret { return a; }",
      ["d"],
    ],
    [
      "generics on functions and classes",
      "class A<T extends Foo> extends B<Bar> implements Baz { x: T = c; }",
      ["B", "c"],
    ],
    ["declare is erased", "declare const x: number; declare function f(): void;", []],
    [
      "overload signatures are erased",
      "function f(a: string): void; function f(a: number): void; function f(a: any) { return g(a); }",
      ["g"],
    ],
    ["decorators are runtime code", "@dec class A { @prop() x = 1; }", ["dec", "prop"]],
  ])("[FRT-62] TypeScript: %s", (_name, code, expected) => {
    expect(free(code, "x.ts")).toEqual(expected);
  });

  it("[FRT-63] deeply nested code does not overflow the stack", () => {
    const arrows = `const f = ${"() => ".repeat(3000)}secret;`;
    expect(free(arrows)).toEqual(["secret"]);
    const blocks = `${"{ ".repeat(3000)}secret;${" }".repeat(3000)}`;
    expect(free(blocks)).toEqual(["secret"]);
  });
});
