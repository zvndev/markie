import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The Markie web app (src/web): the desktop renderer's editor in a browser,
// served by the server at /app on its own origin (server/src/web-app.ts).
// `npm run build:web` writes it into server/web-dist, the directory the
// server image copies in. The desktop build (vite.config.ts) is untouched.
const outDir = fileURLToPath(new URL("./server/web-dist", import.meta.url));
const runtimePolicy = JSON.parse(
  readFileSync(new URL("./electron/darkmown-runtime-policy.json", import.meta.url), "utf8")
) as { runtimeSha256: string; bootstrapSha256: string };

const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Hashes of every script the app page may run besides its own bundle: any
 * inline script in the shell, and the pinned Darkmown interpreter and its
 * bootstrap, which a Darkmown preview's srcdoc frame inherits the page's
 * policy for (the desktop names the same two, electron/csp.js).
 */
export function webAppScriptHashes(shellHtml: string, policy = runtimePolicy): string[] {
  const hashes = new Set<string>();
  for (const match of shellHtml.matchAll(INLINE_SCRIPT)) {
    if (match[1]) hashes.add(`sha256-${createHash("sha256").update(match[1], "utf8").digest("base64")}`);
  }
  hashes.add(`sha256-${policy.runtimeSha256}`);
  hashes.add(`sha256-${policy.bootstrapSha256}`);
  return [...hashes].sort();
}

// The server reads web-app.json for the page's script policy, and the
// placeholder keeps the directory in git (and the Dockerfile's COPY valid)
// after the build empties it.
function webAppManifest(): Plugin {
  return {
    name: "markie-web-app-manifest",
    apply: "build",
    closeBundle() {
      const shell = readFileSync(`${outDir}/app.html`, "utf8");
      writeFileSync(`${outDir}/web-app.json`, `${JSON.stringify({ scriptHashes: webAppScriptHashes(shell) }, null, 2)}\n`);
      writeFileSync(`${outDir}/.gitkeep`, "");
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), webAppManifest()],
  base: "/app/",
  // The favicon comes from the server's own brand routes.
  publicDir: false,
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { port: 3002, strictPort: true },
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    target: ["chrome120", "safari17", "firefox122"],
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: { app: fileURLToPath(new URL("./app.html", import.meta.url)) },
    },
  },
});
