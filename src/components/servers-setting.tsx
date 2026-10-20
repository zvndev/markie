// Settings > Advanced > Servers. Markie Cloud and any Markie server the user
// added, each with its own account.
//
// Adding is two steps by design: the app checks the address and asks the
// server who it is, the user sees that name and address, and only a "yes"
// adds it. Main does the checking and keeps the list (electron/servers.js);
// this component can only ask, never add on its own.
import { useCallback, useEffect, useState } from "react";
import { authFailureCode } from "@/lib/auth-client";
import { authErrorMessage, INVITE_ONLY, signupRefusal } from "@/lib/auth-errors";
import { authStore, useAuth } from "@/lib/auth-store";
import { getElectronAPI, type MarkieServer, type ServerProbe } from "@/lib/electron";
import {
  authStoreFor,
  forgetServerSession,
  getServerToken,
  serverAuthClient,
  setServerToken,
  useAuthFor,
} from "@/lib/server-sessions";

const FIELD = "markie-overlay-field w-full text-[13px] px-3 py-2 rounded-md";
const BUTTON =
  "markie-overlay-button text-[12px] text-muted hover:text-foreground border border-border rounded-md px-3 py-1.5 disabled:opacity-50";
const PRIMARY =
  "markie-overlay-button text-[12px] rounded-md px-3 py-1.5 bg-accent text-foreground hover:opacity-90 disabled:opacity-50";

const DEFAULT_SERVERS: MarkieServer[] = [
  {
    origin: "https://api-production-602f.up.railway.app",
    name: "Markie Cloud",
    isDefault: true,
    signIn: { email: true, google: true },
    version: null,
  },
];

export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

interface ServersSettingProps {
  /** Markie Cloud's sign-in lives on the Account tab. */
  onSignInDefault: () => void;
}

export function ServersSetting({ onSignInDefault }: ServersSettingProps) {
  const api = getElectronAPI();
  const [servers, setServers] = useState<MarkieServer[] | null>(null);
  const canAdd = !!(api?.serversProbe && api?.serversAdd);

  const refresh = useCallback(async () => {
    const list = await getElectronAPI()?.serversList?.().catch(() => null);
    setServers(list && list.length ? list : DEFAULT_SERVERS);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="mb-5">
      <div className="markie-overlay-section mb-2">Servers</div>
      <div className="text-[11px] text-muted mb-2">
        To work on someone&rsquo;s document, sign in to the server it lives on.
      </div>
      <ul className="flex flex-col gap-2" aria-label="Markie servers">
        {(servers ?? DEFAULT_SERVERS).map((s) =>
          s.isDefault ? (
            <DefaultServerRow key={s.origin} server={s} onSignIn={onSignInDefault} />
          ) : (
            <ServerRow key={s.origin} server={s} onRemoved={refresh} />
          )
        )}
      </ul>
      {canAdd && <AddServer onAdded={refresh} />}
    </div>
  );
}

function RowShell({ server, children }: { server: MarkieServer; children: React.ReactNode }) {
  return (
    <li className="rounded-md border border-border px-3 py-2" aria-label={server.name}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] text-foreground truncate">{server.name}</div>
          <div className="text-[11px] text-muted truncate">{hostOf(server.origin)}</div>
        </div>
      </div>
      {children}
    </li>
  );
}

function DefaultServerRow({ server, onSignIn }: { server: MarkieServer; onSignIn: () => void }) {
  const { user, status } = useAuth();
  return (
    <RowShell server={server}>
      <div className="flex items-center justify-between gap-3 mt-1.5">
        <AccountLine status={status} email={user?.email ?? null} />
        {status === "in" ? (
          <button className={BUTTON} onClick={() => void authStore.signOut()}>
            Sign out
          </button>
        ) : status === "out" ? (
          <button className={BUTTON} onClick={onSignIn}>
            Sign in
          </button>
        ) : null}
      </div>
    </RowShell>
  );
}

function AccountLine({ status, email }: { status: string; email: string | null }) {
  return (
    <div className="text-[11px] text-muted truncate">
      {status === "checking" ? "Checking…" : status === "in" && email ? `Signed in as ${email}` : "Not signed in"}
    </div>
  );
}

