import { vi } from "vitest";
import type {
  ElectronAPI,
  LibraryItem,
  Unsubscribe,
} from "@/lib/electron";

/**
 * A complete, in-memory stand-in for the `window.electronAPI` bridge that
 * `preload.js` exposes. Component tests install it with `installBridge()` and
 * then drive main-process pushes with `emit()`.
 *
 * Every key of `ElectronAPI` must be present here — `mock-bridge.test.ts`
 * re-derives the interface members from `src/lib/electron.ts` at run time and
 * fails when the interface grows without the mock following.
 */

type Listener = (...args: unknown[]) => void;

const listeners = new Map<string, Set<Listener>>();

/** Method-name → IPC channel, for the handful that don't kebab-case cleanly. */
const CHANNEL_OVERRIDES: Record<string, string> = {
  onMdIndexUpdated: "mdindex-updated",
};

/** `onMenuSaveAs` → `menu-save-as`. */
export function channelForMethod(method: string): string {
  if (CHANNEL_OVERRIDES[method]) return CHANNEL_OVERRIDES[method];
  return method
    .replace(/^on/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function keyFor(channelOrMethod: string): string {
  return channelOrMethod.startsWith("on")
    ? channelForMethod(channelOrMethod)
    : channelOrMethod;
}

function subscribe(method: string) {
  const channel = channelForMethod(method);
  return (cb: Listener): Unsubscribe => {
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
    };
  };
}

/** Fire a main-process push. Accepts the IPC channel or the `onX` method name. */
export function emit(channelOrMethod: string, ...args: unknown[]): void {
  const set = listeners.get(keyFor(channelOrMethod));
  if (!set) return;
  for (const cb of [...set]) cb(...args);
}

/** How many renderer listeners are attached — used to assert cleanup. */
export function listenerCount(channelOrMethod?: string): number {
  if (channelOrMethod === undefined) {
    let total = 0;
    for (const set of listeners.values()) total += set.size;
    return total;
  }
  return listeners.get(keyFor(channelOrMethod))?.size ?? 0;
}

/** Drop every subscription. Called from `src/test/setup.ts` after each test. */
export function clearBridge(): void {
  listeners.clear();
}

const noopResult = { ok: true } as const;

export function makeBridge(overrides: Partial<ElectronAPI> = {}): ElectronAPI {
  const bridge = {
    platform: "darwin",

    openFile: vi.fn(async () => null),
    openFilePath: vi.fn(async () => null),
    pathForFile: vi.fn(() => null),
    setDefaultMarkdownApp: vi.fn(async () => ({ ok: true })),
    defaultMarkdownStatus: vi.fn(async () => ({
      supported: true,
      isDefault: false,
    })),

    // Workspace / Files view
    wsRoots: vi.fn(async () => [] as string[]),
    wsDefaultPath: vi.fn(async () => "/Users/test/Markie"),
    wsCreateDefault: vi.fn(async () => ({ ok: true, path: "/Users/test/Markie" })),
    wsAddRoot: vi.fn(async () => ({ ok: true, path: "/Users/test/Markie" })),
    wsRemoveRoot: vi.fn(async () => noopResult),
    wsListDir: vi.fn(async () => ({ folders: [], files: [] })),
    wsMkdir: vi.fn(async () => noopResult),
    wsNewFile: vi.fn(async () => noopResult),
    wsMove: vi.fn(async () => noopResult),
    wsRename: vi.fn(async () => noopResult),
    wsTrash: vi.fn(async () => noopResult),
    wsReveal: vi.fn(async () => noopResult),

    // Terminal
    termAvailable: vi.fn(async () => false),
    termCreate: vi.fn(async () => null),
    termWrite: vi.fn(async () => undefined),
    termResize: vi.fn(async () => undefined),
    termKill: vi.fn(async () => undefined),
    onTermData: vi.fn(subscribe("onTermData")),
    onTermExit: vi.fn(subscribe("onTermExit")),
    termExternalApps: vi.fn(async () => []),
    termOpenExternal: vi.fn(async () => noopResult),

    getInitialFile: vi.fn(async () => null),
    exportPDF: vi.fn(async () => ({ success: true, path: "/tmp/out.pdf" })),
    exportHTML: vi.fn(async () => ({ success: true, path: "/tmp/out.html" })),
    saveFile: vi.fn(async () => ({ success: true, path: "/tmp/doc.md" })),
    saveFileAs: vi.fn(async () => ({ success: true, path: "/tmp/doc.md" })),
    renameFile: vi.fn(async () => ({ success: true, path: "/tmp/doc.md" })),
    revealFile: vi.fn(async () => noopResult),
    logRendererError: vi.fn(() => undefined),

    // Menu pushes
    onMenuOpenFile: vi.fn(subscribe("onMenuOpenFile")),
    onMenuNewFile: vi.fn(subscribe("onMenuNewFile")),
    onMenuExportPDF: vi.fn(subscribe("onMenuExportPDF")),
    onMenuExportHTML: vi.fn(subscribe("onMenuExportHTML")),
    onMenuSave: vi.fn(subscribe("onMenuSave")),
    onMenuSaveAs: vi.fn(subscribe("onMenuSaveAs")),
    onMenuFork: vi.fn(subscribe("onMenuFork")),
    onMenuReveal: vi.fn(subscribe("onMenuReveal")),
    onMenuFormatTables: vi.fn(subscribe("onMenuFormatTables")),
    onMenuFind: vi.fn(subscribe("onMenuFind")),
    onMenuPrint: vi.fn(subscribe("onMenuPrint")),
    onMenuZoom: vi.fn(subscribe("onMenuZoom")),
    onMenuUndo: vi.fn(subscribe("onMenuUndo")),
    onMenuRedo: vi.fn(subscribe("onMenuRedo")),
    onMenuFindReplace: vi.fn(subscribe("onMenuFindReplace")),
    onMenuCommandPalette: vi.fn(subscribe("onMenuCommandPalette")),
    onMenuShortcuts: vi.fn(subscribe("onMenuShortcuts")),
    onMenuTheme: vi.fn(subscribe("onMenuTheme")),
    onMenuSettings: vi.fn(subscribe("onMenuSettings")),
    onMenuLibrary: vi.fn(subscribe("onMenuLibrary")),
    onDeepLink: vi.fn(subscribe("onDeepLink")),

    openExternal: vi.fn(async () => undefined),
    syncConfig: vi.fn(async () => undefined),
    syncDocRole: vi.fn(async () => undefined),

    registryTrack: vi.fn(async () => noopResult),
    registryGet: vi.fn(async () => null),
    registrySetRole: vi.fn(async () => noopResult),
    libraryState: vi.fn(async () => ({
      signedIn: false,
      items: [] as LibraryItem[],
    })),

    docSyncOn: vi.fn(async () => noopResult),
    docSyncOff: vi.fn(async () => noopResult),
    docPush: vi.fn(async () => ({ ok: true, pushed: true })),
    docResolve: vi.fn(async () => noopResult),
    docPull: vi.fn(async () => noopResult),
    docRetryPush: vi.fn(async () => ({ ok: true, pushed: true })),
    docCheckUpdates: vi.fn(async () => ({ updates: [] })),
    docRemoteContent: vi.fn(async () => ({ ok: true, content: "", version: 1 })),
    docKeepBoth: vi.fn(async () => noopResult),
    docOpenShared: vi.fn(async () => ({ ok: true, path: "/tmp/shared.md" })),

    onSetMode: vi.fn(subscribe("onSetMode")),
    onToggleStats: vi.fn(subscribe("onToggleStats")),
    onFileOpened: vi.fn(subscribe("onFileOpened")),
    onFileChangedOnDisk: vi.fn(subscribe("onFileChangedOnDisk")),
    watchFile: vi.fn(async () => ({ ok: true })),
    onAppWillClose: vi.fn(subscribe("onAppWillClose")),
    appCloseReady: vi.fn(() => undefined),
    draftSave: vi.fn(async () => noopResult),
    draftCheck: vi.fn(async () => []),
    draftDiscard: vi.fn(async () => noopResult),
    historyList: vi.fn(async () => []),
    historyRead: vi.fn(async () => ({ content: null })),
    onMenuHistory: vi.fn(subscribe("onMenuHistory")),

    // Crash reporting (consent-gated; off and unavailable by default in tests)
    crashConsentGet: vi.fn(async () => ({ enabled: false, available: false })),
    crashConsentSet: vi.fn(async (enabled: boolean) => ({ ok: true, enabled })),
    crashLogReveal: vi.fn(async () => ({ ok: true })),

    // Auto-update
    checkForUpdates: vi.fn(async () => ({ ok: true })),
    updateStatus: vi.fn(async () => "idle"),
    updateChannelGet: vi.fn(async () => ({ optedIn: false, currentVersion: "0.0.0" })),
    updateChannelSet: vi.fn(async (optedIn: boolean) => ({ ok: true, optedIn })),
    quitAndInstall: vi.fn(async () => ({ ok: true })),
    onUpdateAvailable: vi.fn(subscribe("onUpdateAvailable")),
    onUpdateProgress: vi.fn(subscribe("onUpdateProgress")),
    onUpdateReady: vi.fn(subscribe("onUpdateReady")),

    // Browse — device-wide markdown index
    mdIndexScan: vi.fn(async () => ({ files: [], scannedAt: null })),
    mdIndexRefresh: vi.fn(async () => ({ files: [], scannedAt: null })),
    mdIndexStars: vi.fn(async () => []),
    mdIndexToggleStar: vi.fn(async () => ({ starred: true })),
    onMdIndexUpdated: vi.fn(subscribe("onMdIndexUpdated")),

    // Projects — the virtual organization layer. Empty state by default: a
    // component test that wants a taxonomy supplies the index rows itself.
    projectsState: vi.fn(async () => ({
      pins: [],
      blocks: [],
      assignments: [],
      fingerprint: "",
      rulesKnownGood: null,
      rulesError: null,
    })),
    projectsSaveCache: vi.fn(async () => ({ ok: true })),
    projectsPin: vi.fn(async () => ({ ok: true })),
    projectsBlockSet: vi.fn(async () => ({ ok: true })),
    projectsConfig: vi.fn(async () => ({
      path: "/home/u/Documents/Markie/Projects.md",
      content: "",
      created: false,
      home: "/home/u",
    })),
    projectsWriteOverview: vi.fn(async () => ({ ok: true, path: "/home/u/Documents/Markie/Projects.md" })),

    mcpInfo: vi.fn(async () => ({
      serverPath: "/tmp/markie-mcp.mjs",
      packaged: false,
    })),
  } as unknown as ElectronAPI;

  return Object.assign(bridge, overrides);
}

/** Install a fresh bridge on `window.electronAPI` and return it. */
export function installBridge(overrides: Partial<ElectronAPI> = {}): ElectronAPI {
  clearBridge();
  const bridge = makeBridge(overrides);
  (window as unknown as { electronAPI?: ElectronAPI }).electronAPI = bridge;
  return bridge;
}
