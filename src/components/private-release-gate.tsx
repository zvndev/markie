import { useEffect, useState, type ReactNode } from "react";
import { getElectronAPI, type PrivateReleaseStatus } from "@/lib/electron";
import { adoptAuthToken, getAuthToken, pushSyncConfig } from "@/lib/auth-client";
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
    {status?.required ? <><SignInForm reason="account" allowGoogle={false} onDone={() => { void authorize(); }} /><button type="button" className="markie-overlay-button w-full rounded-md border border-border py-2 text-sm" disabled={busy} onClick={() => { void authorize(); }}>{busy ? "Checking access…" : "Authorize this build"}</button><p className="text-xs text-muted">{status.channel} · {status.gitCommit?.slice(0, 12)}</p></> : <p role="status">Checking private build access…</p>}
    {error ? <p role="alert" className="text-sm">{error}</p> : null}
  </section></main>;
}
