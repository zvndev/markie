// Features that ship only in the super-nightly build, so Kirby can try and
// reshape them before anyone else sees them (docs/superpowers/specs/
// 2026-10-30-doc-features-nightly.md). The private build launches with
// --markie-private-release, which preload turns into privateReleaseAuthOrigin;
// stable and beta builds never set it. The private gate mounts no document
// UI until the owner is authorized, so reaching this check means it is Kirby.
//
// In `npm run dev`, localStorage "markie.nightly" = "1" turns them on too.
// Production stable builds ignore that key, so it cannot unlock anything.
import { getElectronAPI, type ElectronAPI } from "@/lib/electron";

export const NIGHTLY_STORAGE_KEY = "markie.nightly";

export function nightlyFeaturesEnabled(
  {
    api = getElectronAPI(),
    dev = import.meta.env.DEV,
    storage = globalThis.localStorage as Storage | undefined,
  }: { api?: Pick<ElectronAPI, "privateReleaseAuthOrigin"> | null; dev?: boolean; storage?: Storage } = {}
): boolean {
  if (api?.privateReleaseAuthOrigin) return true;
  if (!dev) return false;
  try {
    return storage?.getItem(NIGHTLY_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}
