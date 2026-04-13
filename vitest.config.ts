import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Skip git worktrees nested under .claude/ so vitest doesn't
    // re-discover and re-run every test file from a parallel workspace.
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
    coverage: {
      provider: "v8",
      reporter: ["text"],
      thresholds: {
        lines: 90,
      },
      exclude: [
        // Barrel files — pure re-exports
        "src/index.ts",
        "src/**/index.ts",
        // Bin shim — 4 lines, covered by CLI smoke tests in CI
        "src/bin.ts",
        // CLI command handlers — Commander scaffolding; library logic lives
        // elsewhere and the CLI itself is covered by smoke tests in CI.
        "src/cli/**",
        // Non-source
        "dist/**",
        "test/**",
        "**/*.config.*",
        "scripts/**",
      ],
    },
  },
});
