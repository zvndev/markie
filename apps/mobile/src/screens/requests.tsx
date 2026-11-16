// Requests: documents people want to share with this account, waiting for it
// to accept them (server/src/share-people.ts). Nothing in a request reaches
// the account until it accepts the sender; accepting brings in everything
// that person shared, and what they share later.
import { useCallback, useEffect, useState } from "react";
import { ApiError, type ApiClient, type ShareRequest } from "../lib/api";
import { haptics } from "../lib/native";
import { Screen } from "../components/screen";

interface RequestsProps {
  api: Pick<ApiClient, "shareRequests" | "acceptSender" | "declineRequest" | "blockSender">;
  onBack: () => void;
  /** After an accept or a block: documents landed or left, so the list behind refetches. */
  onChanged: () => void;
  onUnauthorized: () => void;
}

const who = (sender: ShareRequest["sender"]) => sender.name || sender.email;

export function RequestsScreen({ api, onBack, onChanged, onUnauthorized }: RequestsProps) {
  const [requests, setRequests] = useState<ShareRequest[] | null>(null);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const failed = useCallback((failure: unknown, fallback: string) => {
    if (failure instanceof ApiError && failure.status === 401) return onUnauthorized();
    setError(failure instanceof Error ? failure.message : fallback);
  }, [onUnauthorized]);

  const load = useCallback(async () => {
    try {
      const listed = await api.shareRequests();
      setRequests(listed.requests);
      setCount(listed.count);
    } catch (failure) {
      failed(failure, "Couldn't load your requests.");
    }
  }, [api, failed]);

  useEffect(() => { void load(); }, [load]);

  const act = async (work: () => Promise<void>, done: string, changed: boolean) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      haptics.selection();
      setNotice(done);
      if (changed) onChanged();
      await load();
    } catch (failure) {
      failed(failure, "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Requests" largeTitle back={{ label: "Recent", onBack }} className="m-requests" onRefresh={load}>
      <p className="m-group-footer m-requests-intro">
        Nothing someone shares reaches you until you accept them. Accepting a person brings in everything they shared with you.
      </p>
      {notice ? <p className="m-group-footer" role="status">{notice}</p> : null}
      {error ? <p className="m-inline-error" role="alert">{error}</p> : null}
      {requests === null && !error ? <div className="m-list-more"><span className="m-spinner" aria-hidden="true" /><span className="m-visually-hidden" role="status">Loading</span></div> : null}
      {requests && requests.length === 0 ? (
        <div className="m-empty m-empty-compact">
          <h2>No requests</h2>
          <p>When someone you haven't accepted yet shares a document with you, it waits here.</p>
        </div>
      ) : null}
      {requests && requests.length > 0 ? (
        <ul className="m-group m-requests-list" aria-label="Requests">
          {requests.map((request) => (
            <li key={request.docId} className="m-request" data-request={request.docId}>
              <div className="m-request-text">
                <span className="m-request-title"><strong>{who(request.sender)}</strong> wants to share {request.name}</span>
                <span className="m-request-email">{request.sender.email}</span>
              </div>
              <div className="m-request-actions">
                <button type="button" className="m-button m-button-primary m-button-small" disabled={busy}
                  onClick={() => void act(() => api.acceptSender(request.sender.id), `Accepted ${who(request.sender)}. What they share now lands in Recent.`, true)}>
                  Accept
                </button>
                <button type="button" className="m-button m-button-secondary m-button-small" disabled={busy}
                  onClick={() => void act(() => api.declineRequest(request.docId), `Declined ${request.name}.`, false)}>
                  Decline
                </button>
                <button type="button" className="m-button m-button-secondary m-button-small" disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`Block ${who(request.sender)}? You won't see anything they share. They are not told.`)) return;
                    void act(() => api.blockSender(request.sender.id), `Blocked ${who(request.sender)}.`, true);
                  }}>
                  Block
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {requests && count > requests.length ? (
        <p className="m-group-footer">Showing the newest {requests.length} of {count}. Answer these to see the rest.</p>
      ) : null}
    </Screen>
  );
}
