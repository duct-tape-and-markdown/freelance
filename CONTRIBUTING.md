# Contributing to Freelance

Thanks for your interest in contributing to Freelance! This document covers how to get set up and what to expect.

## Getting Started
```bash
git clone https://github.com/duct-tape-and-markdown/freelance.git
cd freelance
npm install
npm run build
npm test
```

Requires Node.js 20+.

## Development Workflow

1. Create a branch from `main`
2. Make your changes
3. Run `npm run build` — must compile with zero errors
4. Run `npm test` — all 514+ tests must pass, 90% line coverage threshold enforced
5. Run `npx freelance validate templates/` — all starter templates must validate cleanly
6. Open a PR against `main`

## Project Structure

- `src/engine/` — Core graph engine, expression evaluator, loader, schema
- `src/server/` — MCP server (stdio transport)
- `src/cli/` — CLI commands (init, validate, visualize, inspect)
- `templates/` — Starter workflow graphs
- `test/` — Test suites mirroring src/ structure

## Writing Workflow Graphs

Graphs are YAML files with the `.workflow.yaml` extension. Look at the starter templates in `templates/` for examples, or run `freelance_guide` for the full schema. Validate your graphs with:
```bash
npx freelance validate path/to/graphs/
```

## Code Style

- TypeScript strict mode
- No implicit `any`
- Library code throws errors; CLI code catches and exits with appropriate codes
- All file operations are synchronous (intentional for CLI context)

## Tests

Tests use Node's built-in test runner. Each source module has a corresponding test file. Integration tests cover cross-module behavior.
```bash
npm test                    # Run all tests with coverage
npm test -- --test-only     # Run without coverage
```

## Reporting Issues

Open an issue on GitHub. Include: what you did, what you expected, what happened, and your Node.js version.

## Future

- Move `@inquirer/prompts` to `optionalDependencies` — it's only used by `freelance init` and adds ~1.5MB for users who only need the engine/MCP server.
