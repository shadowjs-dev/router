/**
 * Shadow Router - Declarative client-side routing for Shadow applications.
 *
 * This package provides:
 * - Router component for managing routes
 * - Route matching and parameter extraction
 * - Programmatic and declarative navigation
 * - Nested routing with layouts
 * - URL hash and history modes
 * - Route transitions and animations
 * - Scroll restoration
 * - Navigation hooks for components
 *
 * @example
 * ```tsx
 * import { Router, Route, useLocation } from "shadow-router";
 *
 * function App() {
 *   return (
 *     <Router>
 *       <Route path="/" component={Home} />
 *       <Route path="/about" component={About} />
 *       <Route path="/users/:id" component={UserProfile} />
 *     </Router>
 *   );
 * }
 *
 * function Home() {
 *   const location = useLocation();
 *   return <div>Home - Current path: {location.pathname}</div>;
 * }
 * ```
 */

// Re-export types
export type {
  /** Route configuration with path, component, layout, and nested routes */
  RouteConfig,
  /** Extracted path parameters from route matching (e.g., { id: "123" }) */
  PathParams,
  /** Component type for routes and layouts */
  ComponentType,
  /** Options for programmatic navigation */
  NavigateOptions,
  /** Transition effect for route changes */
  Transition,
} from "./types";

// Re-export components
export {
  /** Main router component that manages client-side routing */
  Router,
  /** Link component for declarative navigation */
  A,
  /** Component for programmatic redirects */
  Redirect,
  /** Route definition component for declarative routing */
  Route,
} from "./components";

// Re-export hooks
export {
  /** Hook to get current location (pathname, search, hash) */
  useLocation,
  /** Hook to get route parameters from current match */
  useParams,
  /** Hook to get and update URL search parameters */
  useSearchParams,
  /** Programmatic navigation function */
  navigate,
  /** Programmatic redirect function (replaces current history entry) */
  redirect,
} from "./hooks";
