// The app: who is signed in, which screens are stacked, and where tapped
// links go. Screens below receive only what they need.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App as CapApp } from "@capacitor/app";
import { Capacitor, CapacitorCookies } from "@capacitor/core";
import { createApiClient, type ApiUser } from "./lib/api";
import type { HttpTransport } from "./lib/http";
import {
  clearPendingLink,
  hasPendingLink,
  isMarkieWebLink,
  parseMarkieLink,
  rememberPendingLink,
  resolveForSession,
  takePendingLink,
  type LinkTarget,
} from "./lib/deep-links";
import { IncomingFileError, isIncomingFileUrl, readIncomingFile, type IncomingFile } from "./lib/incoming-file";
import { createSessionStore, type SecureKeyValue, type StoredSession } from "./lib/session";
import { loadPreferredOrigin, savePreferredOrigin } from "./lib/server-origin";
import { loadThemeMode, paintTone, resolveTone, saveThemeMode, systemPrefersDark, type ThemeMode } from "./lib/theme-mode";
import { openExternal, setSystemBars } from "./lib/native";
import { Navigator, type StackEntry } from "./components/navigator";
import { SignInScreen } from "./screens/sign-in";
import { clearRecentCache, RecentScreen } from "./screens/recent";
import { DocumentScreen } from "./screens/document";
import { SettingsScreen } from "./screens/settings";
import { EditorScreen, type EditorDraft } from "./screens/editor";
import { NewDocScreen } from "./screens/new-doc";
import { IncomingScreen } from "./screens/incoming";

type Route =
  | { key: string; kind: "recent" }
  | { key: string; kind: "settings" }
  | { key: string; kind: "doc"; target: LinkTarget; name?: string; reloadKey?: number }
  | { key: string; kind: "new" }
  | { key: string; kind: "edit"; draft: EditorDraft }
  | { key: string; kind: "file"; file: IncomingFile };

const ROOT: Route = { key: "recent", kind: "recent" };
const SERVER_SIGN_OUT_TIMEOUT_MS = 3_000;
let routeSeq = 0;
const nextKey = (prefix: string) => `${prefix}-${++routeSeq}`;

interface AppProps {
  transport: HttpTransport;
  secure: SecureKeyValue;
  native: boolean;
}