function ServerRow({ server, onRemoved }: { server: MarkieServer; onRemoved: () => void }) {
  const { user, status } = useAuthFor(server.origin);
  const [signingIn, setSigningIn] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // With no token stored there is nobody to ask about.
  const shown = getServerToken(server.origin) ? status : "out";

  const remove = async () => {
    setBusy(true);
    setError(null);
    const res = await getElectronAPI()?.serversRemove?.(server.origin).catch(() => null);
    setBusy(false);
    if (!res || res.error) {
      setError(res?.error ?? "Couldn't remove this server.");
      return;
    }
    // Its token goes too; nothing for that server is kept on this device.
    if (getServerToken(server.origin)) await authStoreFor(server.origin).signOut().catch(() => {});
    forgetServerSession(server.origin);
    onRemoved();
  };

  return (
    <RowShell server={server}>
      <div className="flex items-center justify-between gap-3 mt-1.5">
        <AccountLine status={shown} email={user?.email ?? null} />
        <div className="flex gap-2 shrink-0">
          {shown === "in" ? (
            <button className={BUTTON} onClick={() => void authStoreFor(server.origin).signOut()}>
              Sign out
            </button>
          ) : shown === "out" && !signingIn ? (
            <button className={BUTTON} onClick={() => setSigningIn(true)}>
              Sign in
            </button>
          ) : null}
          {!confirmRemove && (
            <button className={BUTTON} onClick={() => setConfirmRemove(true)} aria-label={`Remove ${server.name}`}>
              Remove
            </button>
          )}
        </div>
      </div>
      {confirmRemove && (
        <div className="mt-2 flex items-center justify-between gap-3" role="group" aria-label="Confirm removal">
          <span className="text-[11px] text-muted">Remove this server? You&rsquo;ll be signed out of it.</span>
          <div className="flex gap-2 shrink-0">
            <button className={BUTTON} onClick={() => setConfirmRemove(false)} disabled={busy}>
              Cancel
            </button>
            <button className={PRIMARY} onClick={() => void remove()} disabled={busy}>
              Remove
            </button>
          </div>
        </div>
      )}
      {signingIn && shown !== "in" && (
        <ServerSignIn server={server} onDone={() => setSigningIn(false)} onCancel={() => setSigningIn(false)} />
      )}
      {error && <div className="text-[11px] text-red-500 mt-1" role="alert">{error}</div>}
    </RowShell>
  );
}

