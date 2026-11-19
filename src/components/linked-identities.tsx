import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AccountIdentitiesClient, AccountIdentityError, accountScopeKey, subscribeAccountScope, type AccountIdentity, type AccountProvider, type LinkProvider } from "@/lib/account-identities";
import { getElectronAPI } from "@/lib/electron";
import { authStore } from "@/lib/auth-store";

const BUTTON = "markie-overlay-button rounded-md border border-border px-2 py-1 text-[12px] text-muted hover:text-foreground disabled:opacity-40";
const FIELD = "markie-overlay-field w-full px-2 py-1.5 text-[12px]";
// Google first, as on the sign-in screen.
const PROVIDERS: LinkProvider[] = ["google", "apple"];
const LABEL: Record<LinkProvider, string> = { google: "Google", apple: "Apple" };
const labelOf = (provider: LinkProvider) => LABEL[provider];
/** "Google: kirby@zvndev.com" when the server recorded the address, else the old "Google sign-in 2". */
const rowName = (provider: AccountProvider & { providerId: LinkProvider }, index: number) => provider.email ? `${labelOf(provider.providerId)}: ${provider.email}` : `${labelOf(provider.providerId)} sign-in ${index + 1}`;
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
  const [step, setStep] = useState<"idle" | "primary-code" | "email" | "email-code" | "provider-wait">("idle");
  // Which providers this server can link, and the one being linked right now.
  const [available, setAvailable] = useState<Record<LinkProvider, boolean>>({ google: false, apple: false });
  const [linking, setLinking] = useState<LinkProvider | null>(null), [intent, setIntent] = useState("");
  const [challenge, setChallenge] = useState(""), [proof, setProof] = useState("");
  const [remove, setRemove] = useState<AccountIdentity | null>(null);
  const [removeProvider, setRemoveProvider] = useState<(AccountProvider & { providerId: LinkProvider }) | null>(null);
  const [email, setEmail] = useState(""), [code, setCode] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  // A server without the feature answers 404. Say so once and offer nothing that cannot work.
  const [unsupported, setUnsupported] = useState(false);
  const request = useRef<AbortController | null>(null), generation = useRef(0);
  const handoff = useRef<string | null>(null);
  const visible = listing?.scope === scope ? listing.identities : [];
  const providers = listing?.scope === scope ? listing.providers ?? [] : [];
  useEffect(() => {
    const controller = new AbortController(), ticket = ++generation.current; request.current?.abort(); request.current = controller;
    handoff.current = null;
    setStep("idle"); setLinking(null); setAvailable({ google: false, apple: false }); setIntent(""); setProof(""); setChallenge(""); setCode(""); setEmail(""); setRemove(null); setRemoveProvider(null); setNotice(null); setError(null); setBusy(false); setUnsupported(false);
    if (scope) { setBusy(true); void new AccountIdentitiesClient().identities(controller.signal).then((data) => { if (!controller.signal.aborted && ticket === generation.current) { setListing({ scope, identities: data.identities, providers: data.providers }); setAvailable({ google: data.googleAvailable, apple: data.appleAvailable }); } }).catch((failure: unknown) => { if (!controller.signal.aborted) { setUnsupported(failure instanceof AccountIdentityError && failure.code === "unsupported"); setError(failure instanceof Error ? failure.message : "Linked sign-ins could not be loaded."); } }).finally(() => { if (!controller.signal.aborted) setBusy(false); }); }
    return () => controller.abort();
  }, [scope]);
  useEffect(() => {
    if (step !== "provider-wait" || !intent || !scope || !linking) return;
    const controller = new AbortController(); let inFlight = false;
    const label = labelOf(linking);
    const check = async () => {
      if (inFlight) return; inFlight = true;
      try {
        const client = new AccountIdentitiesClient(), result = await client.providerLinkStatus(linking, intent, controller.signal);
        if (result === "complete") { const data = await client.identities(controller.signal); if (!controller.signal.aborted) { handoff.current = null; setListing({ scope, identities: data.identities, providers: data.providers }); setStep("idle"); setIntent(""); setLinking(null); setNotice(`${label} sign-in linked to this account. Your primary account and document access are unchanged.`); } }
        else if (result === "expired" && !controller.signal.aborted) { setStep("idle"); setIntent(""); setLinking(null); setError(`The ${label} linking request expired. Confirm your primary email to start again.`); }
      } catch { if (!controller.signal.aborted) setError(`${label} linking status could not be checked. Your current sign-in has not changed.`); }
      finally { inFlight = false; }
    };
    void check(); const timer = setInterval(() => { void check(); }, 5_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [scope, step, intent, linking]);
  const run = async (work: (client: AccountIdentitiesClient, signal: AbortSignal) => Promise<void>) => {
    const bound = scope, ticket = ++generation.current, controller = new AbortController(); request.current?.abort(); request.current = controller;
    setBusy(true); setError(null); setNotice(null);
    try { await work(new AccountIdentitiesClient(), controller.signal); }
    catch (failure) { if (!controller.signal.aborted && ticket === generation.current && bound === accountScopeKey()) setError(failure instanceof Error ? failure.message : "The account change failed."); }
    finally { if (!controller.signal.aborted && ticket === generation.current && bound === accountScopeKey()) setBusy(false); }
  };
  // Each change asks for its own scope: linking or removing Google or Apple
  // takes that provider's proof, so one confirmed code never does another's job.
  const begin = (identity: AccountIdentity | null, link: LinkProvider | null = null, provider: (AccountProvider & { providerId: LinkProvider }) | null = null) => void run(async (client, signal) => {
    const next = await client.startStepUp(provider ? `${provider.providerId}-remove` : link ? `${link}-link` : identity ? "email-remove" : "email-add", signal); setLinking(link); setRemove(identity); setRemoveProvider(provider); setChallenge(next.challengeId); setCode(""); setStep("primary-code"); setNotice("A code was sent to your primary email. Confirm it before changing linked sign-ins.");
  });
  const openLinkPage = (provider: LinkProvider) => {
    const target = handoff.current; if (!target || scope !== accountScopeKey()) return;
    const api = getElectronAPI();
    if (api) void api.openExternal(target).catch(() => setError("The browser could not be opened. Try opening the linking page again."));
    else if (!window.open(target, "_blank", "noopener,noreferrer")) setNotice(`Use Open ${labelOf(provider)} linking page to continue in your browser.`);
  };
  const confirmPrimary = () => void run(async (client, signal) => {
    const next = await client.verifyStepUp(challenge, code.trim(), signal); setCode("");
    if (removeProvider) { await client.unlinkProvider(removeProvider.providerId, removeProvider.id, next, signal); setStep("idle"); setRemoveProvider(null); await authStore.signOut(); }
    else if (remove) { await client.unlink(remove.id, next, signal); setListing({ scope, identities: visible.filter((item) => item.id !== remove.id), providers }); setStep("idle"); setRemove(null); setNotice("Sign-in unlinked. Existing documents and cloud areas were kept."); }
    else if (linking) { const link = await client.startProviderLink(linking, next, signal); handoff.current = link.browserUrl; setIntent(link.intentId); setStep("provider-wait"); setNotice("Complete the explicit link in your browser. This does not replace your current Markie sign-in."); openLinkPage(linking); }
    else { setProof(next); setStep("email"); }
  });
  return <div className="mt-2 space-y-2 text-[12px]">
    <p className="text-muted">Verified sign-ins reach this same account. Linking never merges another account or changes document access.</p>
    {!scope ? <p role="status">Sign in again to confirm this account on the current server.</p> : <>
      {visible.length ? <ul className="space-y-1">{visible.map((identity) => <li key={identity.id} className="flex flex-wrap items-center justify-between gap-2"><span className="break-all">{identity.email} · {identity.primary ? "Primary" : "Verified"}</span>{!identity.primary ? <button className={BUTTON} type="button" disabled={busy} onClick={() => begin(identity)} aria-label={`Unlink ${identity.email}`}>Unlink</button> : null}</li>)}</ul> : null}
      {PROVIDERS.flatMap((id) => providers.filter((provider): provider is AccountProvider & { providerId: LinkProvider } => provider.providerId === id).map((provider, index) => {
        const name = rowName(provider, index);
        return <div key={provider.id} className="flex flex-wrap justify-between gap-2"><span className="break-all">{name}</span><button className={BUTTON} type="button" disabled={busy} onClick={() => begin(null, null, provider)} aria-label={`Unlink ${name}`}>Unlink</button></div>;
      }))}
      {removeProvider ? <p role="alert">Removing this {labelOf(removeProvider.providerId)} sign-in signs out every active session, including this one. Documents and your primary account are kept. Confirm with the code sent to your primary email.</p> : null}
      {step === "idle" && !unsupported ? <><button className={BUTTON} type="button" disabled={busy || !visible.length} onClick={() => begin(null)}>Link another email</button>{PROVIDERS.map((id) => available[id] ? <button key={id} className={BUTTON} type="button" disabled={busy || !visible.length} onClick={() => begin(null, id)}>Link {LABEL[id]} sign-in</button> : null)}</> : null}
      {step === "primary-code" ? <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); confirmPrimary(); }}><label className="block">Primary email confirmation code<input className={FIELD} autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} /></label><button className={BUTTON} disabled={busy || !code.trim()}>{removeProvider ? "Confirm unlink and sign out" : remove ? "Confirm and unlink" : "Confirm primary email"}</button><button className={BUTTON} type="button" disabled={busy} onClick={() => begin(remove, linking, removeProvider)}>Send a new primary code</button></form> : null}
      {step === "email" ? <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void run(async (client, signal) => { const next = await client.startEmail(email, proof, signal); setChallenge(next.challengeId); setCode(""); setStep("email-code"); setNotice("Enter the code sent to the new email. It is not linked until verified."); }); }}><label className="block">New sign-in email<input className={FIELD} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><button className={BUTTON} disabled={busy || !email.trim()}>Send verification code</button></form> : null}
      {step === "email-code" ? <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void run(async (client, signal) => { const next = await client.verifyEmail(challenge, code.trim(), signal); setListing({ scope, identities: [...visible.filter((item) => item.id !== next.id), next], providers }); setStep("idle"); setCode(""); setProof(""); setEmail(""); setNotice("Verified email linked to this account. No accounts were merged."); }); }}><label className="block">New email verification code<input className={FIELD} autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} /></label><button className={BUTTON} disabled={busy || !code.trim()}>Verify and link email</button></form> : null}
      {step === "provider-wait" && linking ? <button className={BUTTON} type="button" onClick={() => openLinkPage(linking)}>Open {labelOf(linking)} linking page</button> : null}
      {step !== "idle" ? <button className={BUTTON} type="button" disabled={busy} onClick={() => { setStep("idle"); setCode(""); setProof(""); setChallenge(""); setRemove(null); setRemoveProvider(null); handoff.current = null; setIntent(""); setLinking(null); setNotice(step === "provider-wait" ? "Stopped checking. A browser flow already started may still complete before it expires." : null); }}>{step === "provider-wait" && linking ? `Stop checking ${labelOf(linking)} link` : "Cancel linking change"}</button> : null}
    </>}
    {busy ? <p role="status" className="text-muted">Checking account…</p> : notice ? <p role="status" className="text-muted">{notice}</p> : null}
    {error ? unsupported ? <p role="status" className="text-muted">{error}</p> : <p role="alert" className="text-[var(--status-red)]">{error}</p> : null}
  </div>;
}
