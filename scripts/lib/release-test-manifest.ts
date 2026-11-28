// The release manifest as it stood before the Mac cutover: one mac/ feed for
// both Mac arches, Electron on both. The early-access, promotion and Linux
// release tests model that pipeline, which still runs for any manifest without
// a macCutover block; the cutover's own tests are in release-cutover.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const currentManifest = () =>
  JSON.parse(readFileSync(path.join(repoRoot, "server/download-manifest.json"), "utf8"));

export function preCutoverManifest() {
  const manifest = currentManifest();
  delete manifest.macCutover;
  delete manifest.betaChannel.macIntelFeed;
  const intel = manifest.platforms.find((platform: { id: string }) => platform.id === "mac-x64");
  intel.feed = { ...intel.feed, path: "mac/latest-mac.yml" };
  delete intel.fallbackFeed;
  return manifest;
}
