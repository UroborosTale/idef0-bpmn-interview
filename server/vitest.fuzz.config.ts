import { defineConfig } from "vitest/config";

// Фаззеры API и модели (test/*.fuzz.ts): долгие, в обычный прогон не входят — npm run fuzz -w server.
export default defineConfig({
  test: {
    include: ["test/**/*.fuzz.ts"],
    setupFiles: ["test/setup.ts"],
    environment: "node",
    testTimeout: 1_800_000,
    hookTimeout: 300_000,
  },
});
