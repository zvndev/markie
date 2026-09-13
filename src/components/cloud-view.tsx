import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { LibraryItem } from "@/lib/electron";
import { sharesClient, type SharedByMeDoc } from "@/lib/auth-client";
import { organizeLibraryItems } from "@/lib/library-overview";
import { shortAgo } from "@/lib/relative-time";
import { PanelNotice } from "@/components/panel-notice";

// Everything the cloud holds for this account, on one page.
//
// This replaces the Shared panel, whose two tabs were two of the four sections
// below. The other two used to be the bottom of the Library, which meant "where
// is my document" had two answers depending on whether the copy on this device
// still existed. Now the Library is what is on the disk and this page is what
// is in the cloud.

interface CloudViewProps {
  // Every library item. The page groups them itself, so a caller cannot hand it
  // a list that disagrees with the counts in the band.
  items: LibraryItem[];
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
  // Open the share dialog to manage people on a doc I own.
  onManage: (docId: string, name: string) => void;
  // Open a document that is on this device.
  onOpenPath: (path: string) => void;
  // Why the cloud list may be incomplete (sign-in expired, server unreachable).
  cloudError: string | null;
  // Bump to refetch "shared by me" (membership changed, signed in or out).
  refreshKey: number;
}

const OPEN_KEY = "markie.cloud.open.v1";
const TAB_KEY = "markie.cloudtab.v1";
// The Shared panel's tab choice. Read exactly once, when TAB_KEY is absent.
const SHARED_TAB_KEY = "markie.sharedtab.v1";

type SectionId = "synced" | "cloud" | "with-me" | "by-me";

const SECTION_IDS: SectionId[] = ["synced", "cloud", "with-me", "by-me"];

const SECTION_LABEL: Record<SectionId, string> = {
  synced: "Synced from this device",
  cloud: "In your cloud",
  "with-me": "Shared with me",
  "by-me": "Shared by me",
};

// Every section is on the page whatever the account holds, so the page has one
// shape. A heading that disappears when its list is empty leaves someone
// hunting for a section with no way to know it exists, so an empty one says so
// in a line instead. The band is the summary and still leaves zeroes out.
const SECTION_EMPTY: Record<SectionId, string> = {
  synced: "Nothing synced from this device yet",
  cloud: "Nothing in your cloud yet",
  "with-me": "Nobody has shared a document with you yet",
  "by-me": "You haven't shared a document yet",
};

type OpenState = Record<SectionId, boolean>;

// Sections start open: a page whose contents are hidden until you find the
// triangles is a page that looks empty. The one exception is the pair that used
// to be tabs, below.
export function initialCloudOpen(): OpenState {
  const open: OpenState = { synced: true, cloud: true, "with-me": true, "by-me": true };
  // A tab is a section with the other one collapsed, so someone who lived in
  // "Shared by me" lands on "Shared by me" rather than on a page where their
  // list has moved. Only for someone who actually picked a tab: a new user
  // never chose to see one list at a time, and gets all four. Carried across
  // once; after that TAB_KEY exists and the old key is never consulted again.
  if (readStorage(TAB_KEY) === null) {
    const carried = readStorage(SHARED_TAB_KEY);
    if (carried === "with-me" || carried === "by-me") {
      open["with-me"] = carried === "with-me";
      open["by-me"] = carried === "by-me";
    }
    write(TAB_KEY, carried === "by-me" ? "by-me" : "with-me");
  }
  const stored = parseOpen(readStorage(OPEN_KEY));
  for (const id of SECTION_IDS) {
    if (typeof stored[id] === "boolean") open[id] = stored[id] as boolean;
  }
  return open;
}

