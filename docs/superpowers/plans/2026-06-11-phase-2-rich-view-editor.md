# Phase 2: Rich View Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the View mode an editable rich-text surface (Typora-style): everything markdown can express is editable in place, with a Photoshop-style left toolbar — common tools always visible, advanced tools behind a disclosure toggle. The .md file stays the source of truth.

**Architecture:** TipTap (ProseMirror) renders an editable document in View and Split modes, bridged to the markdown string via the tiptap markdown extension. The markdown string in React state remains canonical: rich edits serialize back (debounced); raw edits in CodeMirror re-parse into the rich view (echo-guarded by a last-emitted ref). PDF/HTML export stops scraping the preview DOM and instead renders markdown→HTML through a pure unified pipeline (same plugins the old preview used), which is also unit-testable.

**Tech Stack:** @tiptap/react + starter-kit + table/task/link/image extensions, tiptap markdown bridge, unified/remark-parse/remark-rehype/rehype-stringify (+ existing remark-gfm, remark-math, rehype-highlight, rehype-katex).

**Parent roadmap:** `docs/superpowers/plans/2026-06-11-markie-roadmap.md`

**Scope notes (v1 tradeoffs, deliberate):**
- Math and footnotes insert raw markdown syntax at the cursor (rendered beautifully in export and CodeMirror; shown as literal text in the rich view). Full WYSIWYG math is a later enhancement.
- Code blocks in the rich view are plain monospace (no syntax highlight); highlighting still applies in Edit mode and all exports.
- Round-trip drift (list markers, emphasis style) is acceptable; the bridge is configured to GFM-friendly defaults.

---

### Task 1: Pure markdown→HTML pipeline for exports

PDF/HTML export currently reads `previewRef.current.innerHTML` (`src/app/page.tsx`), which dies when TipTap replaces that DOM. Replace with a pure function using the exact plugin chain the preview used.

**Files:**
- Create: `src/lib/markdown-html.ts`
- Create: `src/lib/markdown-html.test.ts`
- Modify: `src/app/page.tsx` (getPreviewHTML → renderMarkdownHTML)
- Modify: `package.json` (add unified, remark-parse, remark-rehype, rehype-stringify)

- [ ] Install: `npm i unified remark-parse remark-rehype rehype-stringify`
- [ ] Write failing tests covering: heading → `<h1>`, GFM table → `<table>`, fenced code → `hljs` classes, math → `katex` markup, task list → checkboxes.
- [ ] Implement:

```ts
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype)
  .use(rehypeHighlight)
  .use(rehypeKatex)
  .use(rehypeStringify);

export function renderMarkdownHTML(markdown: string): string {
  return String(processor.processSync(markdown));
}
```

