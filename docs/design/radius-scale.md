# Corner radius scale

Markie uses three corner radii, tied to how far a surface sits above the base layer.

| Surface | Radius | Tailwind class |
|---|---|---|
| Cards, list rows, inline info boxes | 6px | `rounded-md` |
| Popovers, dropdown menus, floating toolbars | 8px | `rounded-lg` |
| Modals, dialogs (anything behind a scrim) | 12px | `rounded-xl` |

## Why three steps

A radius scale reads as depth: the more a surface floats above the page, the
softer its corners. Three steps is enough to separate "sits in the flow"
(cards), "floats over the flow, dismissible by click-away" (popovers), and
"blocks the flow" (modals) without adding a fourth bucket nobody can
remember the rule for. More steps than that and picking one becomes a
guess instead of a lookup.

## How to apply it

- Building a card, table row, or an inline box (info panel, status row) →
  `rounded-md`.
- Building anything `absolute`-positioned that floats over content and
  closes on click-away (a dropdown, a context menu, a find bar, a format
  toolbar) → `rounded-lg`.
- Building anything behind a `fixed inset-0` scrim (a full dialog, a
  confirm prompt) → `rounded-xl`.
- Small interactive controls nested inside one of these (a button, an
  input, a close icon) can stay at `rounded-md` regardless of their
  container. The scale is about the surface, not every control glued to it.

## Known one-offs

Found by grepping `src/` for `rounded-`, `border-radius`, and `radius:`.
Everything under `src/app/globals.css` and `src/lib/pdf-styles.ts` is
markdown/print content (blockquotes, code blocks, checkboxes, scrollbars) and
sits outside this scale on purpose — it is not an app surface, it is
document styling. The two real one-offs on interactive app surfaces:

- `src/components/terminal-panel.tsx:166` — the "Open in ▾" dropdown menu
  uses `rounded-md` (6px). It is a floating, click-away menu, so it should
  be `rounded-lg` per the popover row above.
- `src/components/update-toast.tsx:77` — the update-ready toast uses
  `rounded-xl` (12px). It has no scrim and isn't a blocking dialog, so by
  surface type it's closer to a popover and should be `rounded-lg`, not
  `rounded-xl`.

Not fixed here — this doc only records them for a follow-up pass, since the
fix touches `src/`, which is outside this task's ownership.

Everything else audited (modals in `settings.tsx`, `agents-dialog.tsx`,
`disk-change.tsx`, `sign-in.tsx`, `shortcuts-help.tsx`, `share-dialog.tsx`,
`share-gate.tsx`, `conflict-dialog.tsx`, `command-palette.tsx`; popovers in
`toolbar.tsx`, `comments.tsx`, `find-bar.tsx`, `format-rail.tsx`,
`stats-panel.tsx`; cards/rows in `library.tsx`, `files-view.tsx`,
`shared-view.tsx`) already matches the scale.
