import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AccountIdentitiesClient, AccountIdentityError, accountScopeKey, subscribeAccountScope, type AccountIdentity, type AccountProvider } from "@/lib/account-identities";
import { getElectronAPI } from "@/lib/electron";
import { authStore } from "@/lib/auth-store";

const BUTTON = "markie-overlay-button rounded-md border border-border px-2 py-1 text-[12px] text-muted hover:text-foreground disabled:opacity-40";
const FIELD = "markie-overlay-field w-full px-2 py-1.5 text-[12px]";
export function LinkedIdentities({ accountId }: { accountId: string }) {
  const [expanded, setExpanded] = useState(false);
  return <section className="mt-4 border-t border-border pt-3" aria-label="Linked sign-ins">
    <button type="button" className={BUTTON} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>Manage linked sign-ins</button>
    {expanded ? <IdentityPanel key={accountId} /> : null}
  </section>;
}
function IdentityPanel() {
  const scope = useSyncExternalStore(subscribeAccountScope, accountScopeKey, () => "");
  const [listing, setListing] = useState<{ scope: string; identities: AccountIdentity[]; providers?: AccountProvider[] } | null>(null);
  const [step, setStep] = useState<"idle" | "primary-code" | "email" | "email-code" | "google-wait">("idle");
  const [googleAvailable, setGoogleAvailable] = useState(false), [google, setGoogle] = useState(false), [intent, setIntent] = useState("");
  const [challenge, setChallenge] = useState(""), [proof, setProof] = useState("");
  const [remove, setRemove] = useState<AccountIdentity | null>(null);
  const [removeGoogle, setRemoveGoogle] = useState<AccountProvider | null>(null);
  const [email, setEmail] = useState(""), [code, setCode] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  // A server without the feature answers 404. Say so once and offer nothing that cannot work.
  const [unsupported, setUnsupported] = useState(false);
  const request = useRef<AbortController | null>(null), generation = useRef(0);
  const googleHandoff = useRef<string | null>(null);
  const visible = listing?.scope === scope ? listing.identities : [];
  const providers = listing?.scope === scope ? listing.providers ?? [] : [];
  useEffect(() => {
    const controller = new AbortController(), ticket = ++generation.current; request.current?.abort(); request.current = controller;
    googleHandoff.current = null;
    setStep("idle"); setGoogle(false); setGoogleAvailable(false); setIntent(""); setProof(""); setChallenge(""); setCode(""); setEmail(""); setRemove(null); setRemoveGoogle(null); setNotice(null); setError(null); setBusy(false); setUnsupported(false);
    if (scope) { setBusy(true); void new AccountIdentitiesClient().identities(controller.signal).then((data) => { if (!controller.signal.aborted && ticket === generation.current) { setListing({ scope, identities: data.identities, providers: data.providers }); setGoogleAvailable(data.googleAvailable); } }).catch((failure: unknown) => { if (!controller.signal.aborted) { setUnsupported(failure instanceof AccountIdentityError && failure.code === "unsupported"); setError(failure instanceof Error ? failure.message : "Linked sign-ins could not be loaded."); } }).finally(() => { if (!controller.signal.aborted) setBusy(false); }); }
    return () => controller.abort();
  }, [scope]);
  useEffect(() => {
    if (step !== "google-wait" || !intent || !scope) return;
    const controller = new AbortController(); let inFlight = false;
    const check = async () => {
      if (inFlight) return; inFlight = true;
      try {
        const client = new AccountIdentitiesClient(), result = await client.googleStatus(intent, controller.signal);
        if (result === "complete") { const data = await client.identities(controller.signal); if (!controller.signal.aborted) { googleHandoff.current = null; setListing({ scope, identities: data.identities, providers: data.providers }); setStep("idle"); setIntent(""); setGoogle(false); setNotice("Google sign-in linked to this account. Your primary account and document access are unchanged."); } }
        else if (result === "expired" && !controller.signal.aborted) { setStep("idle"); setIntent(""); setGoogle(false); setError("The Google linking request expired. Confirm your primary email to start again."); }
      } catch { if (!controller.signal.aborted) setError("Google linking status could not be checked. Your current sign-in has not changed."); }
      finally { inFlight = false; }
    };
    void check(); const timer = setInterval(() => { void check(); }, 5_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [scope, step, intent]);
  const run = async (work: (client: AccountIdentitiesClient, signal: AbortSignal) => Promise<void>) => {
    const bound = scope, ticket = ++generation.current, controller = new AbortController(); request.current?.abort(); request.current = controller;
    setBusy(true); setError(null); setNotice(null);
    try { await work(new AccountIdentitiesClient(), controller.signal); }
    catch (failure) { if (!controller.signal.aborted && ticket === generation.current && bound === accountScopeKey()) setError(failure instanceof Error ? failure.message : "The account change failed."); }
    finally { if (!controller.signal.aborted && ticket === generation.current && bound === accountScopeKey()) setBusy(false); }
  };
  const begin = (identity: AccountIdentity | null, linkGoogle = false, provider: AccountProvider | null = null) => void run(async (client, signal) => {
    const next = await client.startStepUp(provider ? "google-remove" : linkGoogle ? "google-link" : identity ? "email-remove" : "email-add", signal); setGoogle(linkGoogle); setRemove(identity); setRemoveGoogle(provider); setChallenge(next.challengeId); setCode(""); setStep("primary-code"); setNotice("A code was sent to your primary email. Confirm it before changing linked sign-ins.");
  });
  const openGoogle = () => {
    const target = googleHandoff.current; if (!target || scope !== accountScopeKey()) return;
    const api = getElectronAPI();
    if (api) void api.openExternal(target).catch(() => setError("The browser could not be opened. Try opening the linking page again."));
    else if (!window.open(target, "_blank", "noopener,noreferrer")) setNotice("Use Open Google linking page to continue in your browser.");
  };
  const confirmPrimary = () => void run(async (client, signal) => {
    const next = await client.verifyStepUp(challenge, code.trim(), signal); setCode("");
    if (removeGoogle) { await client.unlinkGoogle(removeGoogle.id, next, signal); setStep("idle"); setRemoveGoogle(null); await authStore.signOut(); }
    else if (remove) { await client.unlink(remove.id, next, signal); setListing({ scope, identities: visible.filter((item) => item.id !== remove.id), providers }); setStep("idle"); setRemove(null); setNotice("Sign-in unlinked. Existing documents and cloud areas were kept."); }
    else if (google) { const link = await client.startGoogle(next, signal); googleHandoff.current = link.browserUrl; setIntent(link.intentId); setStep("google-wait"); setNotice("Complete the explicit link in your browser. This does not replace your current Markie sign-in."); openGoogle(); }
    else { setProof(next); setStep("email"); }
  });
  return <div className="mt-2 space-y-2 text-[12px]">
    <p className="text-muted">Verified sign-ins reach this same account. Linking never merges another account or changes document access.</p>
    {!scope ? <p role="status">Sign in again to confirm this account on the current server.</p> : <>
      {visible.length ? <ul className="space-y-1">{visible.map((identity) => <li key={identity.id} className="flex flex-wrap items-center justify-between gap-2"><span className="break-all">{identity.email} · {identity.primary ? "Primary" : "Verified"}</span>{!identity.primary ? <button className={BUTTON} type="button" disabled={busy} onClick={() => begin(identity)} aria-label={`Unlink ${identity.email}`}>Unlink</button> : null}</li>)}</ul> : null}
      {providers.filter((provider) => provider.providerId === "google").map((provider, index) => <div key={provider.id} className="flex flex-wrap justify-between gap-2"><span>Google sign-in {index + 1}</span><button className={BUTTON} type="button" disabled={busy} onClick={() => begin(null, false, provider)} aria-label={`Unlink Google sign-in ${index + 1}`}>Unlink</button></div>)}
      {removeGoogle ? <p role="alert">Removing this Google sign-in signs out every active session, including this one. Documents and your primary account are kept. Confirm with the code sent to your primary email.</p> : null}
      {step === "idle" && !unsupported ? <><button className={BUTTON} type="button" disabled={busy || !visible.length} onClick={() => begin(null)}>Link another email</button>{googleAvailable ? <button className={BUTTON} type="button" disabled={busy || !visible.length} onClick={() => begin(null, true)}>Link Google sign-in</button> : null}</> : null}
      {step === "primary-code" ? <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); confirmPrimary(); }}><label className="block">Primary email confirmation code<input className={FIELD} autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} /></label><button className={BUTTON} disabled={busy || !code.trim()}>{removeGoogle ? "Confirm unlink and sign out" : remove ? "Confirm and unlink" : "Confirm primary email"}</button><button className={BUTTON} type="button" disabled={busy} onClick={() => begin(remove, google, removeGoogle)}>Send a new primary code</button></form> : null}
      {step === "email" ? <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void run(async (client, signal) => { const next = await client.startEmail(email, proof, signal); setChallenge(next.challengeId); setCode(""); setStep("email-code"); setNotice("Enter the code sent to the new email. It is not linked until verified."); }); }}><label className="block">New sign-in email<input className={FIELD} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><button className={BUTTON} disabled={busy || !email.trim()}>Send verification code</button></form> : null}
      {step === "email-code" ? <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void run(async (client, signal) => { const next = await client.verifyEmail(challenge, code.trim(), signal); setListing({ scope, identities: [...visible.filter((item) => item.id !== next.id), next], providers }); setStep("idle"); setCode(""); setProof(""); setEmail(""); setNotice("Verified email linked to this account. No accounts were merged."); }); }}><label className="block">New email verification code<input className={FIELD} autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} /></label><button className={BUTTON} disabled={busy || !code.trim()}>Verify and link email</button></form> : null}
      {step === "google-wait" ? <button className={BUTTON} type="button" onClick={openGoogle}>Open Google linking page</button> : null}
      {step !== "idle" ? <button className={BUTTON} type="button" disabled={busy} onClick={() => { setStep("idle"); setCode(""); setProof(""); setChallenge(""); setRemove(null); setRemoveGoogle(null); googleHandoff.current = null; setIntent(""); setGoogle(false); setNotice(step === "google-wait" ? "Stopped checking. A browser flow already started may still complete before it expires." : null); }}>{step === "google-wait" ? "Stop checking Google link" : "Cancel linking change"}</button> : null}
    </>}
    {busy ? <p role="status" className="text-muted">Checking account…</p> : notice ? <p role="status" className="text-muted">{notice}</p> : null}
    {error ? unsupported ? <p role="status" className="text-muted">{error}</p> : <p role="alert" className="text-[var(--status-red)]">{error}</p> : null}
  </div>;
}
