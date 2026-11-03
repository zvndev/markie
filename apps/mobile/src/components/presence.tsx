// Who else is in a live document, as the desktop's toolbar shows it: a
// coloured initial per person, plus whether this phone is connected.
import { colorForName, initials, type PeerUser } from "@/lib/collab";

export type LiveStatus = "connecting" | "connected" | "disconnected" | "unavailable" | "empty";

export function Presence({ peers, status }: { peers: readonly PeerUser[]; status: LiveStatus }) {
  // One row per person, even when they have the document open twice.
  const people = [...new Map(peers.map((peer) => [peer.name, peer])).values()];
  const shown = people.slice(0, 3);
  const label = status === "connected"
    ? people.length === 0 ? "Live. Nobody else is here." : `Live with ${people.map((p) => p.name).join(", ")}`
    : status === "connecting" ? "Connecting to the live session" : "Not connected to the live session";
  return (
    <span className={`m-presence is-${status}`} role="status" aria-label={label} title={label}>
      <span className="m-presence-dot" aria-hidden="true" />
      {shown.map((peer) => (
        <span key={peer.name} className="m-avatar" style={{ background: peer.color || colorForName(peer.name) }} aria-hidden="true">
          {initials(peer.name)}
        </span>
      ))}
      {people.length > shown.length ? <span className="m-avatar m-avatar-more" aria-hidden="true">+{people.length - shown.length}</span> : null}
    </span>
  );
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span className="m-avatar" style={{ background: colorForName(name), width: size, height: size, fontSize: Math.round(size * 0.38) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
