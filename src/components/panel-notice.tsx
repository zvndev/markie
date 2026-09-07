// The one line at the foot of a side panel that says what just happened.
//
// It lives on its own because two panels now raise notices: the Library for the
// action you just took, the Cloud page for a listing the server would not hand
// over. One component means the two can never drift into looking like different
// kinds of message.

export type NoticeKind = "info" | "error";

export interface Notice {
  text: string;
  kind: NoticeKind;
}

// A notice is either "that worked" or "that failed", and they must not look
// alike: a red line that says "Path copied" is alarming, and a grey line that
// says a sync failed reads as chatter and gets ignored.
export function PanelNotice({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <div
      className={`px-3 py-2 text-[11px] border-t border-border ${
        notice.kind === "error" ? "text-[var(--status-red)]" : "text-muted"
      }`}
    >
      {notice.text}
    </div>
  );
}
