import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The IPC surface is three lists that must stay identical: the channels
 * `main.js` registers, the channels `preload.js` talks to, and the members
 * `ElectronAPI` declares. Nothing at runtime checks that — a renamed channel
 * is a silent no-op or an "No handler registered" rejection in production.
 *
 * Everything here is pure text analysis so the test never loads Electron.
 */

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, root)), "utf8");

const mainSrc = read("electron/main.js");
const preloadSrc = read("electron/preload.js");
const electronTs = read("src/lib/electron.ts");

const all = (src: string, re: RegExp) => [...src.matchAll(re)].map((m) => m[1]);
const uniq = (xs: string[]) => [...new Set(xs)].sort();

// --- main.js ---------------------------------------------------------------

// Track 1 wraps ipcMain.handle in a local `handle()`; match both, and tolerate
// the channel sitting on the next line.
const mainHandled = uniq(
  all(mainSrc, /(?:ipcMain\.handle|(?<![\w.])handle)\(\s*"([a-z0-9-]+)"/g)
);
const mainOn = uniq(all(mainSrc, /ipcMain\.on\(\s*"([a-z0-9-]+)"/g));
// webContents.send(...) and thin wrappers around it (sendUpdate, sendAll, ...)
const mainSends = uniq(all(mainSrc, /\bsend[A-Za-z]*\(\s*"([a-z0-9-]+)"/g));

// --- preload.js ------------------------------------------------------------

const preloadInvokes = uniq(all(preloadSrc, /ipcRenderer\.invoke\(\s*"([a-z0-9-]+)"/g));
const preloadSends = uniq(
  all(preloadSrc, /ipcRenderer\.(?:send|sendSync)\(\s*"([a-z0-9-]+)"/g)
);
const preloadSubscribes = uniq(
  all(preloadSrc, /(?:subscribe|ipcRenderer\.on)\(\s*"([a-z0-9-]+)"/g)
);

function preloadKeys(): string[] {
  const start = preloadSrc.indexOf('contextBridge.exposeInMainWorld("electronAPI", {');
  expect(start, "exposeInMainWorld(\"electronAPI\") not found").toBeGreaterThan(-1);
  return uniq(all(preloadSrc.slice(start), /^ {2}([A-Za-z_$][\w$]*):/gm));
}

// --- src/lib/electron.ts ---------------------------------------------------

function apiMembers(): string[] {
  const start = electronTs.indexOf("export interface ElectronAPI {");
  expect(start, "ElectronAPI interface not found").toBeGreaterThan(-1);
  const body = electronTs.slice(start, electronTs.indexOf("\n}\n", start));
  return uniq(all(body, /^ {2}([A-Za-z_$][\w$]*)\??\s*[(:]/gm));
}

describe("IPC contract", () => {
  it("parses a non-trivial surface out of each file", () => {
    expect(mainHandled.length).toBeGreaterThan(40);
    expect(preloadInvokes.length).toBeGreaterThan(40);
    expect(preloadKeys().length).toBeGreaterThan(50);
    expect(apiMembers().length).toBeGreaterThan(50);
  });

  it("registers every channel the renderer invokes", () => {
    const missing = preloadInvokes.filter((c) => !mainHandled.includes(c));
    expect(
      missing,
      `preload invokes channels main.js never handles: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("registers every channel the renderer sends", () => {
    const missing = preloadSends.filter((c) => !mainOn.includes(c));
    expect(
      missing,
      `preload sends on channels main.js never listens to: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("has a main-process sender for every channel the renderer subscribes to", () => {
    const missing = preloadSubscribes.filter((c) => !mainSends.includes(c));
    expect(
      missing,
      `preload subscribes to channels main.js never sends: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("leaves no handler in main.js the renderer cannot reach", () => {
    const reachable = new Set([...preloadInvokes, ...preloadSends]);
    const orphans = [...mainHandled, ...mainOn].filter((c) => !reachable.has(c));
    expect(
      orphans,
      `main.js registers handlers no preload API reaches (dead code, or a preload key was dropped): ${orphans.join(", ")}`
    ).toEqual([]);
  });

  it("exposes every ElectronAPI member from preload", () => {
    const keys = new Set(preloadKeys());
    const missing = apiMembers().filter((m) => !keys.has(m));
    expect(
      missing,
      `ElectronAPI declares members preload does not expose: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("declares every preload key in ElectronAPI", () => {
    const members = new Set(apiMembers());
    const extra = preloadKeys().filter((k) => !members.has(k));
    expect(
      extra,
      `preload exposes keys ElectronAPI does not declare (the renderer cannot use them): ${extra.join(", ")}`
    ).toEqual([]);
  });

  it("keeps the update channels wired end to end", () => {
    // Regression guard for the flow the release runbook depends on.
    for (const ch of ["check-for-updates", "update-status", "quit-and-install"]) {
      expect(mainHandled, `${ch} handler`).toContain(ch);
      expect(preloadInvokes, `${ch} invoke`).toContain(ch);
    }
    for (const ch of ["update-available", "update-progress", "update-ready"]) {
      expect(mainSends, `${ch} sender`).toContain(ch);
      expect(preloadSubscribes, `${ch} subscription`).toContain(ch);
    }
  });
});

// The sync-config handler is the one place the asset cache is told whose
// pictures it is holding. It used to fire the wipe and return, so the
// renderer's next request could be answered out of the outgoing session's
// files: same machine, same person, millisecond window. The generation
// counter closes the in-flight-fetch race, but not a cache hit that resolves
// before wipeTo has bumped it. main.js cannot be loaded without Electron, so
// this reads the source, the way the channel lists above do.
describe("the sync-config handler", () => {
  const body = (() => {
    const start = mainSrc.indexOf('handle("sync-config"');
    expect(start, "the sync-config handler should exist").toBeGreaterThan(-1);
    const end = mainSrc.indexOf('\nhandle("', start + 1);
    return mainSrc.slice(start, end === -1 ? mainSrc.length : end);
  })();

  it("waits for the cache to be bound before it answers", () => {
    expect(body).toMatch(/await\s+assetCache\.bindSession\(/);
    // A fire-and-forget `void` on the same call is exactly what this replaces.
    expect(body).not.toMatch(/void\s+assetCache\.bindSession\(/);
  });

  it("still falls back to a marker when the wipe cannot finish", () => {
    // Disk trouble or a locked file must not turn signing in into an error;
    // the cache finishes the job the next time it starts.
    expect(body).toMatch(/assetCache\.markPendingClear\(\)/);
  });
});