/** Email and password against any added server; Google when it offers it. */
export function ServerSignIn({
  server,
  onDone,
  onCancel,
}: {
  server: MarkieServer;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const client = serverAuthClient(server.origin);
  const signup = server.signIn.signup ?? "open";
  // Closed: nobody new gets an account, so there is nothing to offer.
  const creating = isSignUp && signup !== "closed";

  const submit = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = creating
      ? await client.signUpEmail(email, password, email.split("@")[0])
      : await client.signInEmail(email, password);
    if (res.ok && res.data?.token && !getServerToken(server.origin)) setServerToken(server.origin, res.data.token);
    setBusy(false);
    if (!res.ok) {
      setError(
        signupRefusal(res.status, res.data) ??
          (res.status === 403 && authFailureCode(res.data) === "EMAIL_NOT_VERIFIED"
            ? "Confirm your email address first, then sign in."
            : authErrorMessage(res.status, creating ? "password-signup" : "password-signin"))
      );
      return;
    }
    if (!getServerToken(server.origin)) {
      setNotice("Check your email to confirm your address, then sign in.");
      return;
    }
    await authStoreFor(server.origin).refresh();
    onDone();
  };

  const google = async () => {
    setError(null);
    const url = client.googleSignInURL();
    if (!url) {
      setError("Couldn't start Google sign-in on this device.");
      return;
    }
    await getElectronAPI()?.openExternal?.(url);
    setNotice("Finish signing in in your browser.");
  };

  // The name is whatever the server calls itself. The host is where the
  // password goes, so it is said in so many words.
  const host = hostOf(server.origin);
  return (
    <form
      className="mt-2 flex flex-col gap-2"
      aria-label={`Sign in to ${server.name} at ${host}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div>
        <div className="text-[12px] text-foreground">
          Sign in to {server.name}
          {server.name !== host && <span className="text-muted"> ({host})</span>}
        </div>
        <div className="text-[11px] text-muted" data-testid="server-sign-in-destination">
          Your email and password go to {host}, not to Markie Cloud.
        </div>
      </div>
      {server.signIn.google && (
        <button type="button" className={BUTTON} onClick={() => void google()} disabled={busy}>
          Continue with Google
        </button>
      )}
      <input
        className={FIELD}
        type="email"
        autoComplete="email"
        placeholder="Email"
        aria-label="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        className={FIELD}
        type="password"
        autoComplete={creating ? "new-password" : "current-password"}
        placeholder="Password"
        aria-label="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {signup === "invite" && <div className="text-[11px] text-muted">{INVITE_ONLY}</div>}
      {error && <div className="text-[11px] text-red-500" role="alert">{error}</div>}
      {notice && <div className="text-[11px] text-muted" role="status">{notice}</div>}
      <div className="flex items-center justify-between gap-2">
        {signup !== "closed" ? (
          <button
            type="button"
            className="text-[11px] text-muted hover:text-foreground"
            onClick={() => setIsSignUp((v) => !v)}
          >
            {creating ? "Have an account? Sign in" : "New here? Create an account"}
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <button type="button" className={BUTTON} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={PRIMARY} disabled={busy || !email || !password}>
            {busy ? "…" : creating ? "Create account" : "Sign in"}
          </button>
        </div>
      </div>
    </form>
  );
}

function AddServer({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [probe, setProbe] = useState<Extract<ServerProbe, { ok: true }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setOpen(false);
    setAddress("");
    setProbe(null);
    setError(null);
  };

  const check = async () => {
    setBusy(true);
    setError(null);
    const res = await getElectronAPI()?.serversProbe?.(address).catch(() => null);
    setBusy(false);
    if (!res) {
      setError("Couldn't check that server.");
      return;
    }
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (res.alreadyAdded) {
      setError(`${res.name} is already in your list.`);
      return;
    }
    setProbe(res);
  };

  const add = async () => {
    if (!probe) return;
    setBusy(true);
    setError(null);
    const res = await getElectronAPI()?.serversAdd?.(probe.probeId).catch(() => null);
    setBusy(false);
    if (!res || !res.ok) {
      setError(res && !res.ok ? res.error : "Couldn't add that server.");
      return;
    }
    reset();
    onAdded();
  };

  if (!open) {
    return (
      <button className={`${BUTTON} mt-2`} onClick={() => setOpen(true)}>
        Add a server…
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-border px-3 py-2">
      {!probe ? (
        <form
          className="flex flex-col gap-2"
          aria-label="Add a server"
          onSubmit={(e) => {
            e.preventDefault();
            void check();
          }}
        >
          <label className="text-[11px] text-muted" htmlFor="markie-add-server">
            Server address
          </label>
          <input
            id="markie-add-server"
            className={FIELD}
            placeholder="https://docs.example.com"
            value={address}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setAddress(e.target.value)}
          />
          {error && <div className="text-[11px] text-red-500" role="alert">{error}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" className={BUTTON} onClick={reset} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className={PRIMARY} disabled={busy || !address.trim()}>
              {busy ? "Checking…" : "Continue"}
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-2" role="group" aria-label="Confirm server">
          <div className="text-[12px] text-foreground">Add this server?</div>
          <div>
            <div className="text-[13px] text-foreground">{probe.name}</div>
            <div className="text-[11px] text-muted break-all">{probe.origin}</div>
          </div>
          <div className="text-[11px] text-muted">
            Only add servers you trust. Your sign-in for it is sent only to this address.
          </div>
          {error && <div className="text-[11px] text-red-500" role="alert">{error}</div>}
          <div className="flex justify-end gap-2">
            <button className={BUTTON} onClick={reset} disabled={busy}>
              Cancel
            </button>
            <button className={PRIMARY} onClick={() => void add()} disabled={busy}>
              Add server
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
