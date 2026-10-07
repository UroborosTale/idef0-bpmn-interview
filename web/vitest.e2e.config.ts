import { defineConfig } from "vitest/config";

// Сквозные тесты в настоящем браузере (Playwright): свой API-сервер с временной базой и свой Vite.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    environment: "node",
    globalSetup: ["e2e/global-setup.ts"],
    testTimeout: 90_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
