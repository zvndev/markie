import { useCallback, useEffect, useState } from "react";
import { peopleClient, type PeopleClient, type SharePerson, type ShareRequest } from "@/lib/auth-client";

// The recipient's side of sharing (server/src/share-people.ts). Nothing
// somebody shares lands in this account's Markie until the account accepts
// that person once; until then it waits here as a request.

const BUTTON =
  "markie-overlay-button rounded-md border border-border px-2 py-1 text-[11.5px] text-muted hover:text-foreground disabled:opacity-40";
const PRIMARY =
  "markie-overlay-button rounded-md border border-border bg-foreground/10 px-2 py-1 text-[11.5px] font-medium text-foreground hover:bg-foreground/15 disabled:opacity-40";

const who = (person: { name: string | null; email: string }) => person.name || person.email;

/**
 * Requests waiting for this account: who wants to share which file, with
 * Accept, Decline and Block. Renders nothing while there are none, so it only
 * takes room when someone is waiting. `onChanged` runs after an accept or a
 * block, so the caller can refetch the documents that just landed or left.
 */
export function ShareRequestsPanel({
  accountKey,
  onChanged,
  client = peopleClient,
}: {
  // Whose requests these are. A change drops the old list at once.
  accountKey: string | null;
  onChanged?: () => void;
  client?: PeopleClient;
}) {
  const [state, setState] = useState<{ key: string | null; requests: ShareRequest[] }>({ key: null, requests: [] });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountKey) return;
    const requests = await client.requests();
    // A failed request keeps what is on screen rather than calling it empty.
    if (requests) setState({ key: accountKey, requests });
  }, [accountKey, client]);

  useEffect(() => {
    void load();
  }, [load]);

  const requests = state.key === accountKey ? state.requests : [];
  if (!accountKey || requests.length === 0) {
    return notice ? (
      <div className="mb-2 px-2 text-[11px] text-muted" role="status">
        {notice}
      </div>
    ) : null;
  }

  const act = async (key: string, work: () => Promise<boolean>, done: string, failed: string, refresh: boolean) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    const ok = await work().catch(() => false);
    setBusy(null);
    if (!ok) return setError(failed);
    setNotice(done);
    await load();
    if (refresh) onChanged?.();
  };

  return (
    <section
      aria-labelledby="markie-share-requests-title"
      className="mb-3 rounded-lg border border-border/80 bg-surface-2/40 px-2.5 py-2"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <h3 id="markie-share-requests-title" className="text-[11.5px] font-medium text-foreground">
          Requests
        </h3>
        <span
          data-share-requests-count
          aria-label={`${requests.length} waiting`}
          className="markie-cloud-chip-count rounded-full border border-border px-1.5 text-[10px] text-foreground"
        >
          {requests.length}
        </span>
      </div>
      <p className="mb-2 text-[10.5px] text-muted">
        Nothing someone shares reaches your Markie until you accept them. Accepting a person brings in everything they
        have shared with you, and what they share later.
      </p>
      <ul className="flex flex-col gap-1.5">
        {requests.map((request) => (
          <li
            key={request.docId}
            data-share-request={request.docId}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/60 pt-1.5 first:border-t-0 first:pt-0"
          >
            <div className="min-w-0 flex-1 text-[11.5px]">
              <div className="truncate text-foreground">
                <strong className="font-medium">{who(request.sender)}</strong> wants to share{" "}
                <span className="font-medium">{request.name}</span>
              </div>
              <div className="truncate text-[10.5px] text-muted">{request.sender.email}</div>
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                className={PRIMARY}
                disabled={busy !== null}
                onClick={() =>
                  void act(
                    request.docId,
                    () => client.accept(request.sender.id),
                    `Accepted ${who(request.sender)}. What they share lands in your Markie.`,
                    "Couldn't accept. Try again.",
                    true
                  )
                }
              >
                Accept
              </button>
              <button
                type="button"
                className={BUTTON}
                disabled={busy !== null}
                onClick={() =>
                  void act(request.docId, () => client.decline(request.docId), `Declined ${request.name}.`, "Couldn't decline. Try again.", false)
                }
              >
                Decline
              </button>
              <button
                type="button"
                className={BUTTON}
                disabled={busy !== null}
                title={`Hide everything ${who(request.sender)} shares with you, now and later. They are not told.`}
                onClick={() =>
                  void act(
                    request.docId,
                    () => client.block(request.sender.id),
                    `Blocked ${who(request.sender)}. You won't see their requests.`,
                    "Couldn't block. Try again.",
                    true
                  )
                }
              >
                Block
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error ? (
        <div className="mt-1.5 text-[11px] text-[var(--status-red)]" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Account settings: the people whose shares land (Remove, Block) and the
 * people this account blocked (Unblock).
 */
export function SharePeopleSettings({ accountId, client = peopleClient }: { accountId: string; client?: PeopleClient }) {
  const [people, setPeople] = useState<{ accountId: string; accepted: SharePerson[]; blocked: SharePerson[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const listed = await client.people().catch(() => null);
    if (!listed) return setFailed(true);
    setFailed(false);
    setPeople({ accountId, ...listed });
  }, [accountId, client]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, work: () => Promise<boolean>, done: string, failure: string) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    const ok = await work().catch(() => false);
    setBusy(null);
    if (!ok) return setError(failure);
    setNotice(done);
    await load();
  };

  const mine = people?.accountId === accountId ? people : null;

  return (
    <section className="mt-4 border-t border-border pt-3" aria-labelledby="markie-share-people-title">
      <h3 id="markie-share-people-title" className="markie-overlay-section mb-1">
        Accepted people
      </h3>
      <p className="mb-2 text-[11px] text-muted">
        What these people share lands in your Markie. Removing someone takes everything they shared out of your
        Markie at once.
      </p>
      {failed && !mine ? <div className="text-[11.5px] text-muted">Couldn&apos;t load the people you accepted.</div> : null}
      {mine && mine.accepted.length === 0 ? (
        <div className="text-[11.5px] text-muted">Nobody yet. When someone shares with you, accept them in Requests.</div>
      ) : null}
      <ul className="flex flex-col gap-1">
        {mine?.accepted.map((person) => (
          <PersonRow key={person.id} person={person}>
            <button
              type="button"
              className={BUTTON}
              disabled={busy !== null}
              onClick={() => {
                if (!window.confirm(`Remove ${who(person)}? Everything they shared leaves your Markie now.`)) return;
                void act(person.id, () => client.remove(person.id), `Removed ${who(person)}.`, "Couldn't remove them. Try again.");
              }}
            >
              Remove
            </button>
            <button
              type="button"
              className={BUTTON}
              disabled={busy !== null}
              title="Remove them and hide anything they share later. They are not told."
              onClick={() => {
                if (!window.confirm(`Block ${who(person)}? Everything they shared leaves your Markie now, and you won't see their requests.`)) return;
                void act(person.id, () => client.block(person.id), `Blocked ${who(person)}.`, "Couldn't block them. Try again.");
              }}
            >
              Block
            </button>
          </PersonRow>
        ))}
      </ul>

      {mine && mine.blocked.length > 0 ? (
        <>
          <h3 className="markie-overlay-section mb-1 mt-3">Blocked</h3>
          <ul className="flex flex-col gap-1">
            {mine.blocked.map((person) => (
              <PersonRow key={person.id} person={person}>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy !== null}
                  onClick={() =>
                    void act(person.id, () => client.unblock(person.id), `Unblocked ${who(person)}. What they share shows up in Requests.`, "Couldn't unblock them. Try again.")
                  }
                >
                  Unblock
                </button>
              </PersonRow>
            ))}
          </ul>
        </>
      ) : null}
      {error ? (
        <div className="mt-1.5 text-[11px] text-[var(--status-red)]" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="mt-1.5 text-[11px] text-muted" role="status">
          {notice}
        </div>
      ) : null}
    </section>
  );
}

function PersonRow({ person, children }: { person: SharePerson; children: React.ReactNode }) {
  return (
    <li data-share-person={person.id} className="flex items-center gap-2 py-0.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] text-foreground">{who(person)}</div>
        {person.name ? <div className="truncate text-[10.5px] text-muted">{person.email}</div> : null}
      </div>
      <div className="flex shrink-0 gap-1">{children}</div>
    </li>
  );
}
