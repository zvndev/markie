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

  // Fetch "shared by me" whenever the panel mounts, the tab opens, or something
  // changed (refreshKey). Cheap metadata-only call. When signed out the render
  // shows a sign-in prompt, so there's nothing to fetch or reset here.
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    sharesClient.sharedByMe().then((docs) => {
      if (alive) setByMe(docs);
    });
    return () => {
      alive = false;
    };
  }, [signedIn, refreshKey, tab]);

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
            <div className="px-2 py-4 text-[12px] text-muted">Loading…</div>
          ) : sharedWithMe.length === 0 ? (
            <div className="px-2 py-4 text-[12px] text-muted leading-relaxed">
              {signedIn
                ? "Nothing shared with you yet. When someone invites you to a doc, it shows up here."
                : "Sign in to see docs people have shared with you."}
            </div>
          ) : (
            sharedWithMe.map(renderRow)
          )
        ) : !signedIn ? (
          <div className="px-2 py-4 text-[12px] text-muted leading-relaxed">
            Sign in to see and manage the docs you&apos;ve shared with people.
          </div>
        ) : byMe === null ? (
          <div className="px-2 py-4 text-[12px] text-muted">Loading…</div>
        ) : byMe.length === 0 ? (
          <div className="px-2 py-4 text-[12px] text-muted leading-relaxed">
            You haven&apos;t shared anything yet. Open a synced doc and use Share
            to invite people — they&apos;ll show up here so you can manage access.
          </div>
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
                <span className="text-[10px] text-muted opacity-0 group-hover:opacity-100 shrink-0">
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
