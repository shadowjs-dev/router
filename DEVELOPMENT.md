# Development Guide

This guide explains how to develop and test the ShadowJS Router with its peer dependency architecture.

## Architecture Overview

The ShadowJS Router is designed as a peer dependency of `@shadow-js/core`. This means:

- **Consumer Responsibility**: Users must install both `@shadow-js/router` and `@shadow-js/core`
- **Tight Coupling**: Router imports directly from `@shadow-js/core` (hooks, JSX, reactive primitives)
- **Framework Integration**: Deep integration with ShadowJS reactive system

## Development Setup

### 1. Local Development with Monorepo

If you're working within a ShadowJS monorepo:

```bash
# In your monorepo root
npm install

# Link the router package
cd packages/router
npm link ../core  # Link to @shadow-js/core

# Run development commands
npm run dev
```

### 2. Standalone Development

For standalone development without `@shadow-js/core`:

```bash
# Use the development package.json
cp package.json.dev package.json
npm install

# This installs a mock version of @shadow-js/core for testing
```

### 3. Testing with Mocks

The test setup includes comprehensive mocks for `@shadow-js/core`:

```typescript
// src/test-setup.ts
vi.mock("@shadow-js/core", () => ({
  useStore: vi.fn(), // Reactive state
  useEffect: vi.fn(), // Side effects
  useMemo: vi.fn(), // Memoization
  onMount: vi.fn(), // Lifecycle
  jsx: vi.fn(), // JSX rendering
}));
```

## Testing Strategy

### Unit Tests

Test individual components and hooks with mocked dependencies:

```typescript
// Example: Testing useLocation hook
describe("useLocation", () => {
  it("returns current location", () => {
    const mockRouter = { path: () => "/home", search: () => "" };
    vi.mocked(getActiveRouter).mockReturnValue(mockRouter);

    const location = useLocation();
    expect(location.pathname).toBe("/home");
  });
});
```

### Integration Tests

Test router behavior with realistic scenarios:

```typescript
describe("Router Navigation", () => {
  it("navigates to new route", () => {
    // Test complete navigation flow
    // with mocked history and location
  });
});
```

### Framework Integration Tests

When `@shadow-js/core` is available, test real integration:

```typescript
describe("ShadowJS Integration", () => {
  it("works with real ShadowJS components", () => {
    // Test with actual ShadowJS components
    // Only runs when @shadow-js/core is available
  });
});
```

## Building and Publishing

### Development Build

```bash
# Build with source maps for debugging
npm run build

# Watch mode for development
npm run dev
```

### Production Build

```bash
# Clean production build
npm run build

# Verify build output
ls -la dist/
# Should contain: index.js, index.cjs, index.d.ts
```

### Publishing Process

```bash
# Create a changeset
npm run changeset

# Version packages
npm run version-packages

# Publish to npm
npm run release
```

## Code Organization

### Source Structure

```
src/
├── components/         # Router UI components
│   ├── router.tsx     # Main Router component
│   ├── route.tsx      # Route definition
│   ├── link.tsx       # Navigation link
│   └── redirect.tsx   # Redirect component
├── hooks/             # Navigation hooks
│   ├── navigation.ts  # Core hooks
│   └── navigation-actions.ts # Actions
├── match.ts           # Route matching logic
├── types.ts           # TypeScript definitions
├── utils.ts           # Utility functions
├── context.ts         # Router context
└── index.ts           # Public API
```

### Key Design Patterns

1. **Context-Based Architecture**: Router state managed via React Context pattern
2. **Hook-Based API**: Navigation hooks for functional components
3. **Type-Safe Routing**: Full TypeScript support with generic types
4. **Declarative Configuration**: JSX-based route definitions
5. **Framework Integration**: Deep integration with ShadowJS reactive system

## Debugging

### Common Issues

1. **Missing @shadow-js/core**: Install peer dependency
2. **Import Errors**: Check that @shadow-js/core is properly linked
3. **Type Errors**: Verify TypeScript configuration
4. **Test Failures**: Check mock implementations

### Debug Mode

Enable debug logging for router operations:

```typescript
// In development
const router = <Router debug={true}>{/* routes */}</Router>;
```

### Performance Monitoring

Use browser dev tools to monitor router performance:

```typescript
// Monitor route changes
const location = useLocation();
useEffect(() => {
  console.time("Route Change");
  return () => console.timeEnd("Route Change");
}, [location.pathname]);
```

## Contributing

### Code Style

- Follow existing TypeScript patterns
- Use functional components with hooks
- Maintain type safety throughout
- Add JSDoc comments for public APIs

### Testing Requirements

- Unit tests for all new functionality
- Integration tests for complex features
- Mock external dependencies appropriately
- Maintain high test coverage

### Documentation

- Update README for new features
- Add JSDoc comments
- Update examples as needed
- Maintain API reference accuracy

## Troubleshooting

### Build Issues

```bash
# Clear build artifacts
rm -rf dist/

# Rebuild
npm run build
```

### Test Issues

```bash
# Clear test cache
npx vitest --clearCache

# Run specific test
npx vitest src/hooks.test.ts
```

### Dependency Issues

```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install

# Check for peer dependency issues
npm ls @shadow-js/core
```

This architecture ensures the router remains lightweight while providing deep integration with the ShadowJS framework.
