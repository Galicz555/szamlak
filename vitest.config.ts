import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Random order, files and tests alike: a test that leans on another's leftovers fails.
    sequence: { shuffle: true },
  },
});
