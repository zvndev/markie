// Signing in. An address and the six digits Markie mails to it, or the
// account's password, or Google or Apple where the chosen server offers them
// (lib/provider-sign-in.ts). The server address hides under Advanced for
// people who run their own.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, createApiClient, type ApiUser } from "../lib/api";
import type { HttpTransport } from "../lib/http";
import { openExternal, platformName } from "../lib/native";
import { PROVIDER_LABEL, beginProviderSignIn, fetchServerSignIn, providersFor, type Provider, type ServerSignIn } from "../lib/provider-sign-in";
import type { SecureKeyValue } from "../lib/session";
import { normalizeServerOrigin, serverLabel } from "../lib/server-origin";
import { AlertIcon, ChevronRight, MailIcon } from "../components/icons";
import { MarkieMark } from "../components/markie-mark";

interface SignInProps {
  transport: HttpTransport;
  /** The Keychain, where a Google or Apple sign-in keeps its secret while the browser is open. */
  secure: SecureKeyValue;
  initialOrigin: string;
  /** A tapped link is waiting: say so, so signing in has a reason. */
  pendingLink: boolean;
  /** The waiting link is a public share: the way back to reading it with no account. */
  onReadPending?: () => void;
  /** Why the last session ended, when it ended on its own. */
  notice: string | null;
  onSignedIn: (result: { origin: string; token: string; user: ApiUser }) => Promise<void>;
  onOriginChange: (origin: string) => void;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A8.97 8.97 0 0 0 9 0 9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

function AppleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" fill="currentColor">
      <path d="M14.3 9.56c-.02-1.9 1.55-2.81 1.62-2.86-.88-1.29-2.25-1.47-2.74-1.49-1.17-.12-2.28.69-2.87.69-.59 0-1.5-.67-2.47-.65-1.27.02-2.44.74-3.1 1.87-1.32 2.29-.34 5.68.95 7.54.63.91 1.38 1.93 2.36 1.9.95-.04 1.31-.61 2.45-.61 1.15 0 1.47.61 2.47.59 1.02-.02 1.67-.93 2.29-1.84.72-1.06 1.02-2.08 1.04-2.13-.02-.01-1.99-.76-2-3.01ZM12.42 3.98c.52-.63.88-1.51.78-2.38-.75.03-1.66.5-2.2 1.13-.48.56-.9 1.45-.79 2.31.84.06 1.69-.43 2.21-1.06Z" />
    </svg>
  );
}

