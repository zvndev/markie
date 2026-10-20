import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { LibraryItem } from "@/lib/electron";
import { sharesClient, type SharedByMeDoc } from "@/lib/auth-client";
import { organizeLibraryItems } from "@/lib/library-overview";
import { shortAgo } from "@/lib/relative-time";
import { PanelNotice } from "@/components/panel-notice";
import { DEFAULT_LIBRARY_DOCUMENT_QUERY, libraryDocumentFormat, queryLibraryDocuments, type LibraryDocumentQuery } from "@/lib/library-document-query";
import { CloudAreaPicker, useCloudAreaScope } from "./cloud-area-picker";
import type { CloudAreas } from "@/lib/account-identities";
import "./cloud-view.css";

// Everything the cloud holds for this account, as one list.
//
// The Library is what is on the disk and this page is what is in the cloud.
// The cloud used to be four collapsible sections, which meant opening and
// closing headings to find a document. Now every document is one row in one
// list, newest first, each row says how it reached you, and a row of toggles
// above the list narrows it to the ways you care about.

interface CloudViewProps {
  // Every library item. The page sorts them into sources itself, so a caller
  // cannot hand it a list that disagrees with the counts on the toggles.
  items: LibraryItem[];
  query?: LibraryDocumentQuery;
  presentation?: "panel" | "workspace";
  // The ordinary snapshot section owns its own listing and counts. Scope this
  // legacy service's copy and omit a redundant empty list when shown beside it.
  alongsideSnapshots?: boolean;
  // The library snapshot has not arrived yet.
  loading: boolean;
  // Reuse the Library's row renderer so open, pull and download behaviour stays
  // in one place.
  renderRow: (item: LibraryItem) => ReactNode;
  signedIn: boolean;
  // The account the auth store has confirmed, or null while nobody is. What
  // this page fetched belongs to that account and to no other, so it is the
  // key everything account-derived is dropped on. signedIn cannot be: an
  // expired token for one account followed by a sign-in as another never
  // flips it.
  accountId: string | null;
  /** Exact confirmed server/UID/bearer scope supplied by the integrated Library. */
  accountSessionKey?: string;
  // Open the share dialog to manage people on a doc I own.
  onManage: (docId: string, name: string) => void;
  // Open a document that is on this device.
  onOpenPath: (path: string) => void;
  // Why the cloud list may be incomplete (sign-in expired, server unreachable).
  cloudError: string | null;
  // Bump to refetch "shared by me" (membership changed, signed in or out).
  refreshKey: number;
}

// How a document reached this account. Each one is read off data the page
// already has: ownership on the library rows, and the server's list of my
// documents other people can open. A public link and a team are not here
// because nothing this page is given says either about a document; the
// shared-by-me list counts people and invites only.
export type CloudSource = "only-me" | "by-me" | "with-me";

export const CLOUD_SOURCES: ReadonlyArray<{ id: CloudSource; label: string; phrase: string }> = [
  // Mine, and nobody else's: synced from this device or held only in the cloud.
  { id: "only-me", label: "Only me", phrase: "only you can see" },
  // Mine, with at least one person on it or invited to it.
  { id: "by-me", label: "Shared by me", phrase: "you've shared" },
  // Someone else's, opened to me.
  { id: "with-me", label: "Shared with me", phrase: "shared with you" },
];

const SOURCES_KEY = "markie.cloud.sources.v1";

