// Whether this server is serving the Markie web app (/app, /app/d/:id,
// /app/new). It is, exactly when the built app's shell (app.html) is on disk
// beside the server. Checked per call, not once at boot, so a deploy that
// adds or removes the build is picked up without a restart. MARKIE_WEB_DIST
// points somewhere else, which is how tests switch it on and off.
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIR = fileURLToPath(new URL("../web-dist/", import.meta.url));
const SHELL = "app.html";

export function webAppAvailable(dir: string = process.env.MARKIE_WEB_DIST || DEFAULT_DIR): boolean {
  try {
    return statSync(resolve(dir, SHELL)).isFile();
  } catch {
    return false;
  }
}