/** An incoming file's bytes, served to the page by Capacitor's web view. */
async function fetchFileBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(Capacitor.convertFileSrc(url));
  if (!response.ok) throw new Error(`status ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function pendingStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function MarkieMobileApp({ transport, secure, native }: AppProps) {
  const sessionStore = useMemo(() => createSessionStore(secure), [secure]);
  // undefined while the Keychain is read at launch.
  const [session, setSession] = useState<StoredSession | null | undefined>(undefined);
  const sessionRef = useRef<StoredSession | null | undefined>(undefined);
  sessionRef.current = session;
  const [routes, setRoutes] = useState<Route[]>([ROOT]);
  const [hasPending, setHasPending] = useState(false);
  const [signInNotice, setSignInNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [preferredOrigin, setPreferredOrigin] = useState(() => loadPreferredOrigin());
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => loadThemeMode());
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());
  const [refreshKey, setRefreshKey] = useState(0);
  const tone = resolveTone(themeMode, systemDark);

  // Theme: the desktop's Markie tokens, light or dark, and the status bar to match.
  useEffect(() => {
    paintTone(tone);
    setSystemBars(tone);
  }, [tone]);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const change = () => setSystemDark(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);

  const showToast = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(timer);
  }, [toast]);

  // Session: read once at launch.
  useEffect(() => {
    let live = true;
    void sessionStore.load().then((stored) => {
      if (!live) return;
      setSession(stored);
      const storage = pendingStorage();
      if (!stored && storage) setHasPending(hasPendingLink(storage));
    });
    return () => { live = false; };
  }, [sessionStore]);

  const persistRotatedToken = useCallback((token: string) => {
    const current = sessionRef.current;
    if (!current || current.token === token) return;
    const next = { ...current, token };
    sessionRef.current = next;
    void sessionStore.save(next).catch(() => undefined);
    setSession(next);
  }, [sessionStore]);

  // One client per signed-in identity; the token is read per request, so a
  // rotated token is used without rebuilding every screen.
  const apiIdentity = session ? `${session.origin}|${session.userId}|${session.email}` : null;
  const api = useMemo(() => {
    if (!apiIdentity || !sessionRef.current) return null;
    return createApiClient({
      origin: sessionRef.current.origin,
      transport,
      getToken: () => sessionRef.current?.token ?? null,
      onTokenRotated: persistRotatedToken,
    });
  }, [apiIdentity, transport, persistRotatedToken]);

  const openTarget = useCallback((target: LinkTarget, { replaceStack = false, name }: { replaceStack?: boolean; name?: string } = {}) => {
    const current = sessionRef.current;
    if (!current) return;
    const resolved = resolveForSession(target, current.origin);
    if (!resolved.ok) { showToast(resolved.message); return; }
    const route: Route = { key: nextKey("doc"), kind: "doc", target: resolved.target, name };
    setRoutes((stack) => {
      const top = stack[stack.length - 1];
      if (top.kind === "doc" && sameTarget(top.target, resolved.target)) return stack;
      return replaceStack ? [ROOT, route] : [...stack, route];
    });
  }, [showToast]);

  // A file from Mail, AirDrop or Files. Before sign-in it waits in memory
  // (never on disk) and opens once the person signs in.
  const pendingFile = useRef<IncomingFile | null>(null);
  const openFile = useCallback((file: IncomingFile) => {
    setRoutes([ROOT, { key: nextKey("file"), kind: "file", file }]);
  }, []);
  const receiveFile = useCallback(async (url: string) => {
    try {
      const file = await readIncomingFile(url, fetchFileBytes);
      if (sessionRef.current) { openFile(file); return; }
      pendingFile.current = file;
      setSignInNotice(`Sign in to open "${file.name}" and save it to Markie Cloud.`);
    } catch (error) {
      showToast(error instanceof IncomingFileError ? error.message : "Markie couldn't open that file.");
    }
  }, [openFile, showToast]);

  // Links from outside: universal links, app links and markie-mobile://.
  const lastUrl = useRef<{ url: string; at: number } | null>(null);
  const handleIncomingUrl = useCallback((url: string) => {
    const now = Date.now();
    // A cold start can report the same URL as both the launch URL and an open event.
    if (lastUrl.current && lastUrl.current.url === url && now - lastUrl.current.at < 3000) return;
    lastUrl.current = { url, at: now };
    if (isIncomingFileUrl(url)) { void receiveFile(url); return; }
    const target = parseMarkieLink(url, sessionRef.current?.origin ?? null);
    if (!target) {
      // Android app links can only claim path prefixes, so a /d/<id>/raw or
      // download link on a Markie host lands here too, and the browser is
      // where it belongs. Any other URL is not passed on: the activity that
      // takes links is exported, and Markie is not a way for another app to
      // open whatever it likes.
      if (isMarkieWebLink(url, sessionRef.current?.origin ?? null)) { void openExternal(url).catch(() => undefined); return; }
      showToast("That link isn't a Markie document link.");
      return;
    }
    if (!sessionRef.current) {
      const storage = pendingStorage();
      if (storage) rememberPendingLink(target, storage);
      setHasPending(true);
      return;
    }
    openTarget(target, { replaceStack: true });
  }, [openTarget, receiveFile, showToast]);

  const sessionKnown = session !== undefined;
  useEffect(() => {
    if (!native || !sessionKnown) return;
    let removed = false;
    const handles: { remove: () => Promise<void> }[] = [];
    void CapApp.getLaunchUrl().then((launch) => { if (!removed && launch?.url) handleIncomingUrl(launch.url); }).catch(() => undefined);
    void CapApp.addListener("appUrlOpen", (event) => handleIncomingUrl(event.url)).then((h) => { if (removed) void h.remove(); else handles.push(h); });
    void CapApp.addListener("resume", () => setRefreshKey((value) => value + 1)).then((h) => { if (removed) void h.remove(); else handles.push(h); });
    return () => { removed = true; for (const h of handles) void h.remove(); };
  }, [native, sessionKnown, handleIncomingUrl]);

  const pop = useCallback(() => setRoutes((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack)), []);
  // The editor answers Android's back button itself, so unsaved text is asked about first.
  const backGuard = useRef<(() => void) | null>(null);

  /** After a save: every open copy of that document reads it again, and so does the list. */
  const reloadDoc = useCallback((stack: Route[], id: string | null): Route[] => stack.map((route) =>
    route.kind === "doc" && (id === null || (route.target.kind === "doc" && route.target.id === id))
      ? { ...route, reloadKey: (route.reloadKey ?? 0) + 1 }
      : route), []);

  const editorSaved = useCallback(({ id, name, created }: { id: string; name: string; created: boolean }) => {
    setRefreshKey((value) => value + 1);
    setRoutes((stack) => {
      const withoutEditor = stack.slice(0, -1);
      if (!created) return reloadDoc(withoutEditor, id);
      // A new document replaces the editor, and the file it came from if any.
      const base = withoutEditor[withoutEditor.length - 1]?.kind === "file" ? withoutEditor.slice(0, -1) : withoutEditor;
      const origin = sessionRef.current?.origin ?? null;
      return [...base, { key: nextKey("doc"), kind: "doc", target: { kind: "doc", id, origin }, name }];
    });
  }, [reloadDoc]);

  // Android's back button walks the stack, then leaves the app as usual.
  const routesRef = useRef(routes);
  routesRef.current = routes;
  useEffect(() => {
    if (!native) return;
    let handle: { remove: () => Promise<void> } | null = null;
    let removed = false;
    void CapApp.addListener("backButton", () => {
      const top = routesRef.current[routesRef.current.length - 1];
      if (top.kind === "edit" && backGuard.current) { backGuard.current(); return; }
      if (routesRef.current.length > 1 && sessionRef.current) pop();
      else void CapApp.minimizeApp().catch(() => undefined);
    }).then((h) => { if (removed) void h.remove(); else handle = h; });
    return () => { removed = true; void handle?.remove(); };
  }, [native, pop]);

  const endSession = useCallback(async (notice: string | null) => {
    await sessionStore.clear().catch(() => undefined);
    if (native) await CapacitorCookies.clearAllCookies().catch(() => undefined);
    clearRecentCache();
    pendingFile.current = null;
    sessionRef.current = null;
    setSession(null);
    setRoutes([ROOT]);
    setSignInNotice(notice);
  }, [native, sessionStore]);

  // Any 401: the session is gone. Keep the open document so it reopens after sign-in.
  const onUnauthorized = useCallback(() => {
    const top = routesRef.current[routesRef.current.length - 1];
    if (top.kind === "doc") {
      const storage = pendingStorage();
      if (storage) rememberPendingLink(top.target, storage);
      setHasPending(true);
    }
    void endSession("Your session ended. Sign in again to continue.");
  }, [endSession]);

  const signOut = useCallback(async () => {
    // The phone forgets the session first, so "Sign out" is instant even
    // offline. Ending it on the server is a courtesy that follows, with the
    // token held only by this one request, capped at a few seconds.
    const ending = sessionRef.current;
    const storage = pendingStorage();
    if (storage) clearPendingLink(storage);
    setHasPending(false);
    await endSession(null);
    if (!ending) return;
    const courtesy = createApiClient({ origin: ending.origin, transport, getToken: () => ending.token });
    void courtesy.signOut({ timeoutMs: SERVER_SIGN_OUT_TIMEOUT_MS }).catch(() => undefined);
  }, [endSession, transport]);

  const signedIn = useCallback(async ({ origin, token, user }: { origin: string; token: string; user: ApiUser }) => {
    const next: StoredSession = { origin, token, email: user.email, name: user.name, userId: user.id };
    await sessionStore.save(next);
    savePreferredOrigin(origin);
    sessionRef.current = next;
    setSession(next);
    setSignInNotice(null);
    setRoutes([ROOT]);
    const storage = pendingStorage();
    const pending = storage ? takePendingLink(storage) : null;
    setHasPending(false);
    const file = pendingFile.current;
    pendingFile.current = null;
    if (file) openFile(file);
    else if (pending) openTarget(pending, { replaceStack: true });
  }, [openFile, openTarget, sessionStore]);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    saveThemeMode(mode);
    setThemeModeState(mode);
  }, []);

  if (session === undefined) return <div className="m-boot" aria-busy="true" />;

  if (!session || !api) {
    return (
      <>
        <SignInScreen
          transport={transport}
          initialOrigin={preferredOrigin}
          pendingLink={hasPending}
          notice={signInNotice}
          onSignedIn={signedIn}
          onOriginChange={(origin) => { setPreferredOrigin(origin); savePreferredOrigin(origin); }}
        />
        {toast ? <div className="m-toast" role="status">{toast}</div> : null}
      </>
    );
  }

  const entries: StackEntry[] = routes.map((route, index) => {
    const backLabel = index > 0 ? labelFor(routes[index - 1]) : "";
    if (route.kind === "recent") {
      return {
        key: route.key,
        node: (
          <RecentScreen
            api={api}
            refreshKey={refreshKey}
            onOpen={(doc) => openTarget({ kind: "doc", id: doc.id, origin: api.origin }, { name: doc.name })}
            onSettings={() => setRoutes((stack) => (stack[stack.length - 1].kind === "settings" ? stack : [...stack, { key: nextKey("settings"), kind: "settings" }]))}
            onNew={() => setRoutes((stack) => (stack[stack.length - 1].kind === "new" ? stack : [...stack, { key: nextKey("new"), kind: "new" }]))}
            onUnauthorized={onUnauthorized}
          />
        ),
      };
    }
    if (route.kind === "settings") {
      return {
        key: route.key,
        node: <SettingsScreen session={session} themeMode={themeMode} onThemeMode={setThemeMode} onSignOut={signOut} onBack={pop} />,
      };
    }
    if (route.kind === "new") {
      return {
        key: route.key,
        locked: true,
        node: (
          <NewDocScreen
            onCancel={pop}
            onStart={(draft) => setRoutes((stack) => [...stack.slice(0, -1), { key: nextKey("edit"), kind: "edit", draft: { kind: "new", ...draft } }])}
            onOpenFile={(file) => setRoutes((stack) => [...stack.slice(0, -1), { key: nextKey("file"), kind: "file", file }])}
          />
        ),
      };
    }
    if (route.kind === "edit") {
      return {
        key: route.key,
        locked: true,
        node: (
          <EditorScreen
            api={api}
            draft={route.draft}
            backGuard={backGuard}
            onCancel={(reload) => setRoutes((stack) => (reload ? reloadDoc(stack.slice(0, -1), route.draft.kind === "cloud" ? route.draft.id : null) : stack.slice(0, -1)))}
            onSaved={editorSaved}
            onUnauthorized={onUnauthorized}
          />
        ),
      };
    }
    if (route.kind === "file") {
      return {
        key: route.key,
        node: (
          <IncomingScreen
            api={api}
            file={route.file}
            fileKey={route.key}
            tone={tone}
            backLabel={backLabel}
            onBack={pop}
            onEdit={() => setRoutes((stack) => [...stack, { key: nextKey("edit"), kind: "edit", draft: { kind: "new", name: route.file.name, format: route.file.format, content: route.file.content } }])}
            onSaved={({ id, name }) => {
              setRefreshKey((value) => value + 1);
              setRoutes((stack) => stack.map((item) => (item.key === route.key ? { key: nextKey("doc"), kind: "doc", target: { kind: "doc", id, origin: api.origin }, name } : item)));
            }}
            onOpen={(target) => openTarget(target)}
            onUnauthorized={onUnauthorized}
          />
        ),
      };
    }
    return {
      key: route.key,
      node: (
        <DocumentScreen
          api={api}
          target={route.target}
          initialName={route.name}
          backLabel={backLabel}
          tone={tone}
          onBack={pop}
          onRecent={() => setRoutes([ROOT])}
          onOpen={(target) => openTarget(target)}
          onEdit={(doc) => {
            if (doc.version === null) return;
            const draft: EditorDraft = { kind: "cloud", id: doc.id, name: doc.name, format: doc.format, content: doc.content, version: doc.version };
            setRoutes((stack) => [...stack, { key: nextKey("edit"), kind: "edit", draft }]);
          }}
          reloadKey={route.reloadKey}
          onUnauthorized={onUnauthorized}
        />
      ),
    };
  });

  return (
    <>
      <Navigator entries={entries} onPop={pop} />
      {toast ? <div className="m-toast" role="status">{toast}</div> : null}
    </>
  );
}

function sameTarget(a: LinkTarget, b: LinkTarget): boolean {
  if (a.kind !== b.kind || a.origin !== b.origin) return false;
  return a.kind === "doc" ? a.id === (b as typeof a).id : a.token === (b as typeof a).token;
}

function labelFor(route: Route): string {
  if (route.kind === "recent") return "Recent";
  if (route.kind === "settings") return "Settings";
  return "Back";
}
