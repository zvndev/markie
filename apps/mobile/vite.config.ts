import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The app is the desktop renderer's document code (src/ at the repo root,
// through the same "@" alias) inside a Capacitor shell. Shared modules resolve
// their own dependencies from the root node_modules, so `npm ci` at the repo
// root comes first. React is the one package both trees import, and two copies
// of it break hooks, so it always resolves from this app.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const runtimePolicy = JSON.parse(
  readFileSync(new URL("../../electron/darkmown-runtime-policy.json", import.meta.url), "utf8")
) as { runtimeSha256: string; bootstrapSha256: string };

// The same policy shape the desktop builds in electron/csp.js. A Darkmown
// preview is a srcdoc frame, and a srcdoc frame inherits this policy on top of
// its own, so the pinned interpreter's two hashes are named here as well.
// Author JavaScript is never permitted anywhere. API calls go through the
// native HTTP stack (src/lib/native-http.ts), so connect-src stays 'self'.
export function mobileCsp(policy = runtimePolicy): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'sha256-${policy.runtimeSha256}' 'sha256-${policy.bootstrapSha256}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "frame-src about:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function contentSecurityPolicy(): Plugin {
  return {
    name: "markie-mobile-csp",
    // Development keeps Vite's inline HMR preamble working; every build that
    // reaches a device carries the policy.
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler: (html) =>
        html.replace(
          "<!-- markie:csp -->",
          `<meta http-equiv="Content-Security-Policy" content="${mobileCsp()}" />`
        ),
    },
  };
}

// `vite build --mode dev` (npm run build:dev) is the build for an emulator
// against dev/mock-server.mjs: the only build whose sign-in accepts plain http
// to 10.0.2.2, the Android emulator's name for the development machine. Every
// other build, the one that ships included, refuses it (src/lib/server-origin.ts).
export default defineConfig(({ command, mode }) => ({
  plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  base: "./",
  define: {
    __MARKIE_MOBILE_VERSION__: JSON.stringify(pkg.version),
    __MARKIE_MOBILE_DEV_SERVERS__: JSON.stringify(command === "serve" || mode === "dev"),
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) },
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 5174,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    // iOS 17 (the app's deployment target) and Android System WebView 120.
    target: ["safari17", "chrome120"],
    chunkSizeWarningLimit: 2500,
  },
}));
