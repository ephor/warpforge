import { fileURLToPath, URL } from "node:url";

import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri expects a fixed dev port (see src-tauri/tauri.conf.json devUrl).
export default defineConfig({
  plugins: [
    react(),
    babel({
      presets: [reactCompilerPreset({ target: "19" })],
    }),
  ],
  clearScreen: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
