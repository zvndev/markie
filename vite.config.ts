import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { offlineShellPlugin } from "./scripts/lib/offline-shell";

// The renderer is a static bundle that Electron serves over app://markie/
// from out/ (electron/main.js, registerProtocol). Relative asset URLs keep
// that working without the bundle knowing its origin, and the directory stays
// named out/ because release-preflight, CI's bundle budget and the Windows
// smoke workflow all key on that name.
export default defineConfig({
  plugins: [react(), tailwindcss(), offlineShellPlugin()],
  base: "./",
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // electron:dev waits on this exact port; a silent move to 3001 would leave
  // Electron waiting forever, so the port is strict.
  server: { port: 3000, strictPort: true },
  build: {
    outDir: "out",
    emptyOutDir: true,
    sourcemap: false,
    // Shared renderer: do not use Electron's Chromium as the browser contract.
    target: ["chrome120", "safari17", "firefox122"],
  },
});
