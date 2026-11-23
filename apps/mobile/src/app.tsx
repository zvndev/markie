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
  peekPendingLink,
  rememberPendingLink,
  resolveForSession,
  signedOutDestination,
  takePendingLink,
  type LinkTarget,
  type PinnedPublicTarget,
  type PublicTarget,
} from "./lib/deep-links";
import { IncomingFileError, isIncomingFileUrl, readIncomingFile, type IncomingFile } from "./lib/incoming-file";
import { createSessionStore, type SecureKeyValue, type StoredSession } from "./lib/session";
import { createOfflineStore, platformOfflineBackend, type OfflineSession } from "./lib/offline-store";
import { createOfflineApi, offlineOf } from "./lib/offline-api";
import { loadPreferredOrigin, savePreferredOrigin } from "./lib/server-origin";
import { loadThemeMode, paintTone, resolveTone, saveThemeMode, systemPrefersDark, type ThemeMode } from "./lib/theme-mode";
import { openExternal, setSystemBars } from "./lib/native";
import { pushController } from "./lib/push";
import { Navigator, type StackEntry } from "./components/navigator";
import { SignInScreen } from "./screens/sign-in";
import { clearRecentCache, RecentScreen } from "./screens/recent";
import { DocumentScreen } from "./screens/document";
import { PublicDocScreen } from "./screens/public-doc";
import { SettingsScreen } from "./screens/settings";
import { EditorScreen, type EditorDraft } from "./screens/editor";
import { NewDocChooser, NewDocScreen } from "./screens/new-doc";
import { OfficeScreen } from "./screens/office";
import type { NewDocType } from "./lib/docs";
import { IncomingScreen } from "./screens/incoming";
import { RequestsScreen } from "./screens/requests";
import { createLocalFiles, LocalFileError, NativeLocalFiles } from "./lib/local-files";
import { isLocalRoute, localEntry, type LocalHost, type LocalRoute } from "./screens/local";

type Route =
  | { key: string; kind: "recent" }
  | { key: string; kind: "settings" }
  | { key: string; kind: "requests" }
  | { key: string; kind: "doc"; target: LinkTarget; name?: string; reloadKey?: number; sharedBy?: string | null }
  | { key: string; kind: "new"; type: NewDocType }
  | { key: string; kind: "office"; id: string; name?: string; startEditing?: boolean }
  | { key: string; kind: "edit"; draft: EditorDraft }
  | { key: string; kind: "file"; file: IncomingFile }
  // Files on this phone (screens/local.tsx). The same routes make up the signed-out stack.
  | LocalRoute;

/**
 * What a signed-out person can have open besides the sign-in screen: one
 * public share, read with no session. A private document is never one of
 * these; it waits for sign-in (signedOutDestination).
 */
type SignedOutRoute = { kind: "public"; target: PinnedPublicTarget };