- [ ] In `page.tsx`, replace `getPreviewHTML` internals: `return renderMarkdownHTML(content)` (keep the callback name so export handlers don't change; drop the `previewRef` fallback). The export HTML must still be wrapped by `buildPDFHTML`, which provides the `.markdown-body` shell — verify by reading `src/lib/pdf-styles.ts` during implementation and wrapping with `<article class="markdown-body">…</article>` if it doesn't already.
- [ ] `npm test` green, lint green, commit.

### Task 2: RichView component (TipTap + markdown bridge)

**Files:**
- Create: `src/components/rich-view.tsx`
- Modify: `package.json`

- [ ] Install TipTap react + starter-kit + extensions: link, image, table (+row/cell/header), task-list, task-item, placeholder, and the markdown bridge package. Pin whatever major version is current at install; the bridge must support `setContent(markdown)` + `getMarkdown()`.
- [ ] Component contract:

```tsx
interface RichViewProps {
  value: string;                    // canonical markdown
  onChange: (md: string) => void;   // debounced serialized rich edits
}
```

Internals:
- `lastEmitted` ref guards the echo loop: on editor update (debounce ~250ms), `md = getMarkdown(); lastEmitted.current = md; onChange(md)`. On `value` prop change, if `value !== lastEmitted.current`, re-`setContent(value)` preserving cursor where possible.
- Styling: render inside `<article class="markdown-body max-w-3xl mx-auto">` so the existing globals.css preview styles apply unchanged. ProseMirror-specific overrides (caret color, selection, focus outline none, table cell min-width) go in globals.css under `.markdown-body .ProseMirror`.
- Empty state: placeholder extension ("Start typing or open a file") replaces the old static empty screen.

- [ ] Verify in dev: typing, headings via `#` autoformat, bold/italic input rules, tables render and are editable. Commit.

### Task 3: Wire RichView into View/Split + sync with CodeMirror

**Files:**
- Modify: `src/app/page.tsx`

- [ ] Replace `<Preview>` with `<RichView value={content} onChange={setContent} />` in both View and Split panes. `previewRef` is deleted (Task 1 freed it). The `Preview` component stays in the tree only if still imported elsewhere — otherwise delete `src/components/preview.tsx`.
- [ ] Split-mode loop check: type in CodeMirror → RichView updates (parse); type in RichView → CodeMirror updates (serialize) — no feedback loop (the `lastEmitted` guard plus CodeMirror's controlled `value` handle this; CodeMirror side needs no change).
- [ ] Dirty tracking, save, stats, and exports all read `content` — unchanged by design. Verify save round-trip via CDP (type in RichView → Cmd+S → file on disk contains serialized markdown).
- [ ] Commit.

### Task 4: FormatRail — left vertical toolbar with progressive disclosure

**Files:**
- Create: `src/components/format-rail.tsx`
- Modify: `src/app/page.tsx` (render rail beside the rich pane, pass editor instance)
- Modify: `src/components/rich-view.tsx` (expose editor via `onEditorReady` callback)

- [ ] Rail layout: fixed-width (~44px) left column, icon buttons (lucide-style inline SVGs, matching toolbar.tsx aesthetic), tooltips with shortcuts, active state = accent background (same classes as mode switcher).
- [ ] **Common set (always visible):** H1 H2 H3 · bold · italic · strikethrough · inline code · link · bullet list · ordered list · task list · blockquote · code block · table (insert 3×3) · horizontal rule · image (URL prompt).
- [ ] **Advanced (disclosure toggle "⋯" at rail bottom, expands below):** table ops (add/delete row, add/delete col, delete table — enabled only when selection is in a table) · inline math `$…$` · block math `$$…$$` (insert raw syntax at cursor) · footnote (insert `[^1]` + definition stub at doc end) · clear formatting.
- [ ] Every command dispatches through the TipTap editor (`editor.chain().focus().toggleBold().run()` etc.); raw-syntax inserts use `insertContent`.
- [ ] Rail renders only in View/Split modes. Keyboard reachability: rail buttons are tabbable; no shortcut changes in this phase (Phase 3 owns the command palette).
- [ ] Parity check against the spec ("anything markdown can do"): headings ✓ emphasis ✓ code ✓ links ✓ images ✓ all lists ✓ quote ✓ table ✓ hr ✓ math/footnotes (raw insert) ✓.
- [ ] Commit.

### Task 5: Verification pass

- [ ] `npm test && npm run lint && npm run electron:pack`.
- [ ] Packaged-app CDP drive: cold-start a file → type in View (no mode switch!) → dirty dot → Cmd+S → disk content is valid markdown containing the edit.
- [ ] Bold a word via rail (CDP click) → saved file contains `**word**`.
- [ ] Export PDF (dark) and HTML still produce styled output (manual or CDP-evaluate `renderMarkdownHTML` smoke).
- [ ] Typing feel: in a packaged app with a ~3k-line doc, typing in View must not lag visibly (debounced serialization keeps keystrokes off the markdown path).
- [ ] Mark Phase 2 complete in the roadmap, commit, merge to main, push.
