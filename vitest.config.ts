import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  test: {
    include: [
      mode === "integration"
        ? "test/integration/**/*.test.ts"
        : "test/unit/**/*.test.ts",
    ],
    passWithNoTests: true,
  },
}));
