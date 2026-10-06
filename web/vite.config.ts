import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // геометрия диаграмм — общий с сервером модуль (server/src/shared), один код для редактора и экспорта
    alias: { "@shared": fileURLToPath(new URL("../server/src/shared", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787", // сервер без входа слушает только 127.0.0.1 (не ::1)
        changeOrigin: true,
      },
    },
  },
});