const ROOT: Route = { key: "recent", kind: "recent" };
const LOCAL_HOME: LocalRoute = { key: "local-home", kind: "local-home" };
const NOBODY = { id: "", name: "", email: "" };
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
  const push = useMemo(() => pushController(), []);
  // Opened documents kept for reading with no network (lib/offline-store.ts).
  // It belongs to one account, and is wiped whenever that account leaves.
  const offlineStore = useMemo(() => createOfflineStore(platformOfflineBackend()), []);
  const [offlineSession, setOfflineSession] = useState<OfflineSession | null>(null);
  // undefined while the Keychain is read at launch.
  const [session, setSession] = useState<StoredSession | null | undefined>(undefined);
  const sessionRef = useRef<StoredSession | null | undefined>(undefined);
  sessionRef.current = session;
  const [routes, setRoutes] = useState<Route[]>([ROOT]);
  const [signedOutRoute, setSignedOutRoute] = useState<SignedOutRoute | null>(null);
  const signedOutRouteRef = useRef<SignedOutRoute | null>(null);
  signedOutRouteRef.current = signedOutRoute;
  // The waiting link, when it is a public share, so the sign-in screen can
  // offer the way back to it. Pinned to a server only when it is opened: a
  // markie-mobile:// link follows the server chosen under Advanced.
  const [waitingPublic, setWaitingPublic] = useState<PublicTarget | null>(null);
  const [hasPending, setHasPending] = useState(false);
  const [signInNotice, setSignInNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [preferredOrigin, setPreferredOrigin] = useState(() => loadPreferredOrigin());
  const preferredOriginRef = useRef(preferredOrigin);
  preferredOriginRef.current = preferredOrigin;
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => loadThemeMode());
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());
  const [refreshKey, setRefreshKey] = useState(0);
  // The desktop's New document chooser, over whichever screen asked for it.
  const [chooser, setChooser] = useState(false);
  const chooserRef = useRef(false);
  chooserRef.current = chooser;
  const tone = resolveTone(themeMode, systemDark);
  // Local mode: files and folders on this phone, with or without an account.
  // Only a device has them; in a desktop browser the entries are not shown.
  const localFiles = useMemo(() => (native ? createLocalFiles(NativeLocalFiles) : null), [native]);
  // The signed-out stack: empty, or "On this phone" and what was opened from it.
  const [guestStack, setGuestStack] = useState<LocalRoute[]>([]);
  const guestStackRef = useRef(guestStack);
  guestStackRef.current = guestStack;

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
    void sessionStore.load().then(async (stored) => {
      // No session at launch wipes the store; another account's is wiped too.
      const kept = await offlineStore.start(stored ? { origin: stored.origin, userId: stored.userId, email: stored.email } : null).catch(() => null);
      if (!live) return;
      setOfflineSession(kept);
      setSession(stored);
      const storage = pendingStorage();
      if (stored || !storage) return;
      setHasPending(hasPendingLink(storage));
      // A relaunch in the middle of signing in lands on the sign-in screen,
      // with the way back to a public share it was reading.
      const waiting = peekPendingLink(storage);
      setWaitingPublic(waiting?.kind === "public" ? waiting : null);
    });
    return () => { live = false; };
  }, [sessionStore, offlineStore]);

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
    const client = createApiClient({
      origin: sessionRef.current.origin,
      transport,
      getToken: () => sessionRef.current?.token ?? null,
      onTokenRotated: persistRotatedToken,
    });
    // The same client, with the phone's store behind it for when the
    // network isn't there. Without a store it is the plain client.
    // push.watch: the same client again, asking about notifications once,
    // after a first comment or share goes through (src/lib/push.ts).
    return push.watch(offlineSession ? createOfflineApi(client, offlineSession) : client);
  }, [apiIdentity, transport, persistRotatedToken, offlineSession, push]);
  // Push: this phone is filed under whoever is signed in, and under nobody
  // once they are not.
  useEffect(() => { push.setApi(api); }, [push, api]);

  const openTarget = useCallback((target: LinkTarget, { replaceStack = false, name, sharedBy = null }: { replaceStack?: boolean; name?: string; sharedBy?: string | null } = {}) => {
    const current = sessionRef.current;
    if (!current) return;
    const resolved = resolveForSession(target, current.origin);
    if (!resolved.ok) { showToast(resolved.message); return; }
    const route: Route = { key: nextKey("doc"), kind: "doc", target: resolved.target, name, sharedBy };
    setRoutes((stack) => {
      const top = stack[stack.length - 1];
      if (top.kind === "doc" && sameTarget(top.target, resolved.target)) {
        // Already open. A notification about another thread still shows it.
        const thread = threadOf(resolved.target);
        return thread && thread !== threadOf(top.target) ? [...stack.slice(0, -1), { ...top, target: resolved.target }] : stack;
      }
      return replaceStack ? [ROOT, route] : [...stack, route];
    });
  }, [showToast]);

  // The reader for a signed-out person: a client that holds no token at all,
  // so a public share is fetched exactly as a browser would fetch it.
  const guestOrigin = signedOutRoute?.target.origin ?? null;
  const guestApi = useMemo(() => (guestOrigin ? createApiClient({ origin: guestOrigin, transport }) : null), [guestOrigin, transport]);

  /**
   * A link with nobody signed in. Either kind is remembered, so it opens
   * after sign-in. A public share also opens now, to read; a private
   * document shows the sign-in screen, which says a document is waiting.
   */
  const openSignedOut = useCallback((target: LinkTarget) => {
    const storage = pendingStorage();
    if (storage) rememberPendingLink(target, storage);
    setHasPending(true);
    const destination = signedOutDestination(target, preferredOriginRef.current);
    setWaitingPublic(target.kind === "public" ? target : null);
    setSignedOutRoute(destination ? { kind: "public", target: destination } : null);
    setGuestStack([]);
  }, []);

  // A file from Mail, AirDrop or Files. Before sign-in it waits in memory
  // (never on disk) and opens once the person signs in.
  const pendingFile = useRef<IncomingFile | null>(null);
  const openFile = useCallback((file: IncomingFile) => {
    setRoutes([ROOT, { key: nextKey("file"), kind: "file", file }]);
  }, []);
  /** Puts a local route on whichever stack is showing: the signed-in one, or the signed-out one. */
  const pushLocal = useCallback((route: LocalRoute, { fromOutside = false }: { fromOutside?: boolean } = {}) => {
    if (sessionRef.current) { setRoutes((stack) => (fromOutside ? [ROOT, route] : [...stack, route])); return; }
    setSignedOutRoute(null);
    setGuestStack((stack) => (fromOutside || stack.length === 0 ? [LOCAL_HOME, route] : [...stack, route]));
  }, []);
  const receiveFile = useCallback(async (url: string) => {
    try {
      // A file the other app lets Markie change opens where it is and saves
      // back there, account or not. Anything else is a copy, as before.
      const adopted = localFiles ? await localFiles.adopt(url) : { grant: null, name: null };
      let file: IncomingFile;
      if (adopted.grant && localFiles) {
        const doc = await localFiles.open({ grantId: adopted.grant.id, entry: null });
        if (doc.shape) { pushLocal({ key: nextKey("local-doc"), kind: "local-doc", doc }, { fromOutside: true }); return; }
        // A converted or read-only file has nothing to save back to.
        void localFiles.forget(adopted.grant.id).catch(() => undefined);
        file = { name: doc.cloudName, format: doc.format, content: doc.content, convertedFrom: doc.convertedFrom };
      } else {
        file = await readIncomingFile(url, fetchFileBytes, adopted.name);
      }
      if (sessionRef.current) { openFile(file); return; }
      // Signed out: it opens to read now, and waits in memory (never on
      // disk) to be saved to Markie Cloud after sign-in.
      pendingFile.current = file;
      setSignInNotice(`Sign in to save "${file.name}" to Markie Cloud.`);
      pushLocal({ key: nextKey("local-copy"), kind: "local-copy", file }, { fromOutside: true });
    } catch (error) {
      showToast(error instanceof IncomingFileError || error instanceof LocalFileError ? error.message : "Markie couldn't open that file.");
    }
  }, [localFiles, openFile, pushLocal, showToast]);

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
    if (!sessionRef.current) { openSignedOut(target); return; }
    openTarget(target, { replaceStack: true });
  }, [openSignedOut, openTarget, receiveFile, showToast]);

  // A tapped push notification carries a Markie link. This is the one place
  // it enters the app, and it takes the same road as a link from outside, so
  // sign-in, the pending link and the server pin all apply to it. The push
  // listener (src/lib/push.ts) subscribes here and nowhere else.
  const openPushLink = useCallback((link: string) => handleIncomingUrl(link), [handleIncomingUrl]);

  const sessionKnown = session !== undefined;
  useEffect(() => {
    if (!native || !sessionKnown) return;
    return push.start(openPushLink);
  }, [native, sessionKnown, push, openPushLink]);
  useEffect(() => {
    if (!native || !sessionKnown) return;
    let removed = false;
    const handles: { remove: () => Promise<void> }[] = [];
    void CapApp.getLaunchUrl().then((launch) => { if (!removed && launch?.url) handleIncomingUrl(launch.url); }).catch(() => undefined);
    void CapApp.addListener("appUrlOpen", (event) => handleIncomingUrl(event.url)).then((h) => { if (removed) void h.remove(); else handles.push(h); });
    void CapApp.addListener("resume", () => setRefreshKey((value) => value + 1)).then((h) => { if (removed) void h.remove(); else handles.push(h); });
    return () => { removed = true; for (const h of handles) void h.remove(); };
  }, [native, sessionKnown, handleIncomingUrl]);

  // Development only, in a desktop browser, where no other app can send a
  // link: http://localhost:5174/?link=markie-mobile://s/<token> stands in
  // for a tap. The shipped build has no such door.
  useEffect(() => {
    if (!import.meta.env.DEV || native || !sessionKnown) return;
    const link = new URLSearchParams(window.location.search).get("link");
    if (link) handleIncomingUrl(link);
  }, [native, sessionKnown, handleIncomingUrl]);

  const pop = useCallback(() => setRoutes((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack)), []);
  // The editor answers Android's back button itself, so unsaved text is asked about first.
  const backGuard = useRef<(() => void) | null>(null);

  /** After a save: every open copy of that document reads it again, and so does the list. */
  const reloadDoc = useCallback((stack: Route[], id: string | null): Route[] => stack.map((route) =>
    route.kind === "doc" && (id === null || (route.target.kind === "doc" && route.target.id === id))
      ? { ...route, reloadKey: (route.reloadKey ?? 0) + 1 }
      : route), []);

  // Edits that waited for a connection go out when one is back. When that
  // changed anything (sent, or found to be a conflict), every open document
  // and the list read again, so no screen goes on showing "not sent".
  useEffect(() => {
    const handle = api ? offlineOf(api) : null;
    if (!handle) return;
    const send = () => {
      void handle.drain().then((result) => {
        if (!result.sent && !result.conflicts && !result.refused) return;
        setRefreshKey((value) => value + 1);
        setRoutes((stack) => reloadDoc(stack, null));
      }).catch(() => undefined);
    };
    send();
    window.addEventListener("online", send);
    return () => window.removeEventListener("online", send);
  }, [api, reloadDoc]);

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
      if (chooserRef.current) { setChooser(false); return; }
      if ((top.kind === "edit" || top.kind === "local-edit") && sessionRef.current && backGuard.current) { backGuard.current(); return; }
      // Signed out with files from this phone open: back walks that stack,
      // asking the editor first, and ends at the sign-in screen.
      if (!sessionRef.current && guestStackRef.current.length > 0) {
        const guestTop = guestStackRef.current[guestStackRef.current.length - 1];
        if (guestTop.kind === "local-edit" && backGuard.current) { backGuard.current(); return; }
        setGuestStack((stack) => stack.slice(0, -1));
        return;
      }
      // Signed out and reading a public share: back is the sign-in screen.
      if (!sessionRef.current && signedOutRouteRef.current) { setSignedOutRoute(null); return; }
      if (routesRef.current.length > 1 && sessionRef.current) pop();
      else void CapApp.minimizeApp().catch(() => undefined);
    }).then((h) => { if (removed) void h.remove(); else handle = h; });
    return () => { removed = true; void handle?.remove(); };
  }, [native, pop]);

  const endSession = useCallback(async (notice: string | null, { hold = false }: { hold?: boolean } = {}) => {
    // Everything kept on the phone goes with the session, before anything
    // else and before the server hears of it. A session the server ended
    // keeps only edits that were never sent, for the same account.
    setOfflineSession(null);
    const held = hold ? await offlineStore.hold().catch(() => offlineStore.wipe().then(() => 0, () => 0)) : await offlineStore.wipe().then(() => 0, () => 0);
    if (held > 0 && notice) notice = `${notice} ${held === 1 ? "One unsent edit is" : `${held} unsent edits are`} kept on this phone for this account.`;
    await sessionStore.clear().catch(() => undefined);
    if (native) await CapacitorCookies.clearAllCookies().catch(() => undefined);
    clearRecentCache();
    pendingFile.current = null;
    sessionRef.current = null;
    setSession(null);
    setRoutes([ROOT]);
    setSignedOutRoute(null);
    setWaitingPublic(null);
    setChooser(false);
    setSignInNotice(notice);
  }, [native, sessionStore, offlineStore]);

  // Any 401: the session is gone. Keep the open document so it reopens after sign-in.
  const onUnauthorized = useCallback(() => {
    const top = routesRef.current[routesRef.current.length - 1];
    if (top.kind === "doc") {
      const storage = pendingStorage();
      if (storage) rememberPendingLink(top.target, storage);
      setHasPending(true);
    }
    void endSession("Your session ended. Sign in again to continue.", { hold: true });
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
    // Push: take this phone off the server while the ending session can still ask.
    await push.signOut(courtesy);
    void courtesy.signOut({ timeoutMs: SERVER_SIGN_OUT_TIMEOUT_MS }).catch(() => undefined);
  }, [endSession, transport, push]);

  const signedIn = useCallback(async ({ origin, token, user }: { origin: string; token: string; user: ApiUser }) => {
    const next: StoredSession = { origin, token, email: user.email, name: user.name, userId: user.id };
    await sessionStore.save(next);
    // Another account's documents are wiped here, before this one sees a screen.
    setOfflineSession(await offlineStore.start({ origin, userId: user.id, email: user.email }).catch(() => null));
    savePreferredOrigin(origin);
    sessionRef.current = next;
    setSession(next);
    setSignInNotice(null);
    setRoutes([ROOT]);
    setSignedOutRoute(null);
    setGuestStack([]);
    setWaitingPublic(null);
    const storage = pendingStorage();
    const pending = storage ? takePendingLink(storage) : null;
    setHasPending(false);
    const file = pendingFile.current;
    pendingFile.current = null;
    if (file) openFile(file);
    else if (pending) openTarget(pending, { replaceStack: true });
  }, [openFile, openTarget, sessionStore, offlineStore]);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    saveThemeMode(mode);
    setThemeModeState(mode);
  }, []);

  // A client with no token, for the editor's props when nobody is signed in.
  // A local file never calls it.
  const noAccountApi = useMemo(() => createApiClient({ origin: preferredOrigin, transport }), [preferredOrigin, transport]);

  if (session === undefined) return <div className="m-boot" aria-busy="true" />;

  if (!session || !api) {
    if (guestStack.length > 0 && localFiles) {
      const popGuest = () => setGuestStack((stack) => stack.slice(0, -1));
      const host: LocalHost = {
        files: localFiles,
        tone,
        api: null,
        editorApi: noAccountApi,
        me: NOBODY,
        backGuard,
        nextKey,
        push: pushLocal,
        pop: popGuest,
        update: (change) => setGuestStack((stack) => stack.flatMap((route) => change(route) ?? [])),
        onSignIn: () => setGuestStack([]),
        onCloudCopy: null,
        onUnauthorized: () => undefined,
      };
      return (
        <>
          <Navigator
            entries={guestStack.map((route, index) => localEntry(route, { host, backLabel: index > 0 ? labelFor(guestStack[index - 1]) : "Sign in", active: index === guestStack.length - 1 }))}
            onPop={popGuest}
          />
          {toast ? <div className="m-toast" role="status">{toast}</div> : null}
        </>
      );
    }
    if (signedOutRoute && guestApi) {
      return (
        <>
          <PublicDocScreen
            key={`${signedOutRoute.target.origin}|${signedOutRoute.target.token}`}
            api={guestApi}
            target={signedOutRoute.target}
            tone={tone}
            onSignIn={() => setSignedOutRoute(null)}
            onOpen={openSignedOut}
          />
          {toast ? <div className="m-toast" role="status">{toast}</div> : null}
        </>
      );
    }
    return (
      <>
        <SignInScreen
          transport={transport}
          initialOrigin={preferredOrigin}
          pendingLink={hasPending}
          onReadPending={hasPending && waitingPublic ? () => openSignedOut(waitingPublic) : undefined}
          notice={signInNotice}
          onSignedIn={signedIn}
          onOriginChange={(origin) => { setPreferredOrigin(origin); savePreferredOrigin(origin); }}
          onLocalFiles={localFiles ? () => setGuestStack([LOCAL_HOME]) : undefined}
        />
        {toast ? <div className="m-toast" role="status">{toast}</div> : null}
      </>
    );
  }

  const localHost: LocalHost | null = localFiles ? {
    files: localFiles,
    tone,
    api,
    editorApi: api,
    me: { id: session.userId, name: session.name, email: session.email },
    backGuard,
    nextKey,
    push: pushLocal,
    pop,
    update: (change) => setRoutes((stack) => stack.flatMap((route) => (isLocalRoute(route) ? change(route) ?? [] : route))),
    onSignIn: null,
    onCloudCopy: ({ id, name }) => {
      setRefreshKey((value) => value + 1);
      setRoutes((stack) => [...stack, { key: nextKey("doc"), kind: "doc", target: { kind: "doc", id, origin: api.origin }, name }]);
    },
    onUnauthorized,
  } : null;

  const entries: StackEntry[] = routes.map((route, index) => {
    const backLabel = index > 0 ? labelFor(routes[index - 1]) : "";
    if (isLocalRoute(route)) {
      // Only a device puts these on the stack, and a device always has the host.
      return localHost ? localEntry(route, { host: localHost, backLabel, active: index === routes.length - 1 }) : { key: route.key, node: null };
    }
    if (route.kind === "recent") {
      return {
        key: route.key,
        node: (
          <RecentScreen
            api={api}
            refreshKey={refreshKey}
            onOpen={(doc) => doc.store === "platform"
              ? setRoutes((stack) => [...stack, { key: nextKey("office"), kind: "office", id: doc.id, name: doc.name }])
              : openTarget({ kind: "doc", id: doc.id, origin: api.origin }, { name: doc.name, sharedBy: doc.sharedBy })}
            onSettings={() => setRoutes((stack) => (stack[stack.length - 1].kind === "settings" ? stack : [...stack, { key: nextKey("settings"), kind: "settings" }]))}
            onNew={() => setChooser(true)}
            onRequests={() => setRoutes((stack) => (stack[stack.length - 1].kind === "requests" ? stack : [...stack, { key: nextKey("requests"), kind: "requests" }]))}
            onUnauthorized={onUnauthorized}
          />
        ),
      };
    }
    if (route.kind === "requests") {
      return {
        key: route.key,
        node: <RequestsScreen api={api} onBack={pop} onChanged={() => setRefreshKey((value) => value + 1)} onUnauthorized={onUnauthorized} />,
      };
    }
    if (route.kind === "settings") {
      return {
        key: route.key,
        node: <SettingsScreen session={session} api={api} themeMode={themeMode} onThemeMode={setThemeMode} push={push} onSignOut={signOut} onBack={pop} />,
      };
    }
    if (route.kind === "new") {
      return {
        key: route.key,
        locked: true,
        node: (
          <NewDocScreen
            api={api}
            type={route.type}
            onCancel={pop}
            onStart={(draft) => setRoutes((stack) => [...stack.slice(0, -1), { key: nextKey("edit"), kind: "edit", draft: { kind: "new", ...draft } }])}
            onCreated={({ id, name }) => {
              setRefreshKey((value) => value + 1);
              setRoutes((stack) => [...stack.slice(0, -1), { key: nextKey("office"), kind: "office", id, name, startEditing: true }]);
            }}
            onUnauthorized={onUnauthorized}
          />
        ),
      };
    }
    if (route.kind === "office") {
      return {
        key: route.key,
        node: (
          <OfficeScreen
            api={api}
            id={route.id}
            initialName={route.name}
            backLabel={backLabel}
            tone={tone}
            me={{ email: session.email, name: session.name }}
            startEditing={route.startEditing}
            onBack={pop}
            onUnauthorized={onUnauthorized}
            onChanged={() => setRefreshKey((value) => value + 1)}
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
            me={{ id: session.userId, name: session.name, email: session.email }}
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
          sharedBy={route.sharedBy ?? null}
          backLabel={backLabel}
          tone={tone}
          onBack={pop}
          onRecent={() => setRoutes([ROOT])}
          onOpen={(target) => openTarget(target)}
          onEdit={(doc) => {
            if (doc.version === null) return;
            const draft: EditorDraft = { kind: "cloud", id: doc.id, name: doc.name, format: doc.format, content: doc.content, version: doc.version, role: doc.role };
            setRoutes((stack) => [...stack, { key: nextKey("edit"), kind: "edit", draft }]);
          }}
          onComments={(doc) => {
            if (doc.version === null) return;
            const draft: EditorDraft = { kind: "cloud", id: doc.id, name: doc.name, format: doc.format, content: doc.content, version: doc.version, role: doc.role === "viewer" ? "viewer" : doc.role, openComments: true };
            setRoutes((stack) => [...stack, { key: nextKey("edit"), kind: "edit", draft }]);
          }}
          me={{ email: session.email, name: session.name }}
          reloadKey={route.reloadKey}
          onUnauthorized={onUnauthorized}
        />
      ),
    };
  });

  return (
    <>
      <Navigator entries={entries} onPop={pop} />
      {chooser ? (
        <NewDocChooser
          onClose={() => setChooser(false)}
          onChoose={(type) => { setChooser(false); setRoutes((stack) => [...stack, { key: nextKey("new"), kind: "new", type }]); }}
          onOpenFile={(file) => { setChooser(false); setRoutes((stack) => [...stack, { key: nextKey("file"), kind: "file", file }]); }}
          local={localFiles ? {
            files: localFiles,
            onOpened: (doc) => { setChooser(false); pushLocal({ key: nextKey("local-doc"), kind: "local-doc", doc }); },
            onBrowse: () => { setChooser(false); pushLocal({ ...LOCAL_HOME, key: nextKey("local-home") }); },
          } : undefined}
        />
      ) : null}
      {toast ? <div className="m-toast" role="status">{toast}</div> : null}
    </>
  );
}

function sameTarget(a: LinkTarget, b: LinkTarget): boolean {
  if (a.kind !== b.kind || a.origin !== b.origin) return false;
  return a.kind === "doc" ? a.id === (b as typeof a).id : a.token === (b as typeof a).token;
}

function threadOf(target: LinkTarget): string | null {
  return target.kind === "doc" ? target.thread ?? null : null;
}

function labelFor(route: Route): string {
  if (route.kind === "recent") return "Recent";
  if (route.kind === "settings") return "Settings";
  if (route.kind === "local-home") return "On this phone";
  if (route.kind === "local-folder") return route.name;
  return "Back";
}
