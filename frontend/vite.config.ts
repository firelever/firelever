import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds to ../web-dist, which the Hono server serves. Dev proxies /api to the
// running copilot server so the frontend talks to the real backend.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "../web-dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8787" },
  },
});