function parseOpen(raw: string | null): Partial<OpenState> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Partial<OpenState>) : {};
  } catch {
    return {};
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

// "3 synced · 1 in your cloud · 2 shared with you · 1 shared by you". A count of
// zero says nothing worth a segment, so it is left out rather than printed.
//
// The empty verdict is the one line here that has to be earned. Counting
// nothing is not the same as knowing there is nothing: two lists feed this
// band, and while either is still on its way, or has failed outright, "Nothing
// in the cloud yet" would be the app inventing an answer it does not have.
export function cloudBandText(
  counts: Record<SectionId, number>,
  lists: "loading" | "incomplete" | "ready"
): string {
  const parts = [
    [counts.synced, "synced"],
    [counts.cloud, "in your cloud"],
    [counts["with-me"], "shared with you"],
    [counts["by-me"], "shared by you"],
  ] as const;
  const said = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  if (said.length > 0) return said.join(" · ");
  if (lists === "loading") return "Checking your cloud…";
  if (lists === "incomplete") return "Some of your cloud didn't load";
  return "Nothing in the cloud yet";
}

function people(d: SharedByMeDoc): string {
  const bits: string[] = [];
  if (d.memberCount > 0)
    bits.push(`${d.memberCount} ${d.memberCount === 1 ? "person" : "people"}`);
  if (d.pendingCount > 0) bits.push(`${d.pendingCount} invited`);
  const when = shortAgo(Date.parse(d.updated_at));
  if (when) bits.push(when);
  return bits.join(" · ") || "Shared";
}

export function CloudView({
  items,
  loading,
  renderRow,
  signedIn,
  accountId,
  onManage,
  onOpenPath,
  cloudError,
  refreshKey,
}: CloudViewProps) {
  const [open, setOpen] = useState<OpenState>(initialCloudOpen);
  const toggle = (id: SectionId) =>
    setOpen((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      write(OPEN_KEY, JSON.stringify(next));
      return next;
    });

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
  const [byMeFor, setByMeFor] = useState(accountId);
  if (byMeFor !== accountId) {
    setByMeFor(accountId);
    setByMe(null);
    setByMeError(false);
  }

  // Fetch "shared by me" on mount and whenever something changed (refreshKey),
  // and again for each account. Cheap metadata-only call, and no polling: the
  // page already learns about everything else through the same bump.
  useEffect(() => {
    if (!signedIn) return;
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
  }, [signedIn, accountId, refreshKey, byMeNonce]);

  const { syncedFromDevice, myCloudOnly, sharedItems } = useMemo(
    () => organizeLibraryItems(items),
    [items]
  );

  // Which "shared by me" documents this device also has on disk, so a row can
  // open the document instead of only offering to manage its people.
  const localByCloudId = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) {
      if (item.cloudId && item.path && item.exists) map.set(item.cloudId, item.path);
    }
    return map;
  }, [items]);

  // Nothing has arrived from the main process yet. The skeleton stands for the
  // whole page rather than one section: four headings each saying they hold
  // nothing is a worse answer than "still reading" before we have looked.
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

  const band = cloudBandText(
    {
      synced: syncedFromDevice.length,
      cloud: myCloudOnly.length,
      "with-me": sharedItems.length,
      "by-me": byMe?.length ?? 0,
    },
    lists
  );

  const notice = cloudError ? { text: cloudError, kind: "error" as const } : null;

  return (
    <div className="flex flex-col h-full">
      {/* A signed-out account has no counts to summarize, but one we have not
          looked at yet does, so the band stays while the answer is on its way. */}
      {(booting || signedIn) && (
        <div className="shrink-0 border-b border-border/60 px-2.5 py-2 text-[10.5px] text-muted">
          {band}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {booting ? (
          <CloudSkeleton label="Loading your cloud documents" />
        ) : !signedIn ? (
          <CloudEmptyState
            icon={<CloudIcon />}
            title="Sign in to see your cloud"
            body="Documents you sync, and docs people share with you, show up once you sign in."
          />
        ) : (
          <>
            <Section
              id="synced"
              count={syncedFromDevice.length}
              open={open.synced}
              onToggle={toggle}
            >
              {syncedFromDevice.length > 0 ? (
                syncedFromDevice.map((i) => (
                  <RowWithMediaNote key={i.cloudId ?? i.path ?? i.name} item={i} renderRow={renderRow} />
                ))
              ) : (
                <SectionEmpty id="synced" />
              )}
            </Section>

            <Section id="cloud" count={myCloudOnly.length} open={open.cloud} onToggle={toggle}>
              {myCloudOnly.length > 0 ? (
                myCloudOnly.map((i) => (
                  <RowWithMediaNote key={i.cloudId ?? i.path ?? i.name} item={i} renderRow={renderRow} />
                ))
              ) : (
                <SectionEmpty id="cloud" />
              )}
            </Section>

            <Section
              id="with-me"
              count={sharedItems.length}
              open={open["with-me"]}
              onToggle={toggle}
            >
              {sharedItems.length > 0 ? (
                sharedItems.map((i) => (
                  <RowWithMediaNote key={i.cloudId ?? i.path ?? i.name} item={i} renderRow={renderRow} />
                ))
              ) : (
                <SectionEmpty id="with-me" />
              )}
            </Section>

            <Section id="by-me" count={byMe?.length ?? 0} open={open["by-me"]} onToggle={toggle}>
              {byMeError ? (
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
              ) : byMe === null ? (
                <CloudSkeleton label="Loading documents you've shared" />
              ) : byMe.length > 0 ? (
                byMe.map((d) => (
                  <SharedByMeRow
                    key={d.id}
                    doc={d}
                    path={localByCloudId.get(d.id) ?? null}
                    onOpenPath={onOpenPath}
                    onManage={onManage}
                  />
                ))
              ) : (
                <SectionEmpty id="by-me" />
              )}
            </Section>
          </>
        )}
      </div>

      <PanelNotice notice={notice} />
    </div>
  );
}

// A row plus what reconciliation (electron/reconcile.js) knows about its
// pictures. The row itself stays the Library's renderer so open, pull and
// badges live in one place; this only adds a line beneath it.
function RowWithMediaNote({
  item,
  renderRow,
}: {
  item: LibraryItem;
  renderRow: (item: LibraryItem) => ReactNode;
}) {
  return (
    <div>
      {renderRow(item)}
      <MediaNote item={item} />
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
  const tooLarge = media.skipped?.find((s) => s.reason === "size");
  if (tooLarge) notes.push(`file too large: ${tooLarge.ref}`);
  const outside = media.skipped?.find((s) => s.reason === "outside");
  if (outside) notes.push(`not uploaded: ${outside.ref} (outside the document's folder)`);
  if (notes.length === 0) return null;
  return (
    <div className="text-[10px] text-muted pl-5 truncate">{notes.join(" · ")}</div>
  );
}

function SectionEmpty({ id }: { id: SectionId }) {
  // Indented to the width of a row's icon, so it reads as the list's first
  // line rather than as another heading.
  return <div className="py-1 pr-2 pl-5 text-[11px] text-muted">{SECTION_EMPTY[id]}</div>;
}

function Section({
  id,
  count,
  open,
  onToggle,
  children,
}: {
  id: SectionId;
  count: number;
  open: boolean;
  onToggle: (id: SectionId) => void;
  children: ReactNode;
}) {
  return (
    <div data-cloud-section={id}>
      <button
        onClick={() => onToggle(id)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-2 pt-3 pb-1 text-left"
      >
        <span className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-muted">
          <Chevron open={open} />
          {SECTION_LABEL[id]}
        </span>
        <span className="rounded border border-border/70 px-1 py-px text-[9px] tabular-nums text-muted">
          {count}
        </span>
      </button>
      {open && children}
    </div>
  );
}

// A document I own and other people can reach. The row opens it when this
// device has the file; Manage is always there, because who can read a document
// is a question you can have about a copy you do not hold.
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
  return (
    <div
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
      <div className="text-[10px] text-muted pl-5 truncate">{people(doc)}</div>
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
            <div className="mt-0.5 text-[11px] text-muted leading-snug">{body}</div>
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

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
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
