/**
 * Compile-time checks of `validateSearch` given a Standard Schema: the loader's search is the schema's output.
 */
import { defineRoute } from "@shadow-js/router";
import type { StandardSchemaLike } from "@shadow-js/router/core";

const pageSchema: StandardSchemaLike<unknown, { page: number }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value: { page: Number(value) } }),
  },
};

export const schemaRoute = defineRoute("/list", {
  validateSearch: pageSchema,
  loader: ({ search }) => {
    const page: number = search.page;
    return page;
  },
});
