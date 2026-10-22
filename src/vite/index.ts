/**
 * `@shadow-js/router/vite`: file-based routes for Vite. Build time only (Node); nothing here is
 * bundled into an app.
 *
 * - {@link shadowRouter}: the Vite plugin (scan, generate, watch, split).
 * - {@link scanRoutes}, {@link generateRouteTree}: the pure parts, usable from tools and tests.
 * - {@link parseModule}, {@link pruneModule}, {@link freeReferences}: the syntax-tree utilities
 *   the plugins of Dusk build their transforms on.
 * @packageDocumentation
 */

export {
  type AstNode,
  codeFrame,
  identifierName,
  isNode,
  lineColumn,
  ModuleParseError,
  moduleExportName,
  nodesAt,
  type ParsedModule,
  parseModule,
  patternNames,
  stringValue,
  unwrapExpression,
  walkTree,
} from "./ast";
export {
  analyzeRouteModule,
  HTTP_METHODS,
  type HttpMethod,
  type ImageModuleExports,
  isMethodExport,
  type LiteralExport,
  type RouteConfigLiterals,
  type RouteModuleInfo,
  readImageExports,
} from "./exports";
export {
  type GenerateOptions,
  generateApiRoutesModule,
  generateRouteTree,
  UI_EXPORTS,
} from "./generate";
export {
  type IgnoreReason,
  isParamName,
  type MetadataImageKind,
  metadataImageKindOf,
  parseRouteFile,
  patternOf,
  ROUTE_EXTENSIONS,
  type RouteFileParse,
  type RouteSegment,
  type SegmentKind,
  toPosix,
} from "./grammar";
export {
  formatIssues,
  type RouteIssue,
  type RouteIssueCode,
  RouteScanError,
} from "./issues";
export {
  describeIssues,
  type ShadowRouterApi,
  type ShadowRouterOptions,
  type ShadowRouterPlugin,
  shadowRouter,
} from "./plugin";
export { type PruneOptions, type PruneResult, pruneModule } from "./prune";
export {
  type ApiEntry,
  type IgnoredFile,
  type MetadataImageFile,
  type MiddlewareEntry,
  type RouteEntry,
  type ScanCache,
  type ScanOptions,
  type ScanResult,
  type StreamEntry,
  scanRoutes,
} from "./scan";
export { findCaptures, freeReferences } from "./scope";
export { SERVER_ONLY_ROUTE_EXPORTS, stripServerOnlyExports } from "./server-only";
export { type NoSplitReason, ROUTE_UI_QUERY, type RouteSplit, splitRouteModule } from "./split";
export { collectUnits, type ModuleUnits, reachableUnits, type Unit, type UnitKind } from "./units";
export { writeIfChanged } from "./write";
