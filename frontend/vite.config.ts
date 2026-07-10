import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds to ../web-dist, which the Hono server serves. Dev proxies /api to the
// running copilot server so the frontend talks to the real backend.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "../web-dist", emptyOutDir: true },
  server: {
    port: 5173,
    // Dev proxies to the deployed backend so the frontend talks to real data
    // (documents, inbox). In prod the Hono server serves this build from the
    // same origin, so no proxy is needed there.
    proxy: {
      "/api": { target: "https://firelever-copilot.fly.dev", changeOrigin: true, secure: true },
    },
  },
});
