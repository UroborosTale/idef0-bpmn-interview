import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Модульные тесты и тесты компонентов: jsdom, тот же alias @shared, что у сборки.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}"],
      setupFiles: ["src/test/setup.ts"],
    },
  })
);
