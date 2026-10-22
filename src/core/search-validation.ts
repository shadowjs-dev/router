import type { SearchRecord } from "./search";

/**
 * Search validation: a route's `validateSearch` is either a function from the raw query to the typed search, or a
 * Standard Schema (https://standardschema.dev) such as Zod, Valibot or ArkType. A rejected query is a
 * {@link SearchValidationError}, which the framework answers as a client error (400, `SEARCH_INVALID`) with the
 * failing keys.
 */

/** One problem a search validator found. @since 1.0.0 */
export interface SearchIssue {
  readonly message: string;
  /** The query key (or nested path) the problem is about; empty when it is about the whole query. */
  readonly path: readonly string[];
}

/**
 * Thrown when the query does not validate: by a Standard Schema, or by a `validateSearch` function that throws it
 * on purpose. A different error thrown by `validateSearch` is an ordinary error (a bug, a server fault).
 *
 * @example
 * validateSearch: (search) => {
 *   if (!/^\d+$/.test(String(search.page ?? "1"))) {
 *     throw new SearchValidationError([{ message: "page must be a whole number", path: ["page"] }]);
 *   }
 *   return { page: Number(search.page ?? 1) };
 * }
 * @since 1.0.0
 */
export class SearchValidationError extends Error {
  /** The problems, one per failing key. */
  readonly issues: readonly SearchIssue[];

  /** @param issues The problems found. */
  constructor(issues: readonly SearchIssue[]) {
    super(
      `invalid search parameters: ${issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}`,
    );
    this.name = "SearchValidationError";
    this.issues = issues;
  }
}

/** A Standard Schema v1 object: the `~standard` member that every conforming library provides. @since 1.0.0 */
export interface StandardSchemaLike<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaLikeResult<Output> | Promise<StandardSchemaLikeResult<Output>>;
    /** Inference only: the types of the schema. Never read at runtime. */
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

/** The result of a Standard Schema: a value, or the issues. @since 1.0.0 */
export type StandardSchemaLikeResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | {
      readonly issues: readonly {
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
      }[];
    };

/** What `validateSearch` accepts: a function, or a Standard Schema whose output is the typed search. @since 1.0.0 */
export type SearchValidator<S> = ((search: SearchRecord) => S) | StandardSchemaLike<unknown, S>;

/**
 * Runs a search validator on a parsed query. A Standard Schema that reports issues throws a
 * {@link SearchValidationError} listing them; a schema that validates asynchronously is refused, because the
 * navigation reads the search synchronously.
 *
 * @param validator The route's `validateSearch`.
 * @param search The parsed query.
 * @returns The typed search.
 * @throws SearchValidationError when the query is rejected.
 * @throws TypeError when a Standard Schema validates asynchronously.
 * @internal
 */
export function runSearchValidator(
  validator: SearchValidator<unknown>,
  search: SearchRecord,
): unknown {
  if (typeof validator === "function") return validator(search);
  const result = validator["~standard"].validate(search);
  if (result instanceof Promise) {
    throw new TypeError(
      "validateSearch: a Standard Schema must validate synchronously (the navigation reads the search at once).",
    );
  }
  if (result.issues !== undefined) {
    throw new SearchValidationError(
      result.issues.map((issue) => ({
        message: issue.message,
        path: (issue.path ?? []).map((segment) =>
          String(typeof segment === "object" ? segment.key : segment),
        ),
      })),
    );
  }
  return result.value;
}
