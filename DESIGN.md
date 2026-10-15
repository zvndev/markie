# Design

## Source of truth

- Status: Active for document capabilities inside the existing Markie app.
- Last refreshed: 2026-10-15.
- Primary product surfaces: native Windows and macOS desktop workspaces, original Word editor, existing Markdown workspace, protected local vault. Web is a new, secondary surface sharing the same document core.
- Evidence reviewed: src/app/globals.css, src/lib/theme.ts, src/components/toolbar.tsx, library.tsx, doc-toolbar.tsx, docs/design/radius-scale.md and docs/superpowers/plans/2026-10-14-document-platform.md.

## Brand

Calm, capable, local-first writing software. Trust comes from legible controls, visible save/lock state and honest compatibility, not marketing claims. Avoid a new visual brand, a giant Office ribbon, decorative dashboard cards or security theater.

## Product goals

Keep written material together, searchable and sortable, with direct access to writing, document formatting, export, sharing and protected storage. Preserve existing Markdown behavior. Accounts remain optional for local work. Success means users can create/import, edit, recover/reopen and export without unexplained data loss. Do not imply all Word features, pixel-identical pagination, biometrics or encryption of ordinary files unless those capabilities exist.

Desktop delivery leads: produce and validate actual app bundles/executables with bundled assets, native file dialogs and menu/lifecycle behavior before calling the feature delivered. A localhost browser or Electron development command is not a packaged desktop deliverable. macOS Documents reserves a native drag region and traffic-light clearance; Windows retains its standard system frame.

## Personas and jobs

Writers, researchers and people managing working copy across formats. Jobs: find a draft, write/edit, produce a Word file, organize related material, share intentionally and protect sensitive work. Browser users need a complete editor without unrestricted filesystem permissions; desktop users retain deeper local integration.

## Information architecture

Preserve Markie's existing Toolbar, activity bar, resizable Library with Recent/Projects, Browse, Cloud, Skills, settings, themes and account surfaces. Word and other formats are renderers for documents inside that shell, not separate destinations. There is no Return to Markie, Return to Markdown, Classic workspace or switch-back action. Select documents through the normal Library/Open flow; retain unsaved buffers, including untitled Markdown, as selectable documents there.

Keep one simplified Markie formatting toolbar. Reuse its actual controls for overlapping functions across renderers, with format-aware behavior and honest capability limits. Do not copy Microsoft Word's Home/Insert/Layout/Review/View tab strip or ribbon. Advanced Format, Insert, Layout, Review and View actions belong in native macOS/Windows application menus; parameterized actions may open focused dialogs. Browser fallback uses Markie's existing command palette, not a new ribbon. Vault content stays explicitly scoped and excluded from ordinary search.

## Design principles

1. Files and editing lead; chrome stays compact.
2. Every enabled tool performs a real operation; unsupported features explain their limit.
3. Recovery in this browser, saved to a file and download started are different states.
4. A locked vault exposes no titles/snippets from protected documents.
5. New controls use existing tokens and component patterns. Safety must be visible without turning every screen into a warning.

## Visual language

Reuse Markie's semantic background, surface, surface-2, foreground, muted, border, accent and status tokens and its system desktop typography. Both dark and light modes must work. Keep the documented 6px inline/control, 8px popover and 12px dialog radius scale. Use quiet borders and background steps for hierarchy, not saturated panels. No external fonts/assets or decorative motion are required. Respect reduced motion.

## Components

Reuse the existing Toolbar, ActivityBar, Library, buttons, menus, source/rich editor behavior, notices and keyboard vocabulary. Format-aware editor content, Word tools/canvas and the isolated vault panel fit into those existing controls. Do not render a replacement app shell, second titlebar, standalone welcome dashboard or new brand. Keep format/storage logic outside rendering and give one active editor ownership of file commands; combine all retained sessions' recovery before a native close.

## Accessibility

Target keyboard-complete operation and WCAG AA text readability without silently overriding existing owner-approved theme boundaries. Give every control a meaningful label, disclose selected tabs/filters, use proper headings/regions and live status/error messages, keep focus visible and manage focus when dialogs close. Do not use color as the only save/lock/permission signal. Do not require hover for an essential action.

## Responsive behavior

At desktop widths, keep list and editor visible. At narrow widths, allow a document/list switch or collapse the library; do not compress the editor into a narrow strip. Tool groups may wrap or scroll with clear reachability. No horizontal page overflow at 390px. Touch controls must remain usable, and keyboard shortcuts are enhancements rather than the only entry point.

## Interaction states

- Loading: name the operation and retain existing content until replacement succeeds.
- Empty: offer create/import, not placeholder documents that look saved.
- Error: retain edits, state what failed and provide a safe retry/export path.
- Success: say where data actually landed and which revision was saved.
- Disabled: use real capability/authorization state and a short reason.
- Offline: local editing/recovery continue where storage is available; do not queue invisible uploads or claim a durable backup.

## Content voice

Short, direct and truthful. Use document, folder/collection, vault, save, export and recovery consistently. No em dashes in new UI copy. Do not call a download a saved original or a passphrase screen biometric protection.

## Implementation constraints

React 19, TypeScript, Vite and Tailwind with existing tokens. No third-party Office engine or new dependencies. Original format code follows the provenance decision. Do not use a new design-system layer or native HTML select for new web filters; use the existing project pattern or labeled buttons. Parse/encode work is bounded and lazy-loaded. Validate real desktop/mobile browser flows, storage failures, readonly formats and lock state; a build alone is not UX proof.

## Open questions

- Native biometric key protection and browser PRF availability are later platform-specific capabilities; do not display enabled biometric controls before they work.
- Exact Word pagination fidelity remains a measured compatibility target, not a cosmetic claim.
