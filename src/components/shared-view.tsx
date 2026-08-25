"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { LibraryItem } from "@/lib/electron";
import { sharesClient, type SharedByMeDoc } from "@/lib/auth-client";

interface SharedViewProps {
  // docs other people shared with me (sourced from the library state)
  sharedWithMe: LibraryItem[];
  withMeLoading: boolean;
  // reuse the library's row renderer so open/pull behaviour stays in one place
  renderRow: (item: LibraryItem) => ReactNode;
  signedIn: boolean;
  // open the share dialog to manage people on a doc I own
  onManage: (docId: string, name: string) => void;
  // bump to refetch the "shared by me" list (membership changed, signed in/out)
  refreshKey: number;
}

const TAB_KEY = "markie.sharedtab.v1";
type SharedTab = "with-me" | "by-me";

function people(d: SharedByMeDoc): string {
  const bits: string[] = [];
  if (d.memberCount > 0)
    bits.push(`${d.memberCount} ${d.memberCount === 1 ? "person" : "people"}`);
  if (d.pendingCount > 0) bits.push(`${d.pendingCount} invited`);
  return bits.join(" · ") || "Shared";
}

export function SharedView({
  sharedWithMe,
  withMeLoading,
  renderRow,
  signedIn,
  onManage,
  refreshKey,
}: SharedViewProps) {
  const [tab, setTab] = useState<SharedTab>(() => {
    try {
      return localStorage.getItem(TAB_KEY) === "by-me" ? "by-me" : "with-me";
    } catch {
      return "with-me";
    }
  });
  const pick = (t: SharedTab) => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // storage unavailable
    }
  };

  const [byMe, setByMe] = useState<SharedByMeDoc[] | null>(null);
  const [byMeError, setByMeError] = useState(false);
  // Lets the error state offer a retry without the parent having to bump
  // refreshKey for something only this panel knows went wrong.
  const [byMeNonce, setByMeNonce] = useState(0);

  // Fetch "shared by me" whenever the panel mounts, the tab opens, or something
  // changed (refreshKey). Cheap metadata-only call. When signed out the render
  // shows a sign-in prompt, so there's nothing to fetch or reset here.
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
  }, [signedIn, refreshKey, tab, byMeNonce]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-0.5 px-1 pb-1.5 shrink-0">
        <TabButton active={tab === "with-me"} onClick={() => pick("with-me")}>
          Shared with me
        </TabButton>
        <TabButton active={tab === "by-me"} onClick={() => pick("by-me")}>
          Shared by me
        </TabButton>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === "with-me" ? (
          withMeLoading ? (
            <SharedSkeleton label="Loading shared documents" />
          ) : sharedWithMe.length === 0 ? (
            signedIn ? (
              <SharedEmptyState
                icon={<PeopleIcon />}
                title="Nothing shared with you yet"
                body="Docs others share with you land here."
              />
            ) : (
              <SharedEmptyState
                icon={<PeopleIcon />}
                title="Sign in to see shared docs"
                body="Docs people share with you show up once you sign in."
              />
            )
          ) : (
            sharedWithMe.map(renderRow)
          )
        ) : !signedIn ? (
          <SharedEmptyState
            icon={<PeopleIcon />}
            title="Sign in to manage sharing"
            body="See and manage the docs you've shared with people."
          />
        ) : byMeError ? (
          <SharedEmptyState
            icon={<PeopleIcon />}
            title="Couldn't load your shared docs"
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
          <SharedSkeleton label="Loading documents you've shared" />
        ) : byMe.length === 0 ? (
          <SharedEmptyState
            icon={<PeopleIcon />}
            title="You haven't shared anything yet"
            body="Open a synced doc and use Share to invite people."
          />
        ) : (
          byMe.map((d) => (
            <button
              key={d.id}
              onClick={() => onManage(d.id, d.name)}
              className="group w-full text-left rounded-md px-2 py-1.5 hover:bg-accent/40"
              title={`Manage who can access ${d.name}`}
            >
              <div className="flex items-center gap-1.5">
                <FileIcon />
                <span className="text-[12.5px] text-foreground truncate flex-1">
                  {d.name}
                </span>
                <span className="text-[10px] text-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 shrink-0 transition">
                  Manage
                </span>
              </div>
              <div className="text-[10px] text-muted pl-5 truncate">
                {people(d)}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

const SKELETON_WIDTHS = ["68%", "52%", "76%", "44%"];

function SharedSkeleton({ label }: { label: string }) {
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

function SharedEmptyState({
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

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 text-[11px] py-1 rounded-md transition-colors ${
        active
          ? "bg-accent text-foreground"
          : "text-muted hover:text-foreground hover:bg-accent/40"
      }`}
    >
      {children}
    </button>
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
