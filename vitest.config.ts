import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Ignore agent worktrees — team members run parallel branches under
    // `.claude/worktrees/<name>/`. Without this, vitest walks those
    // checkouts and runs whichever test state exists on that branch
    // alongside the local suite, producing confusing duplicate /
    // timing-out results. The `node_modules/**` default stays.
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
