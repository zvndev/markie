// The Share dialog's "Readers see my look" row. An owner pins their look to
// the document: their theme (colours and faces) and their Markdown style (how
// headings, lists, tables and the rest are drawn). Everyone the document is
// shared with, and anyone with its public link, then reads it that way, on
// the web, the desktop and the phone, without having the style themselves.
//
// The pin is a copy made at the moment it is switched on. It does not follow
// later changes to the owner's settings, so the row says when the two have
// drifted and offers to update it.
import { useCallback, useEffect, useState } from "react";
import { activeTemplate, findTheme, loadThemeStore } from "@/lib/theme";
import { activeMarkdownStyleName, markdownStyleStoreOf, pinnableMarkdownStyle, sameMarkdownStyle, withPaintedFonts } from "@/lib/markdown-style";
import { docLookState, setDocLook, type DocLook } from "@/lib/theme-sync";

type State = "loading" | "unknown" | { pinned: boolean; look: DocLook | null };

/** The look this account is using right now, and what to call it. */
function ownLook(): { look: DocLook; label: string } {
  const store = loadThemeStore();
  const styles = markdownStyleStoreOf(store);
  const tokens = findTheme(store, store.activeId).tokens;
  return {
    // The style carries the faces actually on screen (the style's own, or the
    // ones this person chose over them), so a reader gets them from the
    // style alone: the code face reaches a public link no other way.
    look: { tokens, style: withPaintedFonts(pinnableMarkdownStyle(styles), tokens) },
    label: `${activeTemplate(store).name} theme, ${activeMarkdownStyleName(styles)} style`,
  };
}

function sameLook(a: DocLook, b: DocLook): boolean {
  return sameMarkdownStyle(a.style, b.style) && JSON.stringify(a.tokens) === JSON.stringify(b.tokens);
}

export function ShareLook({ docId }: { docId: string }) {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(() => docLookState(docId).then(setState), [docId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Nothing is shown until the server has said what is pinned: a switch in
  // the wrong position is worse than no switch.
  if (state === "loading" || state === "unknown") return null;

  const own = ownLook();
  const pinned = state.pinned;
  const drifted = pinned && !!state.look && !sameLook(state.look, own.look);

  const apply = async (look: DocLook | null) => {
    setBusy(true);
    setFailed(false);
    const ok = await setDocLook(docId, look);
    if (!ok) setFailed(true);
    await refresh();
    setBusy(false);
  };

  return (
    <div className="markie-share-section" data-markie-share-look={pinned ? "on" : "off"}>
      <div className="markie-share-label">Appearance</div>
      <div className="markie-share-general">
        <span className="markie-share-general-icon" data-public={pinned ? "true" : "false"} aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7V5h16v2M9 19h6M12 5v14" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div>Readers see my look</div>
          <div className="markie-share-sub" data-markie-share-look-line>
            {busy
              ? "Updating…"
              : pinned
                ? drifted
                  ? "On, with the look you had when you pinned it. Yours has changed since."
                  : `On: ${own.label}.`
                : `Off. Everyone reads this in their own theme. Turn on to share yours: ${own.label}.`}
          </div>
        </div>
        {drifted ? (
          <button type="button" disabled={busy} onClick={() => void apply(own.look)} className="markie-overlay-button markie-share-btn shrink-0" data-markie-share-look-update>
            Update
          </button>
        ) : null}
        <button
          type="button"
          role="switch"
          aria-checked={pinned}
          aria-label="Readers see my look"
          disabled={busy}
          onClick={() => void apply(pinned ? null : own.look)}
          className="markie-overlay-button markie-share-btn shrink-0"
          data-markie-share-look-switch
        >
          {pinned ? "Turn off" : "Turn on"}
        </button>
      </div>
      {failed ? (
        <div className="markie-share-note" role="alert">
          Markie couldn&apos;t change this just now. Check your connection and try again.
        </div>
      ) : null}
    </div>
  );
}
