// Every script in scripts/ that launches a real Electron window goes through
// this gate. Running the app on a developer's own Mac is not a free action:
// a fresh profile with the real $HOME can index, watch, and register things
// the developer did not ask for, and on 2026-08-24 an automated run of
// crash-check.mjs took Finder down with it. So a real-window run is a
// deliberate act, opted into per shell, never something an agent or a
// stray `npm run` does on its own.
//
// Set MARKIE_ALLOW_E2E=1 to run. CI sets it in the workflow env.

import { argv } from "node:process";
import { fileURLToPath } from "node:url";

export function requireElectronConsent(scriptName, moduleUrl) {
  // Only enforce when the script is the process entry point. A test that
  // imports the module for its helpers must not trip the gate (and exit the
  // test runner). Pass import.meta.url from the call site.
  if (moduleUrl) {
    try {
      if (fileURLToPath(moduleUrl) !== argv[1]) return;
    } catch {
      /* fall through and enforce */
    }
  }
  if (process.env.MARKIE_ALLOW_E2E === "1") return;
  process.stderr.write(
    `${scriptName}: refusing to launch a real Electron window without consent.\n` +
      `This script boots Markie on this machine. If that is what you want, run:\n` +
      `  MARKIE_ALLOW_E2E=1 npm run <script>\n` +
      `See scripts/lib/e2e-consent.mjs for why this gate exists.\n`
  );
  process.exit(2);
}
