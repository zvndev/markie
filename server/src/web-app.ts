// Whether this server is serving the Markie web app (/app, /app/d/:id,
// /app/new). It is, exactly when the built app is on disk beside the server.
// Checked per call, not once at boot, so a deploy that adds or removes the
// build is picked up without a restart. MARKIE_WEB_DIST points somewhere else,
// which is how tests switch it on and off.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_WEB_DIST = fileURLToPath(new URL("../web-dist/", import.meta.url));

export function webAppAvailable(): boolean {
  return existsSync(join(process.env.MARKIE_WEB_DIST || DEFAULT_WEB_DIST, "index.html"));
}
