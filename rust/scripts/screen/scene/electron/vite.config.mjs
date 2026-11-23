// Serves the Electron renderer's own source (read-only) with one extra page,
// /scene.html, that mounts a single component in a named state. Nothing is
// written into the Electron checkout: Vite's cache goes to SCENE_CACHE.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const electron = process.env.MARKIE_ELECTRON_SRC;
if (!electron) throw new Error("MARKIE_ELECTRON_SRC must name the Electron checkout");
const here = path.dirname(fileURLToPath(import.meta.url));
const need = createRequire(path.join(electron, "package.json"));
const { default: react } = await import(need.resolve("@vitejs/plugin-react"));
const { default: tailwindcss } = await import(need.resolve("@tailwindcss/vite"));

const page = `<!doctype html>
<html lang="en" class="dark"><head><meta charset="utf-8" /><title>scene</title></head>
<body class="antialiased"><div id="root"></div>
<script type="module" src="/@fs${path.join(here, "scene-main.tsx")}"></script></body></html>`;

export default {
  root: electron,
  cacheDir: process.env.SCENE_CACHE,
  logLevel: "warn",
  clearScreen: false,
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "markie-scene-page",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/scene.html")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml(req.url, page));
        });
      },
    },
  ],
  // The scene page lives outside the checkout: its bare imports resolve there.
  resolve: { alias: { "@": path.join(electron, "src") }, dedupe: ["react", "react-dom"] },
  server: { port: 18990, strictPort: true, host: "localhost", fs: { allow: [electron, here, process.env.SCENE_FIXTURES ?? here] } },
  optimizeDeps: { entries: [path.join(here, "scene-main.tsx")] },
};
