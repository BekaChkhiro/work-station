import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    // Tests run in the src directory alongside their modules
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
