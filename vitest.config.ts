import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    // Tests that shell out to `git` (branchCommit, PR raise) can take a few
    // seconds on Windows; bump above vitest's 5s default.
    testTimeout: 30_000,
  },
});