function rememberedSources(): CloudSource[] {
  try {
    const parsed: unknown = JSON.parse(readStorage(SOURCES_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? CLOUD_SOURCES.map((source) => source.id).filter((id) => parsed.includes(id))
      : [];
  } catch {
    return [];
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// One row of the list. A document of mine that I have shared is both a
// library row and an entry in the shared-by-me list, and it is shown once:
// the library row keeps open, pull and download, and the share adds who can
// read it and Manage.
interface CloudEntry {
  key: string;
  source: CloudSource;
  name: string;
  path: string | null;
  updatedAt: string | null;
  // Absent for a document only the server's shared list named.
  item?: LibraryItem;
  share?: SharedByMeDoc;
}

function time(value: string | null): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function later(a: string | null, b: string | null): string | null {
  return time(b) > time(a) ? b : a;
}

// Most recently updated first. Sync state shows as a badge on the row and does
// not lift it above documents touched since, the same as the Library's Recent.
function newestFirst(a: CloudEntry, b: CloudEntry): number {
  return (
    time(b.updatedAt) - time(a.updatedAt) ||
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// "5 documents", or "2 of 5 documents" while the toggles hide some.
//
// The empty verdict is the one line here that has to be earned. Counting
// nothing is not the same as knowing there is nothing: two lists feed this
// band, and while either is still on its way, or has failed outright, "Nothing
// in the cloud yet" would be the app inventing an answer it does not have.
export function cloudBandText(
  total: number,
  shown: number,
  lists: "loading" | "incomplete" | "ready"
): string {
  if (total > 0) return shown === total ? plural(total, "document", "documents") : `${shown} of ${plural(total, "document", "documents")}`;
  if (lists === "loading") return "Checking your cloud…";
  if (lists === "incomplete") return "Some of your cloud didn't load";
  return "Nothing in the cloud yet";
}

// "Shared with 2 · 1 invited". Invites count separately because they have not
// opened anything yet.
export function shareBadgeText(doc: SharedByMeDoc): string {
  const bits: string[] = [];
  if (doc.memberCount > 0) bits.push(`Shared with ${doc.memberCount}`);
  if (doc.pendingCount > 0) bits.push(`${doc.pendingCount} invited`);
  return bits.join(" · ") || "Shared";
}

function sourceBadgeText(entry: CloudEntry, shareListKnown: boolean): string {
  if (entry.share) return shareBadgeText(entry.share);
  // Who shared it and with what role is already on the Library row itself.
  if (entry.source === "with-me") return "Shared with you";
  // "Only you" is a claim about who else can read it, and only the shared list
  // can back it. Until that list has answered the row says whose it is and no
  // more.
  return shareListKnown ? "Only you" : "Yours";
}

// "No documents you've shared or shared with you yet". The sentence names the
// toggles that are on, so an empty list never reads as an empty account.
export function cloudEmptyCopy(sources: CloudSource[], searching: boolean): { title: string; body: string } {
  const phrases = CLOUD_SOURCES.filter((source) => sources.includes(source.id)).map((source) => source.phrase);
  const which = phrases.length > 0 ? ` ${phrases.join(" or ")}` : "";
  if (searching) {
    return {
      title: `No documents${which} match this search`,
      body: phrases.length > 0 ? "Try other words, or turn on more of the buttons above." : "Try other words or another type.",
    };
  }
  if (phrases.length > 0) {
    return { title: `No documents${which} yet`, body: "Turn on more of the buttons above, or choose All." };
  }
  return {
    title: "Nothing in your cloud yet",
    body: "Documents you sync, and docs people share with you, show up here.",
  };
}

export function CloudView({
  items,
  query = DEFAULT_LIBRARY_DOCUMENT_QUERY,
  presentation = "panel",
  alongsideSnapshots = false,
  loading,
  renderRow,
  signedIn,
  accountId,
  accountSessionKey,
  onManage,
  onOpenPath,
  cloudError,
  refreshKey,
}: CloudViewProps) {
  // The toggles that are on. None means every source, the same as All.
  const [sources, setSources] = useState<CloudSource[]>(rememberedSources);
  useEffect(() => {
    write(SOURCES_KEY, JSON.stringify(sources));
  }, [sources]);
  const toggleSource = (id: CloudSource) =>
    setSources((current) => (current.includes(id) ? current.filter((source) => source !== id) : [...current, id]));
  const includes = (id: CloudSource) => sources.length === 0 || sources.includes(id);

  const sharedArea = useCloudAreaScope();
  const [localAreaId, setAreaId] = useState(""), [localAreas, setAreas] = useState<CloudAreas | null>(null);
  const areaId = sharedArea ? sharedArea.areaId : localAreaId, areas = sharedArea ? sharedArea.areas : localAreas;

  const [byMe, setByMe] = useState<SharedByMeDoc[] | null>(null);
  const [byMeError, setByMeError] = useState(false);
  // Lets the error state offer a retry without the parent having to bump
  // refreshKey for something only this panel knows went wrong.
  const [byMeNonce, setByMeNonce] = useState(0);

  // Whose list is on screen. When the account changes under an open panel
  // (A to B, or to nobody), A's names, people counts and Manage controls are
  // dropped in this same render, before anything is asked for B: an effect
  // would run only after A's list had been drawn once more under B's name,
  // and would leave it there for good if B's request never answered. Only on
  // a change of account: doing it on every refresh would blank the list each
  // time somebody's membership changed.
  const sessionKey = accountSessionKey ?? accountId;
  const [byMeFor, setByMeFor] = useState(sessionKey);
  if (byMeFor !== sessionKey) {
    setByMeFor(sessionKey);
    setByMe(null);
    setByMeError(false);
  }

  // Fetch "shared by me" on mount and whenever something changed (refreshKey),
  // and again for each account. Cheap metadata-only call, and no polling: the
  // page already learns about everything else through the same bump.
  useEffect(() => {
    if (!signedIn) return;
    if (accountSessionKey !== undefined && !accountSessionKey) { setByMeError(true); return; }
    let alive = true;
    sharesClient
      .sharedByMe()
      .then((docs) => {
        if (!alive) return;
        // null is a failed request, not an empty account.
        if (docs === null) {
          setByMeError(true);
          return;
        }
        setByMeError(false);
        setByMe(docs);
      })
      .catch(() => {
        if (alive) setByMeError(true);
      });
    return () => {
      alive = false;
    };
  }, [signedIn, accountId, accountSessionKey, refreshKey, byMeNonce]);

  // Which "shared by me" documents this device also has on disk, so a row can
  // open the document instead of only offering to manage its people.
  const localByCloudId = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) {
      if (item.cloudId && item.path && item.exists) map.set(item.cloudId, item.path);
    }
    return map;
  }, [items]);

  // Every document the text query and area allow, each tagged with its source.
  // The toggles filter this list afterwards, so their counts say what turning
  // one on would show.
  const matched = useMemo(() => {
    const inArea = (id: string | null) => !areaId || !!areas?.placements.some((placement) => placement.kind === "markdown" && placement.documentId === id && placement.areaId === areaId);
    const grouped = organizeLibraryItems(items.filter((item) => inArea(item.cloudId)));
    const unclaimed = new Map((byMe ?? []).filter((doc) => inArea(doc.id)).map((doc) => [doc.id, doc]));
    const entries: CloudEntry[] = [];
    const fromItem = (item: LibraryItem, source: CloudSource, share?: SharedByMeDoc): CloudEntry => ({
      key: `item:${item.cloudId ?? item.path ?? item.name}`, source, name: item.name, path: item.path,
      updatedAt: share ? later(item.lastOpenedAt, share.updated_at) : item.lastOpenedAt, item, share,
    });
    for (const item of [...grouped.syncedFromDevice, ...grouped.myCloudOnly]) {
      const share = item.cloudId ? unclaimed.get(item.cloudId) : undefined;
      if (share) unclaimed.delete(share.id);
      entries.push(fromItem(item, share ? "by-me" : "only-me", share));
    }
    for (const item of grouped.sharedItems) entries.push(fromItem(item, "with-me"));
    // Shared documents with no library row of their own, or one whose owner
    // this device has not been told yet.
    for (const doc of unclaimed.values()) {
      entries.push({ key: `share:${doc.id}`, source: "by-me", name: doc.name, path: localByCloudId.get(doc.id) ?? null, updatedAt: doc.updated_at, share: doc });
    }
    entries.sort(newestFirst);
    return queryLibraryDocuments(entries, query, (entry) => ({
      key: entry.key, name: entry.name, format: libraryDocumentFormat(entry.name),
      path: entry.path, updatedAt: entry.updatedAt,
    }));
  }, [items, byMe, query, areaId, areas, localByCloudId]);

  const counts = useMemo(() => {
    const tally: Record<CloudSource, number> = { "only-me": 0, "by-me": 0, "with-me": 0 };
    for (const entry of matched) tally[entry.source] += 1;
    return tally;
  }, [matched]);
  const shown = sources.length === 0 ? matched : matched.filter((entry) => sources.includes(entry.source));

  // Nothing has arrived from the main process yet. The skeleton stands for the
  // whole page: a list saying it holds nothing is a worse answer than "still
  // reading" before we have looked.
  //
  // This is decided before anything else, because "signed out" is not known
  // yet either. The Library starts every mount with signedIn false and
  // corrects it when the snapshot lands, so a signed-in user was being told to
  // sign in for as long as the IPC round trip took.
  const booting = loading && items.length === 0;

  // Both listings feed this page, so both decide whether it may call the
  // account empty. cloudError is the primary one saying it never loaded, and a
  // failed request leaves byMe null exactly as a pending one does, so the
  // failures are read first: "still coming" and "never arrived" are different
  // things to say.
  const lists = booting
    ? "loading"
    : byMeError || cloudError
      ? "incomplete"
      : byMe === null
        ? "loading"
        : "ready";

  const band = cloudBandText(matched.length, shown.length, lists);
  const hasFiles = matched.length > 0;
  const searching = !!query.search.trim() || query.format !== "all";
  const scopedBand = !alongsideSnapshots || hasFiles ? band
    : lists === "loading" ? "Checking file sync and sharing…"
      : lists === "incomplete" ? "Some synced or shared files didn't load"
        : searching ? "No synced or shared files match these filters." : "No synced or shared files yet.";
  // Beside the snapshot listing, an account with nothing here is one line in
  // the band; toggles over an empty list would only repeat it.
  const condensed = alongsideSnapshots && !hasFiles;

  // The shared-by-me list decides two sources: its own, and which of my
  // documents are only mine. While it is pending or failed, those toggles
  // cannot be called empty.
  const shareListKnown = byMe !== null && !byMeError;
  const shareListMatters = includes("by-me") || includes("only-me");
  const settled = !cloudError && (shareListKnown || !shareListMatters);
  const empty = cloudEmptyCopy(sources, searching);

  const notice = cloudError ? { text: cloudError, kind: "error" as const } : null;
  const workspace = presentation === "workspace";

  return (
    <div className={workspace ? "flex min-h-0 flex-col" : alongsideSnapshots ? "mt-2 flex flex-col border-t border-border" : "flex flex-col h-full"}>
      {alongsideSnapshots ? <h3 className={workspace ? "sr-only" : "px-3 pt-2 text-xs font-medium text-muted"}>File sync &amp; sharing</h3> : null}
      {signedIn && !sharedArea ? <div className={workspace ? "mb-3 max-w-[300px]" : "px-3 py-1"}><CloudAreaPicker label="File sync cloud area" value={areaId} onChange={setAreaId} onLoaded={setAreas} fullWidth /></div> : null}
      {/* A signed-out account has no counts to summarize, but one we have not
          looked at yet does, so the band stays while the answer is on its way. */}
      {(booting || signedIn) && (
        <div className={workspace ? "mb-3 shrink-0 rounded-[10px] border border-border/70 bg-background/35 px-3 py-2 text-[11px] tabular-nums text-muted shadow-[inset_0_1px_rgba(255,255,255,0.04)]" : "shrink-0 border-b border-border/60 px-2.5 py-2 text-[10.5px] text-muted"}>
          {scopedBand}
        </div>
      )}

      {signedIn && !booting && !condensed ? (
        <div
          className={`flex shrink-0 flex-wrap items-center gap-1 ${workspace ? "mb-3" : "border-b border-border/60 px-2 py-1.5"}`}
          role="group"
          aria-label="Show documents"
        >
          <button type="button" aria-pressed={sources.length === 0} onClick={() => setSources([])} className="markie-cloud-chip">
            All{" "}<span className="markie-cloud-chip-count">{matched.length}</span>
          </button>
          {CLOUD_SOURCES.map((source) => (
            <button
              key={source.id}
              type="button"
              data-cloud-source={source.id}
              aria-pressed={sources.includes(source.id)}
              onClick={() => toggleSource(source.id)}
              className="markie-cloud-chip"
            >
              {source.label}{" "}<span className="markie-cloud-chip-count">{counts[source.id]}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className={alongsideSnapshots ? "" : "flex-1 overflow-y-auto"}>
        {booting ? (
          <CloudSkeleton label="Loading your cloud documents" />
        ) : !signedIn ? (
          <CloudEmptyState
            icon={<CloudIcon />}
            title={alongsideSnapshots ? "Sign in to see synced and shared files" : "Sign in to see your cloud"}
            body={workspace ? "" : "Documents you sync, and docs people share with you, show up once you sign in."}
          />
        ) : condensed && !byMeError && byMe !== null ? null : (
          <div
            data-cloud-list
            className={workspace ? "min-w-0 rounded-xl border border-border/75 bg-surface-2/55 p-2 shadow-[inset_0_1px_rgba(255,255,255,0.04),0_2px_8px_rgba(0,0,0,0.07)]" : "py-1"}
          >
            {byMeError && shareListMatters ? (
              <CloudEmptyState
                icon={<PeopleIcon />}
                title="Couldn't load the documents you've shared"
                body="The server didn't answer. Your shares are unchanged."
                action={{
                  label: "Try again",
                  onClick: () => {
                    setByMeError(false);
                    setByMeNonce((n) => n + 1);
                  },
                }}
              />
            ) : null}
            {shown.map((entry) =>
              entry.item ? (
                <CloudItemRow
                  key={entry.key}
                  entry={entry}
                  item={entry.item}
                  renderRow={renderRow}
                  shareListKnown={shareListKnown}
                  onManage={onManage}
                />
              ) : (
                <SharedByMeRow
                  key={entry.key}
                  doc={entry.share!}
                  path={entry.path}
                  onOpenPath={onOpenPath}
                  onManage={onManage}
                />
              )
            )}
            {byMe === null && !byMeError && shareListMatters ? (
              <CloudSkeleton label="Loading documents you've shared" />
            ) : null}
            {shown.length === 0 && settled && !condensed ? (
              <CloudEmptyState icon={<CloudIcon />} title={empty.title} body={empty.body} />
            ) : null}
          </div>
        )}
      </div>

      <PanelNotice notice={notice} />
    </div>
  );
}

// The small label under a row that says how the document reached you.
function SourceBadge({ source, text }: { source: CloudSource; text: string }) {
  return (
    <span data-cloud-badge={source} className="markie-cloud-source shrink-0">
      {text}
    </span>
  );
}

// A library row plus a line saying how it reached you and what reconciliation
// (electron/reconcile.js) knows about its pictures. The row itself stays the
// Library's renderer so open, pull and badges live in one place. A document
// I have shared also gets Manage here, which used to live on its own row in a
// section of its own.
function CloudItemRow({
  entry,
  item,
  renderRow,
  shareListKnown,
  onManage,
}: {
  entry: CloudEntry;
  item: LibraryItem;
  renderRow: (item: LibraryItem) => ReactNode;
  shareListKnown: boolean;
  onManage: (docId: string, name: string) => void;
}) {
  const share = entry.share;
  return (
    <div data-cloud-row={entry.source} className="group">
      {renderRow(item)}
      <div className="-mt-1 flex min-w-0 items-center gap-1.5 pb-1 pl-7 pr-2 text-[10px] text-muted">
        <SourceBadge source={entry.source} text={sourceBadgeText(entry, shareListKnown)} />
        <MediaNote item={item} />
        {share ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onManage(share.id, share.name);
            }}
            title={`Manage who can access ${share.name}`}
            className="ml-auto text-[10px] text-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 shrink-0 transition hover:text-foreground focus-visible:opacity-100"
          >
            Manage
          </button>
        ) : null}
      </div>
    </div>
  );
}

// "media pending" while a picture is still on its way up; the name of the
// first one that will never fit, when there is one; and the name of the first
// one that was left behind for sitting outside the document's folder. Both
// are things the person reading this can act on: shrink the file, or move it
// in beside the document. Any other skip reason stays silent: those are files
// the local viewer would not show either, so there is nothing there worth
// telling someone about. They are still in the list though, and reading only
// its first entry let one of them hide the oversized file behind it.
//
// "outside" covers two cases that look the same from here: a file the local
// viewer would refuse anyway, and a file it draws happily but which does not
// travel because somebody else can read this document (electron/asset-sync.js).
// Naming both is right, because either way the copy the other side opens is
// missing that picture.
function MediaNote({ item }: { item: LibraryItem }) {
  const media = item.media;
  if (!media) return null;
  const notes: string[] = [];
  if (media.state === "pending") notes.push("media pending");
  // The server refused the whole link body, which no retry of the same text
  // changes, so the row is settled rather than pending and this is the only
  // word anyone gets. First, because it is about the document rather than
  // about one picture in it.
  const refused = media.skipped?.find((s) => s.reason === "refused");
  if (refused) notes.push(`media refused (${refused.status ?? "?"})`);
  const tooLarge = media.skipped?.find((s) => s.reason === "size");
  if (tooLarge) notes.push(`file too large: ${tooLarge.ref}`);
  const outside = media.skipped?.find((s) => s.reason === "outside");
  if (outside) notes.push(`not uploaded: ${outside.ref} (outside the document's folder)`);
  // A picture whose stored bytes are not the type its name claims. The server
  // will not serve it under that name, so it is a file Markie draws here and
  // the reader of the synced copy does not get, which is worth as much
  // explaining as one that sits outside the folder. Renaming it back, or
  // giving it the extension its bytes really are, is the fix.
  const wrongType = media.skipped?.find((s) => s.reason === "type");
  if (wrongType) notes.push(`not uploaded: ${wrongType.ref} (type)`);
  if (notes.length === 0) return null;
  return <span className="min-w-0 truncate">{notes.join(" · ")}</span>;
}

// A document I own and other people can reach, which this device's library
// has no row for. The row opens it when this device has the file; Manage is
// always there, because who can read a document is a question you can have
// about a copy you do not hold.
function SharedByMeRow({
  doc,
  path,
  onOpenPath,
  onManage,
}: {
  doc: SharedByMeDoc;
  path: string | null;
  onOpenPath: (path: string) => void;
  onManage: (docId: string, name: string) => void;
}) {
  const when = shortAgo(Date.parse(doc.updated_at));
  return (
    <div
      data-cloud-row="by-me"
      className={`group rounded-md px-2 py-1.5 ${
        path ? "cursor-pointer hover:bg-accent/40" : ""
      }`}
      onClick={path ? () => onOpenPath(path) : undefined}
      title={path ?? undefined}
    >
      <div className="flex items-center gap-1.5">
        <FileIcon />
        <span className="text-[12.5px] text-foreground truncate flex-1">{doc.name}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onManage(doc.id, doc.name);
          }}
          title={`Manage who can access ${doc.name}`}
          className="text-[10px] text-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 shrink-0 transition hover:text-foreground focus-visible:opacity-100"
        >
          Manage
        </button>
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-5 text-[10px] text-muted">
        <SourceBadge source="by-me" text={shareBadgeText(doc)} />
        {when ? <span className="tabular-nums">{when}</span> : null}
      </div>
    </div>
  );
}

const SKELETON_WIDTHS = ["68%", "52%", "76%", "44%"];

function CloudSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="animate-pulse" aria-hidden="true">
        {SKELETON_WIDTHS.map((width, i) => (
          <div key={i} className="rounded-md px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <div className="h-[13px] w-[13px] rounded bg-accent shrink-0" />
              <div className="h-2.5 flex-1 rounded bg-accent" style={{ maxWidth: width }} />
              <div className="h-3 w-8 rounded bg-accent shrink-0" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CloudEmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="px-2 py-3">
      <div className="rounded-md border border-border/70 bg-background/45 px-2.5 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <div className="flex items-start gap-2">
          <span className="mt-px shrink-0 text-muted">{icon}</span>
          <div>
            <div className="text-[12px] font-medium text-foreground">{title}</div>
            {body ? <div className="mt-0.5 text-[11px] text-muted leading-snug">{body}</div> : null}
            {action && (
              <button
                onClick={action.onClick}
                className="mt-1.5 text-[11px] text-foreground underline underline-offset-2 hover:opacity-80"
              >
                {action.label}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CloudIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 19a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 19z" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-muted shrink-0"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
