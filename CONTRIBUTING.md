# Contributing to ShadowJS Router

[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Discord](https://img.shields.io/badge/Discord-ShadowJS-blue)](https://discord.gg/shadowjs)

Thanks for your interest in contributing to ShadowJS Router! We're excited to have you join our community of developers building the next generation of routing for ShadowJS applications.

## 📋 Prerequisites

- **Node.js**: >= 18.0.0 (LTS recommended)
- **npm**: >= 9.0.0
- **Git**: >= 2.30.0
- **TypeScript**: >= 5.0.0 (for development)

## 🚀 Getting Started

### 1. Fork and Clone

```bash
# Fork the repository on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/router.git
cd router
```

### 2. Install Dependencies

```bash
npm ci  # Use npm ci for reproducible builds
```

### 3. Set Up Development Environment

```bash
# Build the router package
npm run build

# Run type checking
npm run typecheck

# Run linting
npm run lint

# Format code
npm run format
```

### 4. Test Your Setup

```bash
# Run tests to verify everything works
npm test

# Run tests in watch mode
npm run test:watch
```

## 📁 Project Structure

```
router/
├── src/                    # Source code
│   ├── components/         # Router components
│   │   ├── router.tsx      # Main Router component
│   │   ├── route.tsx       # Route definition component
│   │   ├── link.tsx        # Navigation link component
│   │   ├── redirect.tsx    # Redirect component
│   │   └── helpers.ts      # Utility functions
│   ├── hooks/              # Navigation hooks
│   │   ├── navigation.ts   # Core navigation hooks
│   │   ├── navigation-actions.ts # Navigation actions
│   │   └── index.ts        # Hook exports
│   ├── match.ts            # Route matching logic
│   ├── types.ts            # TypeScript type definitions
│   ├── utils.ts            # Utility functions
│   ├── context.ts          # Router context management
│   └── index.ts            # Public API exports
├── examples/               # Example applications
├── benchmark/              # Performance benchmarks
├── .github/                # GitHub configuration
├── test-setup.ts           # Test configuration
└── vitest.config.ts        # Test runner configuration
```

## 🔧 Making Changes

### Code Style Guidelines

- **TypeScript**: Use strict TypeScript with proper type annotations
- **Formatting**: Prettier (`.prettierrc`)
- **Linting**: ESLint (`eslint.config.mjs`)
- **Imports**: Use ES6 imports, avoid barrel exports for tree-shaking
- **Naming**: Use camelCase for variables/functions, PascalCase for components
- **Documentation**: Add JSDoc comments for all public APIs

### Development Workflow

1. **Create a feature branch**:

   ```bash
   git checkout -b feature/amazing-feature
   # or for bug fixes
   git checkout -b fix/bug-description
   ```

2. **Make your changes**:

   - Write tests for new functionality
   - Update documentation
   - Ensure type safety

3. **Test your changes**:

   ```bash
   # Run tests
   npm test

   # Build package
   npm run build

   # Type check
   npm run typecheck

   # Lint
   npm run lint
   ```

4. **Commit your changes**:
   ```bash
   git add .
   git commit -m "feat: add amazing feature"
   ```

## 📦 Versioning and Releasing

We use [Changesets](https://github.com/changesets/changesets) for version management.

### Proposing a Release

1. **Create a changeset**:

   ```bash
   npx changeset
   ```

2. **Select packages and bump type**:

   - Select appropriate version bump (patch/minor/major)

3. **Commit the changeset**:

   ```bash
   git add .changeset/
   git commit -m "docs: add changeset for new feature"
   ```

4. **Open a Pull Request**:
   - PR will trigger CI checks
   - After merge, a "Version Packages" PR will be created automatically
   - Merging that PR will publish to npm

### Release Process

- **Automated**: GitHub Actions handles versioning and publishing
- **Semantic**: Follows [Semantic Versioning](https://semver.org/)
- **Changelog**: Automatically generated from changesets

## 🧪 Testing

### Running Tests

```bash
# All tests
npm test

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
```

### Writing Tests

- Use Vitest for testing
- Follow existing patterns in test files
- Test both happy path and error cases
- Mock external dependencies

### Testing Router Behavior

Router tests cover:

- Route matching and compilation
- Navigation hooks (useLocation, useParams, useSearchParams)
- Component integration
- Edge cases and error handling

## 📚 Documentation

### Adding Documentation

- Update JSDoc comments for new APIs
- Add examples to `examples/` directory
- Update README.md for new features
- Ensure TypeScript types are well-documented

### Documentation Guidelines

- Use clear, concise language
- Include practical examples
- Document edge cases and limitations
- Keep API reference up-to-date

## 🤝 Pull Request Process

### PR Requirements

- ✅ **Tests**: Add tests for new functionality
- ✅ **Documentation**: Update relevant docs
- ✅ **TypeScript**: Ensure type safety
- ✅ **Linting**: Pass all lint checks
- ✅ **Build**: Successfully build package

### PR Template

Please use this template when opening PRs:

```markdown
## Description

Brief description of the changes.

## Changes

- What was changed
- Why it was changed
- How it was changed

## Testing

- How to test the changes
- What was tested
- Edge cases considered

## Breaking Changes

- Are there any breaking changes?
- Migration guide if needed
```

### Code Review

- All PRs require at least one approval
- Address review comments promptly
- Keep PRs focused and small when possible
- Use draft PRs for work-in-progress

## 🐛 Reporting Bugs

### Bug Reports

Please use the GitHub issue template:

1. **Clear Title**: Summarize the issue
2. **Description**: Detailed explanation
3. **Reproduction**: Steps to reproduce
4. **Environment**: Node.js version, OS, etc.
5. **Expected vs Actual**: What should happen vs what happens

### Feature Requests

Use the feature request template:

1. **Problem**: What problem does this solve?
2. **Solution**: Describe the proposed solution
3. **Alternatives**: Any alternative solutions?
4. **Use Cases**: Specific use cases

## 🔒 Security Issues

### Reporting Security Issues

- **Email**: community@shadowjs.dev
- **GitHub**: Open a private security advisory
- **DO NOT** open public issues for security vulnerabilities

### Security Best Practices

- Follow secure coding guidelines
- Use dependency scanning tools
- Keep dependencies updated
- Review code for security issues

## 🎯 Code of Conduct

Please read and follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

## 📞 Getting Help

- **Discord**: Join our community on Discord
- **GitHub Discussions**: Ask questions and share ideas
- **Issues**: For bug reports and feature requests

## 🙏 Acknowledgments

We appreciate all contributions, whether they're:

- Code contributions
- Bug reports
- Feature requests
- Documentation improvements
- Community support

Every contribution makes ShadowJS Router better for everyone! 🚀
