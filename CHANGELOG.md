# Changelog

All notable changes to ShadowJS Router will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Comprehensive test suite with Vitest
- GitHub Actions CI/CD pipeline
- Multiple example applications
- Performance benchmarks
- Contributing guidelines and code of conduct

### Changed

- Updated repository URLs and links
- Improved installation instructions
- Enhanced TypeScript configuration

### Fixed

- ESLint configuration errors
- Peer dependency issues

## [0.1.0] - 2025-01-22

### Added

- 🎯 **Declarative Routing**: JSX-based route configuration
- 🧩 **Nested Routes**: Support for nested layouts and route hierarchies
- 🎭 **Route Transitions**: Built-in transition animations
- 📜 **Scroll Restoration**: Automatic scroll position management
- 🔗 **Programmatic Navigation**: Full control over navigation
- 🎨 **Layout Support**: Shared layouts for multiple routes
- 📱 **Hash & History Modes**: Choose between routing strategies
- 🔍 **Route Parameters**: Type-safe dynamic route segments
- 📚 **TypeScript Support**: Full type safety and intellisense
- 📦 **Modern Build**: ESM/CJS dual format with tree shaking
- 🧪 **Comprehensive Testing**: Unit and integration tests
- 📖 **Rich Documentation**: Examples and API reference

### Features

- **Router Component**: Main component managing client-side routing
- **Route Component**: Declarative route definitions
- **Link Component**: Navigation with automatic active states
- **Redirect Component**: Programmatic redirects
- **Navigation Hooks**: useLocation, useParams, useSearchParams
- **Navigation Actions**: navigate, redirect functions
- **Route Matching**: Sophisticated pattern matching engine
- **Scroll Management**: Customizable scroll behavior
- **Transition System**: Built-in and custom transitions
- **Error Handling**: Route and navigation error boundaries

### API

- **Components**: `<Router>`, `<Route>`, `<A>`, `<Redirect>`
- **Hooks**: `useLocation()`, `useParams()`, `useSearchParams()`
- **Functions**: `navigate()`, `redirect()`
- **Types**: `RouteConfig`, `PathParams`, `NavigateOptions`, `Transition`

[Unreleased]: https://github.com/shadow-js/router/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/shadow-js/router/releases/tag/v0.1.0
