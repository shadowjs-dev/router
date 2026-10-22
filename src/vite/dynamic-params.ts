import { parsePattern } from "../core/index";
import type { RouteModuleInfo } from "./exports";

/**
 * The checks of `export const dynamicParams`. With `false`, a param the page's `prerender` export does not list is not
 * found, so the export is only meaningful on a page whose path has params and whose `prerender` export lists them.
 * Every other use is a build error, never ignored.
 */

/** What the check needs to know about the file. @internal */
export interface DynamicParamsSubject {
  /** `"layout"` or `"template"` for a folder wrapper (`_layout`, `_template`); absent for any other file. */
  readonly wrapper?: "layout" | "template";
  /** The URL pattern of the file. */
  readonly fullPath: string;
  /** True when the file exports `SSE`/`WS`, HTTP method handlers or a default `apiRoute()`: it is not a page. */
  readonly endpoint: boolean;
}

/**
 * Why a file's `dynamicParams` export is not valid, or `undefined` when it is valid or absent. The text ends with
 * `fix: ...`, like the other scanner messages.
 *
 * @param info The analyzed module.
 * @param subject Which kind of file it is and where it sits.
 * @returns The message, or `undefined`.
 * @internal
 */
export function dynamicParamsProblem(
  info: RouteModuleInfo,
  subject: DynamicParamsSubject,
): string | undefined {
  if (!info.exports.includes("dynamicParams")) return undefined;
  if (subject.wrapper !== undefined || subject.endpoint) {
    return `exports "dynamicParams" in ${
      subject.wrapper === undefined ? "an API or stream route" : `a ${subject.wrapper}`
    }, but only a page takes it; fix: remove the export, or move it to the page whose params it limits`;
  }
  const value = info.config.dynamicParams;
  if (value === undefined) {
    return 'exports "dynamicParams" with a value the scanner cannot read: it must be the literal true or false; fix: write export const dynamicParams = false; (no variable, no expression)';
  }
  if (value) return undefined;
  const hasParams = parsePattern(subject.fullPath).segments.some(
    (segment) => segment.kind !== "static",
  );
  if (!hasParams) {
    return `exports dynamicParams = false, but "${subject.fullPath}" has no param to list; fix: remove the export`;
  }
  if (!info.exports.includes("prerender")) {
    return 'exports dynamicParams = false without a "prerender" export: no param would be listed, so every request would be not found; fix: export prerender with the list of paths (or a function that returns the params) to build, or remove dynamicParams = false';
  }
  return undefined;
}