export function SignInScreen({ transport, secure, initialOrigin, pendingLink, onReadPending, notice, onSignedIn, onOriginChange }: SignInProps) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [method, setMethod] = useState<"code" | "password">("code");
  const [password, setPassword] = useState("");
  // What the chosen server lets a phone sign in with. Unknown until it
  // answers, and until then Google and Apple are not offered.
  const [offer, setOffer] = useState<ServerSignIn | null>(null);
  const [origin, setOrigin] = useState(initialOrigin);
  const [originDraft, setOriginDraft] = useState(initialOrigin);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => { if (step === "code") codeInput.current?.focus(); }, [step]);

  useEffect(() => {
    let live = true;
    setOffer(null);
    void fetchServerSignIn(origin, transport).then((answer) => { if (live) setOffer(answer); });
    return () => { live = false; };
  }, [origin, transport]);

  const known = offer && offer.origin === origin ? offer : null;
  const providers = providersFor(known, platformName());
  // A server with no mail set up cannot send a code, so the password is the way in.
  const canMailCode = known?.emailCode !== false;
  const usePassword = method === "password" || !canMailCode;

  function commitOrigin(): string | null {
    const parsed = normalizeServerOrigin(originDraft);
    if (!parsed.ok) {
      setError(parsed.error);
      setAdvanced(true);
      return null;
    }
    setOrigin(parsed.origin);
    setOriginDraft(parsed.origin);
    onOriginChange(parsed.origin);
    return parsed.origin;
  }

  async function sendCode(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    setError(null);
    setInfo(null);
    const address = email.trim();
    if (!EMAIL.test(address)) { setError("Enter your email address."); return; }
    const target = commitOrigin();
    if (!target) return;
    setBusy(true);
    try {
      await createApiClient({ origin: target, transport }).sendCode(address);
      setEmail(address);
      setCode("");
      setStep("code");
      setInfo(step === "code" ? "We sent a new code." : null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Couldn't send the code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithPassword(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    setError(null);
    setInfo(null);
    const address = email.trim();
    if (!EMAIL.test(address)) { setError("Enter your email address."); return; }
    if (!password) { setError("Enter your password."); return; }
    const target = commitOrigin();
    if (!target) return;
    setBusy(true);
    try {
      const result = await createApiClient({ origin: target, transport }).signInPassword(address, password);
      await onSignedIn({ origin: target, token: result.token, user: result.user });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Couldn't sign in. Try again.");
      setBusy(false);
    }
  }

  // Google or Apple: their screen opens in the phone's browser, and the app
  // finishes when the browser hands back (app.tsx, the returning link).
  async function continueWith(provider: Provider) {
    if (busy) return;
    setError(null);
    setInfo(null);
    const target = commitOrigin();
    // Only ever the server that was asked, and only what it said it offers.
    if (!target || !known || known.origin !== target || !providers.includes(provider)) return;
    const name = PROVIDER_LABEL[provider];
    setBusy(true);
    try {
      await openExternal(await beginProviderSignIn({ origin: target, provider, secure }));
      setInfo(`Finish signing in with ${name} in your browser. Markie opens again when you're done.`);
    } catch {
      setError(`Couldn't start ${name} sign-in. Try again.`);
    } finally {
      setBusy(false);
    }
  }

  async function verify(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    const digits = code.replace(/\D/g, "");
    if (digits.length !== 6) { setError("Enter the six-digit code from the email."); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await createApiClient({ origin, transport }).verifyCode(email, digits);
      await onSignedIn({ origin, token: result.token, user: result.user });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Couldn't sign in. Try again.");
      setBusy(false);
    }
  }

  return (
    <section className="m-screen m-signin">
      <div className="m-signin-scroll">
        <div className="m-signin-hero">
          <MarkieMark size={64} />
          <h1>{step === "email" ? "Sign in to Markie" : "Check your email"}</h1>
          <p>
            {step === "email"
              ? "Read, write and share the documents in your Markie Cloud, including the ones your agents make."
              : <>We sent a six-digit code to <strong>{email}</strong>. It expires in 5 minutes.</>}
          </p>
        </div>

        {pendingLink && step === "email" ? (
          <div className="m-callout" role="status">
            <MailIcon size={18} />
            <span>
              Sign in and the document you opened shows up right after.
              {onReadPending ? <button type="button" className="m-callout-link" onClick={onReadPending} disabled={busy}>Read it without signing in</button> : null}
            </span>
          </div>
        ) : null}
        {notice ? <div className="m-callout" role="status"><AlertIcon size={18} /><span>{notice}</span></div> : null}

        {step === "email" ? (
          <form className="m-form" onSubmit={usePassword ? signInWithPassword : sendCode} noValidate>
            {providers.length ? (
              <>
                <div className="m-providers">
                  {providers.map((provider) => (
                    <button key={provider} type="button" className="m-button m-button-provider" onClick={() => void continueWith(provider)} disabled={busy}>
                      {provider === "apple" ? <AppleMark /> : <GoogleMark />}
                      Continue with {PROVIDER_LABEL[provider]}
                    </button>
                  ))}
                </div>
                {info && !error ? <p className="m-form-info" role="status">{info}</p> : null}
                <div className="m-or" role="separator"><span>or</span></div>
              </>
            ) : null}
            <label className="m-field">
              <span className="m-field-label">Email</span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                enterKeyHint={usePassword ? "next" : "send"}
              />
            </label>
            {usePassword ? (
              <label className="m-field">
                <span className="m-field-label">Password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  enterKeyHint="go"
                />
              </label>
            ) : null}
            {error ? <p className="m-form-error" role="alert">{error}</p> : null}
            <button type="submit" className="m-button m-button-primary" disabled={busy}>
              {busy ? <span className="m-spinner" aria-hidden="true" /> : null}
              {usePassword ? (busy ? "Signing in" : "Sign in") : busy ? "Sending code" : "Send code"}
            </button>
            {canMailCode ? (
              <button
                type="button"
                className="m-link-button m-signin-switch"
                onClick={() => { setMethod(usePassword ? "code" : "password"); setPassword(""); setError(null); }}
                disabled={busy}
              >
                {usePassword ? "Email me a code instead" : "Use a password instead"}
              </button>
            ) : null}

            <div className="m-advanced">
              <button type="button" className="m-advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
                <span>Advanced</span>
                <span className="m-advanced-value">{serverLabel(origin)}</span>
                <ChevronRight size={16} className="m-advanced-chevron" />
              </button>
              {advanced ? (
                <label className="m-field m-field-compact">
                  <span className="m-field-label">Server</span>
                  <input
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={originDraft}
                    onChange={(e) => setOriginDraft(e.target.value)}
                    // An address is replaced far more often than edited.
                    // Deferred: Android places the caret after focus, which would undo it.
                    onFocus={(e) => { const field = e.currentTarget; setTimeout(() => field.select(), 60); }}
                    onBlur={() => { if (originDraft.trim()) commitOrigin(); }}
                    disabled={busy}
                  />
                  <span className="m-field-hint">Markie Cloud is https://api.markiedocs.com. Change this only if you run your own Markie server.</span>
                </label>
              ) : null}
            </div>
          </form>
        ) : (
          <form className="m-form" onSubmit={verify} noValidate>
            <label className="m-field">
              <span className="m-field-label">Code</span>
              <input
                ref={codeInput}
                className="m-code-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => {
                  const next = e.target.value.replace(/\D/g, "").slice(0, 6);
                  setCode(next);
                }}
                disabled={busy}
                enterKeyHint="go"
              />
            </label>
            {error ? <p className="m-form-error" role="alert">{error}</p> : null}
            {info && !error ? <p className="m-form-info" role="status">{info}</p> : null}
            <button type="submit" className="m-button m-button-primary" disabled={busy || code.length !== 6}>
              {busy ? <span className="m-spinner" aria-hidden="true" /> : null}
              {busy ? "Signing in" : "Sign in"}
            </button>
            <div className="m-form-row">
              <button type="button" className="m-link-button" onClick={() => { setStep("email"); setError(null); setInfo(null); }} disabled={busy}>Use a different email</button>
              <button type="button" className="m-link-button" onClick={() => void sendCode()} disabled={busy}>Send a new code</button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
