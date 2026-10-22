import { useEffect, useState, type ReactNode } from "react";
import { getElectronAPI, type PrivateReleaseStatus } from "@/lib/electron";
import { adoptAuthToken, getAuthToken, getServerURL, pushSyncConfig } from "@/lib/auth-client";
import { resolveAuthDeepLink } from "@/lib/auth-state";
import { authStore } from "@/lib/auth-store";
import { SignInForm } from "./sign-in";

/** No document shell mounts until the native process grants this private build. */
export function PrivateReleaseGate({ children }: { children: ReactNode }) {
  const bridge = getElectronAPI();
  const [status, setStatus] = useState<PrivateReleaseStatus | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge?.privateReleaseAuthOrigin || !bridge.privateReleaseStatus) return;
    let live = true;
    const check = () => { void bridge.privateReleaseStatus!().then(async (next) => {
      if (next.required && next.authorized && !getAuthToken() && bridge.privateReleaseSession) {
        const session = await bridge.privateReleaseSession();
        if (live && session.token) adoptAuthToken(session.token);
      }
      if (live) setStatus(next);
    }).catch(() => { if (live) { setStatus(null); setError("Private authorization could not be checked."); } }); };
    check(); const timer = setInterval(check, 5_000);
    return () => { live = false; clearInterval(timer); };
  }, [bridge]);
  // Google sign-in returns through a markie://auth deep link, and the document
  // shell that normally takes it is not mounted while the build is locked. So
  // the gate takes it here, and only while locked: once the shell mounts, two
  // listeners would race for the single-use nonce. The same nonce and issuer
  // checks apply, and a private build only ever adopts its primary server.
  const locked = !!bridge?.privateReleaseAuthOrigin && status?.required === true && status.authorized !== true;
  useEffect(() => {
    if (!locked) return;
    const take = (url: string | null) => {
      if (!url) return;
      const link = resolveAuthDeepLink(url, { primaryOrigin: getServerURL() });
      if (!link.ok || (link.origin && link.origin !== getServerURL())) return;
      adoptAuthToken(link.token);
      void authStore.refresh();
      void authorize();
    };
    // A hand-back that landed before this listener existed waits in main.
    void bridge?.privateReleaseTakeAuthLink?.().then(take).catch(() => {});
    return bridge?.onDeepLink?.(take);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- authorize reads only the bridge and the stored token
  }, [locked, bridge]);
  const authorize = async () => {
    const token = getAuthToken();
    if (!token || !bridge?.privateReleaseAuthorize) { setError("Sign in to the authorized Markie account first."); return; }
    setBusy(true); setError(null);
    try {
      const next = await bridge.privateReleaseAuthorize(token); setStatus(next);
      if (next.authorized) pushSyncConfig();
      else setError("This account is not authorized, or the private service is unavailable. No documents have been opened.");
    } catch { setError("The private service could not be reached. This build remains locked."); }
    finally { setBusy(false); }
  };
  if (!bridge?.privateReleaseAuthOrigin || status?.required === false || status?.required === true && status.authorized === true) return children;
  return <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6"><section className="w-full max-w-sm space-y-4" aria-label="Private release authorization">
    <h1 className="text-lg font-semibold">Markie Super-nightly</h1>
    <p className="text-sm text-muted">This private build requires online authorization before opening documents.</p>
    {status?.required ? <><SignInForm reason="account" onDone={() => { void authorize(); }} /><button type="button" className="markie-overlay-button w-full rounded-md border border-border py-2 text-sm" disabled={busy} onClick={() => { void authorize(); }}>{busy ? "Checking access…" : "Authorize this build"}</button><p className="text-xs text-muted">{status.channel} · {status.gitCommit?.slice(0, 12)}</p></> : <p role="status">Checking private build access…</p>}
    {error ? <p role="alert" className="text-sm">{error}</p> : null}
  </section></main>;
}
