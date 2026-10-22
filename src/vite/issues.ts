/**
 * Diagnostics of the file-route scanner. Every problem is a {@link RouteIssue} that names the files
 * involved, so a build error always says which files to fix (never "first file wins").
 */

/** Stable codes of scanner diagnostics. @since 1.0.0 */
export type RouteIssueCode =
  | "ROUTE_FILE_NAME_INVALID"
  | "ROUTE_PARAM_INVALID"
  | "ROUTE_BRACKET_UNMATCHED"
  | "ROUTE_SPLAT_NOT_LAST"
  | "ROUTE_GROUP_INVALID"
  | "ROUTE_PATTERN_INVALID"
  | "ROUTE_RESERVED_PREFIX"
  | "ROUTE_DUPLICATE"
  | "ROUTE_AMBIGUOUS"
  | "ROUTE_PAGE_API_CONFLICT"
  | "ROUTE_MIXED_EXPORTS"
  | "ROUTE_API_NOT_READABLE"
  | "ROUTE_NO_EXPORTS"
  | "ROUTE_PARSE_ERROR"
  | "ROUTE_LIMIT"
  | "ROUTE_OPTION_INVALID"
  | "ROUTE_PRIVATE_PRERENDER"
  | "ROUTE_PARALLEL_UNSUPPORTED"
  | "ROUTE_INTERCEPT_UNSUPPORTED"
  | "ROUTE_EXPORT_UNSUPPORTED"
  | "ROUTE_DYNAMIC_PARAMS_INVALID";

/** One scanner problem. @since 1.0.0 */
export interface RouteIssue {
  readonly code: RouteIssueCode;
  readonly message: string;
  /** Routes-directory-relative POSIX paths of every file involved, sorted. */
  readonly files: readonly string[];
  /** The inferred URL pattern the problem is about, when there is one. */
  readonly path?: string;
}

/**
 * Formats issues as the text of a build error: one block per issue with its file list.
 *
 * @example formatIssues(error.issues);
 * @since 1.0.0
 */
export function formatIssues(issues: readonly RouteIssue[]): string {
  const blocks = issues.map((issue) => {
    const lines = [`[${issue.code}] ${issue.message}`];
    if (issue.path !== undefined) lines.push(`  path: ${issue.path}`);
    for (const file of issue.files) lines.push(`  file: ${file}`);
    return lines.join("\n");
  });
  return `File routes: ${issues.length} problem${issues.length === 1 ? "" : "s"}\n${blocks.join("\n")}`;
}

/**
 * Thrown by {@link scanRoutes} when the routes directory has problems. `issues` is the complete,
 * deterministic list (sorted), `message` is the formatted text with the file lists.
 *
 * @example
 * try { await scanRoutes({ routesDir }); } catch (error) {
 *   if (error instanceof RouteScanError) console.error(error.issues[0]?.files);
 * }
 * @since 1.0.0
 */
export class RouteScanError extends Error {
  readonly issues: readonly RouteIssue[];

  constructor(issues: readonly RouteIssue[]) {
    super(formatIssues(issues));
    this.name = "RouteScanError";
    this.issues = issues;
  }
}
