# ShadowJS Router

[![npm version](https://img.shields.io/npm/v/@shadow-js/router.svg)](https://www.npmjs.com/package/@shadow-js/router)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Declarative client-side routing for ShadowJS applications with support for nested routes, layouts, transitions, and scroll restoration.

## ✨ Features

- **🎯 Declarative Routing**: Define routes using JSX components
- **🧩 Nested Routes**: Support for nested layouts and route hierarchies
- **🎭 Transitions**: Built-in route transition animations
- **📜 Scroll Restoration**: Automatic scroll position management
- **🔗 Programmatic Navigation**: Navigate programmatically with full control
- **🎨 Layout Support**: Shared layouts for multiple routes
- **📱 Hash & History Modes**: Choose between hash and history-based routing
- **🔍 Route Parameters**: Dynamic route segments with type safety

## 📦 Installation

The ShadowJS Router requires `@shadow-js/core` as a peer dependency:

```bash
# Install both packages together
npm install @shadow-js/router @shadow-js/core

# Or if you already have @shadow-js/core installed
npm install @shadow-js/router
```

**Important**: This router is specifically designed for ShadowJS applications and requires `@shadow-js/core` to function properly. The router imports directly from `@shadow-js/core` and will not work without it.

### Development Setup

For development and testing, you can use the development configuration:

```bash
# Copy the development package.json
cp package.json.dev package.json

# Install dependencies (includes @shadow-js/core)
npm install
```

### Peer Dependency Architecture

This package uses a peer dependency approach for several reasons:

1. **Framework Integration**: Tightly coupled with ShadowJS reactive system
2. **Bundle Size**: Avoids bundling framework code that consumers already have
3. **Version Alignment**: Ensures consumers use compatible versions
4. **Tree Shaking**: Allows better optimization in consumer applications

## 🚀 Quick Start

### Basic Routing

```tsx
import { Router, Route, A, useLocation } from "@shadow-js/router";

function Navigation() {
  return (
    <nav>
      <A href="/">Home</A>
      <A href="/about">About</A>
      <A href="/contact">Contact</A>
    </nav>
  );
}

function Home() {
  const location = useLocation();
  return (
    <div>
      <h1>Home</h1>
      <p>Current path: {() => location.pathname}</p>
    </div>
  );
}

function About() {
  return <h1>About Us</h1>;
}

function Contact() {
  return <h1>Contact Us</h1>;
}

function NotFound() {
  return <h1>404 - Page Not Found</h1>;
}

function App() {
  return (
    <Router notFound={NotFound}>
      <Navigation />
      <Route path="/" component={Home} />
      <Route path="/about" component={About} />
      <Route path="/contact" component={Contact} />
    </Router>
  );
}
```

### Dynamic Routes with Parameters

```tsx
import { useParams } from "@shadow-js/router";

function UserProfile() {
  const params = useParams();
  return (
    <div>
      <h1>User Profile</h1>
      <p>User ID: {() => params().id}</p>
    </div>
  );
}

function App() {
  return (
    <Router>
      <Route path="/users/:id" component={UserProfile} />
    </Router>
  );
}
```

## 🎯 Core Concepts

### Route Configuration

Routes can be configured in two ways:

#### 1. Declarative Routes (JSX)

```tsx
<Router>
  <Route path="/" component={Home} />
  <Route path="/about" component={About} />
  <Route path="/users/:id" component={UserProfile} />
</Router>
```

#### 2. Programmatic Routes (Objects)

```tsx
const routes = [
  { path: "/", component: Home },
  { path: "/about", component: About },
  { path: "/users/:id", component: UserProfile },
];

<Router routes={routes} />;
```

### Route Matching

ShadowJS Router uses a sophisticated matching algorithm:

- **Exact Matching**: `/users` matches only `/users`
- **Parameter Matching**: `/users/:id` matches `/users/123`
- **Wildcard Matching**: `/users/*` matches `/users/123/posts`
- **Optional Parameters**: `/users/:id?` matches `/users` and `/users/123`

### Nested Routes and Layouts

```tsx
function DashboardLayout({ children }) {
  return (
    <div className="dashboard">
      <nav>
        <A href="/dashboard">Overview</A>
        <A href="/dashboard/users">Users</A>
        <A href="/dashboard/settings">Settings</A>
      </nav>
      <main>{children}</main>
    </div>
  );
}

function DashboardOverview() {
  return <h2>Dashboard Overview</h2>;
}

function App() {
  return (
    <Router>
      <Route path="/dashboard" layout={DashboardLayout}>
        <Route path="/" component={DashboardOverview} />
        <Route path="/users" component={DashboardUsers} />
        <Route path="/settings" component={DashboardSettings} />
      </Route>
    </Router>
  );
}
```

## 📚 API Reference

### Components

#### `<Router>`

The main router component that manages client-side routing for your application.

**Props:**

- `routes?: RouteConfig[]` - Array of route configurations (alternative to children)
- `children?: any` - Child routes when using JSX syntax
- `transition?: Transition` - Default transition for all routes
- `notFound?: ComponentType` - Component to render for unmatched routes
- `mode?: "history" | "hash"` - URL handling mode (default: "history")
- `scroll?: ScrollBehavior` - Scroll restoration behavior

**Examples:**

```tsx
// JSX syntax
<Router notFound={NotFound} mode="history">
  <Route path="/" component={Home} />
  <Route path="/about" component={About} />
</Router>;

// Object syntax
const routes = [
  { path: "/", component: Home },
  { path: "/about", component: About },
];

<Router routes={routes} />;
```

#### `<Route>`

Defines a route with its path and component.

**Props:**

- `path: string` - Route path pattern
- `component?: ComponentType` - Component to render for this route
- `layout?: ComponentType` - Layout component wrapping this route
- `children?: RouteConfig[]` - Nested routes
- `redirect?: string | Function` - Redirect path or function
- `transition?: Transition` - Route-specific transition

**Examples:**

```tsx
// Basic route
<Route path="/home" component={Home} />

// Route with layout
<Route path="/dashboard" layout={DashboardLayout}>
  <Route path="/" component={Overview} />
  <Route path="/users" component={Users} />
</Route>

// Route with redirect
<Route path="/old-path" redirect="/new-path" />

// Dynamic route
<Route path="/users/:id" component={UserProfile} />
```

#### `<A>`

Enhanced anchor tag for client-side navigation with automatic active states.

**Props:**

- `href: string` - Navigation target
- `replace?: boolean` - Replace current history entry
- `state?: any` - State to pass to the new route
- `className?: string | Function` - CSS class (can be reactive)
- All standard `<a>` tag props

**Examples:**

```tsx
<A href="/home">Home</A>
<A href="/users" className={() => (location.pathname === "/users" ? "active" : "")}>
  Users
</A>
```

#### `<Redirect>`

Programmatically redirects to another route.

**Props:**

- `to: string` - Redirect target path

**Examples:**

```tsx
<Redirect to="/login" />
```

### Hooks

#### `useLocation()`

Returns the current location object with reactive properties.

**Returns:** `Store<Location>`

**Location Properties:**

- `pathname: string` - Current path
- `search: string` - Query string
- `hash: string` - Hash fragment
- `state: any` - Navigation state

**Examples:**

```tsx
function CurrentPage() {
  const location = useLocation();

  return (
    <div>
      <p>Current path: {location.pathname}</p>
      <p>Search: {location.search}</p>
      <p>Hash: {location.hash}</p>
    </div>
  );
}
```

#### `useParams<T>()`

Returns route parameters extracted from the current URL.

**Returns:** `Store<T | undefined>`

**Examples:**

```tsx
function UserProfile() {
  const params = useParams<{ id: string }>();

  return <div>User ID: {params().id}</div>;
}
```

#### `useSearchParams()`

Manages URL search parameters with reactive updates.

**Returns:** `[Store<URLSearchParams>, SetterFunction]`

**Examples:**

```tsx
function SearchComponent() {
  const [searchParams, setSearchParams] = useSearchParams();

  const updateSearch = (query: string) => {
    setSearchParams({ q: query, page: "1" });
  };

  return (
    <input
      value={searchParams().get("q") || ""}
      onInput={(e) => updateSearch(e.target.value)}
    />
  );
}
```

### Functions

#### `navigate(to, options?)`

Programmatically navigate to a new route.

**Parameters:**

- `to: string` - Target path
- `options?: NavigateOptions` - Navigation options

**NavigateOptions:**

- `replace?: boolean` - Replace current history entry
- `state?: any` - State to pass to the new route

**Examples:**

```tsx
// Basic navigation
navigate("/dashboard");

// Replace current history entry
navigate("/login", { replace: true });

// Pass state
navigate("/checkout", { state: { fromCart: true } });
```

#### `redirect(to)`

Redirect to a new route (equivalent to navigate with replace: true).

**Parameters:**

- `to: string` - Redirect target

**Examples:**

```tsx
redirect("/login");
```

### Types

#### `RouteConfig<P, T>`

Configuration object for defining routes programmatically.

**Properties:**

- `path: P` - Route path pattern
- `component?: ComponentType` - Route component
- `layout?: ComponentType` - Layout component
- `children?: RouteConfig[]` - Nested routes
- `redirect?: string | Function` - Redirect configuration
- `transition?: Transition` - Route transition

#### `PathParams<P>`

Type-safe route parameters extracted from path patterns.

**Examples:**

```tsx
// For path "/users/:id/posts/:postId"
// PathParams = { id: string, postId: string }
```

#### `NavigateOptions<T>`

Options for programmatic navigation.

**Properties:**

- `replace?: boolean` - Replace history entry
- `state?: T` - Navigation state

#### `Transition`

Animation effect for route changes.

**Types:**

- `"none"` - No transition
- `"fade"` - Fade transition
- `CustomTransition` - Custom transition function

## 🔧 Advanced Usage

### Programmatic Navigation

```tsx
import { navigate, redirect } from "@shadow-js/router";

function LoginForm() {
  const [isLoggedIn, setIsLoggedIn] = useStore(false);

  const handleLogin = () => {
    setIsLoggedIn(true);
    // Navigate after successful login
    navigate("/dashboard", { replace: true });
  };

  const handleLogout = () => {
    setIsLoggedIn(false);
    // Redirect to home
    redirect("/");
  };

  return (
    <div>
      <button onClick={handleLogin}>Login</button>
      <button onClick={handleLogout}>Logout</button>
    </div>
  );
}
```

### Route Transitions

```tsx
<Router transition="fade">
  <Route path="/" component={Home} />
  <Route path="/about" component={About} transition="slide" />
</Router>
```

Available transitions: `"fade"`, `"slide"`, `"scale"`, `"none"`

### Custom Scroll Behavior

```tsx
<Router
  scroll={(context) => {
    if (context.action === "PUSH") {
      window.scrollTo(0, 0); // Scroll to top on navigation
    } else if (context.action === "POP") {
      // Restore scroll on browser back/forward
      // Default behavior handles this automatically
    }
  }}
>
  {/* routes */}
</Router>
```

### Route Guards and Redirects

```tsx
function ProtectedRoute({ component: Component }) {
  const [isAuthenticated, setIsAuthenticated] = useStore(false);

  return (
    <Show when={() => isAuthenticated()} fallback={<Redirect to="/login" />}>
      <Component />
    </Show>
  );
}

function App() {
  return (
    <Router>
      <Route
        path="/dashboard"
        component={() => <ProtectedRoute component={Dashboard} />}
      />
    </Router>
  );
}
```

### Query Parameters

```tsx
import { useSearchParams } from "@shadow-js/router";

function ProductList() {
  const [searchParams, setSearchParams] = useSearchParams();

  const category = () => searchParams().get("category") || "all";
  const sort = () => searchParams().get("sort") || "name";

  const updateFilters = (newFilters) => {
    setSearchParams({
      ...Object.fromEntries(searchParams().entries()),
      ...newFilters,
    });
  };

  return (
    <div>
      <select
        value={() => category()}
        onChange={(e) => updateFilters({ category: e.target.value })}
      >
        <option value="all">All Categories</option>
        <option value="electronics">Electronics</option>
        <option value="books">Books</option>
      </select>
    </div>
  );
}
```

## 🏗️ Router Architecture

### Route Compilation

The router compiles route configurations into an optimized matching tree:

1. **Parse route patterns** into regex and parameter names
2. **Build matching tree** for efficient route resolution
3. **Cache compiled routes** for performance

### Navigation Flow

1. **URL Change Detection**: Listen to `popstate` and `hashchange` events
2. **Route Matching**: Find matching route for current path
3. **Component Resolution**: Resolve component and layout hierarchy
4. **Transition Handling**: Apply route transitions
5. **Scroll Management**: Handle scroll restoration
6. **Render**: Update DOM with new route content

### State Management

The router manages several reactive states:

- **Current location**: pathname, search, hash
- **Current route match**: matched route and parameters
- **Navigation history**: for back/forward functionality
- **Scroll positions**: for restoration

## 🔌 Integration

### With ShadowJS

```tsx
import { useStore } from "@shadow-js/core";
import { Router, Route, useLocation } from "@shadow-js/router";

function App() {
  const [user, setUser] = useStore(null);

  return (
    <Router>
      <Route path="/" component={Home} />
      <Route path="/profile" component={Profile} />
    </Router>
  );
}
```

### Custom History Implementation

```tsx
// For server-side rendering or custom history management
const customHistory = {
  push: (path) => {
    /* custom push logic */
  },
  replace: (path) => {
    /* custom replace logic */
  },
  go: (delta) => {
    /* custom go logic */
  },
};

// Pass to router
<Router history={customHistory}>{/* routes */}</Router>;
```

## 🎨 Styling Routes

Routes can have their own styling:

```tsx
// Route-specific styles
<Route path="/dashboard" component={Dashboard} className="dashboard-route" />;

// Conditional styling based on active route
function Navigation() {
  const location = useLocation();

  return (
    <nav>
      <A href="/" className={() => (location.pathname === "/" ? "active" : "")}>
        Home
      </A>
      <A
        href="/about"
        className={() => (location.pathname === "/about" ? "active" : "")}
      >
        About
      </A>
    </nav>
  );
}
```

## 🐛 Error Handling

### Route Errors

```tsx
function App() {
  return (
    <Router
      notFound={() => <div>Custom 404 Page</div>}
      onError={(error) => {
        console.error("Route error:", error);
        // Handle route errors
      }}
    >
      {/* routes */}
    </Router>
  );
}
```

### Navigation Errors

```tsx
import { navigate } from "@shadow-js/router";

try {
  await navigate("/protected-route");
} catch (error) {
  if (error.code === "UNAUTHORIZED") {
    navigate("/login");
  }
}
```

## 📊 Performance

### Route Preloading

```tsx
// Preload routes on hover for better UX
function Link({ href, children }) {
  const [isPreloading, setIsPreloading] = useStore(false);

  return (
    <A
      href={href}
      onMouseEnter={() => {
        setIsPreloading(true);
        // Preload route component
        import(`./pages${href}.js`);
      }}
      className={() => (isPreloading() ? "preloading" : "")}
    >
      {children}
    </A>
  );
}
```

### Route Memoization

Routes automatically memoize components to prevent unnecessary re-renders.

## 🧪 Testing

```tsx
import { render } from "@shadow-js/core";
import { Router, Route } from "@shadow-js/router";

describe("Routing", () => {
  test("renders correct component for route", () => {
    const container = document.createElement("div");

    render(
      <Router>
        <Route path="/test" component={() => <div>Test Component</div>} />
      </Router>,
      container
    );

    // Navigate to test route
    window.history.pushState({}, "", "/test");

    expect(container.innerHTML).toContain("Test Component");
  });
});
```

## 📚 Examples

See the [examples documentation](./examples/) for:

- Basic routing patterns
- Nested routes and layouts
- Dynamic routing
- Protected routes
- Search and query parameters

## 🤝 Contributing

We welcome contributions! See the [Contributing Guide](../../CONTRIBUTING.md) for details.

## 📄 License

MIT License - see [LICENSE](../../LICENSE) for details.

## 📞 Support

- **Documentation**: [Router API](./src/types.ts)
- **Examples**: [Routing Examples](./examples/)
- **Issues**: [GitHub Issues](https://github.com/shadow-js/router/issues)
- **Discussions**: [GitHub Discussions](https://github.com/shadow-js/router/discussions)

---

Built with ❤️ for the ShadowJS ecosystem.
