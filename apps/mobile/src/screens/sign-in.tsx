// Email code sign-in: an address, then the six digits Markie mails to it.
// The server address hides under Advanced for people who run their own.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, createApiClient, type ApiUser } from "../lib/api";
import type { HttpTransport } from "../lib/http";
import { normalizeServerOrigin, serverLabel } from "../lib/server-origin";
import { AlertIcon, ChevronRight, MailIcon } from "../components/icons";
import { MarkieMark } from "../components/markie-mark";

interface SignInProps {
  transport: HttpTransport;
  initialOrigin: string;
  /** A tapped link is waiting: say so, so signing in has a reason. */
  pendingLink: boolean;
  /** Why the last session ended, when it ended on its own. */
  notice: string | null;
  onSignedIn: (result: { origin: string; token: string; user: ApiUser }) => Promise<void>;
  onOriginChange: (origin: string) => void;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SignInScreen({ transport, initialOrigin, pendingLink, notice, onSignedIn, onOriginChange }: SignInProps) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [origin, setOrigin] = useState(initialOrigin);
  const [originDraft, setOriginDraft] = useState(initialOrigin);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => { if (step === "code") codeInput.current?.focus(); }, [step]);

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
              ? "Read the documents in your Markie Cloud, including the ones your agents make."
              : <>We sent a six-digit code to <strong>{email}</strong>. It expires in 5 minutes.</>}
          </p>
        </div>

        {pendingLink && step === "email" ? (
          <div className="m-callout" role="status"><MailIcon size={18} /><span>Sign in and the document you opened shows up right after.</span></div>
        ) : null}
        {notice ? <div className="m-callout" role="status"><AlertIcon size={18} /><span>{notice}</span></div> : null}

        {step === "email" ? (
          <form className="m-form" onSubmit={sendCode} noValidate>
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
                enterKeyHint="send"
              />
            </label>
            {error ? <p className="m-form-error" role="alert">{error}</p> : null}
            <button type="submit" className="m-button m-button-primary" disabled={busy}>
              {busy ? <span className="m-spinner" aria-hidden="true" /> : null}
              {busy ? "Sending code" : "Send code"}
            </button>

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
