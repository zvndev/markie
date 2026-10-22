# Design

## Source of truth

- Status: Active for document capabilities inside the existing Markie app.
- Last refreshed: 2026-10-18.
- Primary product surfaces: native Windows and macOS desktop workspaces, original Word editor, existing Markdown workspace, protected local vault. Web is a new, secondary surface sharing the same document core.
- Evidence reviewed: src/app/globals.css, src/lib/theme.ts, src/components/toolbar.tsx, library.tsx, doc-toolbar.tsx, docs/design/radius-scale.md and docs/superpowers/plans/2026-10-14-document-platform.md.

## Brand

Calm, capable, local-first writing software. Trust comes from legible controls, visible save/lock state and honest compatibility, not marketing claims. Avoid a new visual brand, a giant Office ribbon, decorative dashboard cards or security theater.

## Product goals

Keep written material together, searchable and sortable, with direct access to writing, document formatting, export, sharing and protected storage. Preserve existing Markdown behavior. Accounts remain optional for local work. Success means users can create/import, edit, recover/reopen and export without unexplained data loss. Do not imply all Word features, pixel-identical pagination, biometrics or encryption of ordinary files unless those capabilities exist.

The Word-like product target is the complete everyday writing workflow in [the October 18 product contract](docs/superpowers/specs/2026-10-18-word-processor-product.md), not a limited importer or collection of codec milestones. Simplification means compact presentation, not missing ordinary editing, document structure, review or layout. Partial implementation batches never close that full product requirement.

Desktop delivery leads: produce and validate actual app bundles/executables with bundled assets, native file dialogs and menu/lifecycle behavior before calling the feature delivered. A localhost browser or Electron development command is not a packaged desktop deliverable. macOS Documents reserves a native drag region and traffic-light clearance; Windows retains its standard system frame.

## Personas and jobs

Writers, researchers and people managing working copy across formats. Jobs: find a draft, write/edit, produce a Word file, organize related material, share intentionally and protect sensitive work. Browser users need a complete editor without unrestricted filesystem permissions; desktop users retain deeper local integration.

## Information architecture

Preserve Markie's existing Toolbar, activity bar, resizable Library with Recent/Projects, Browse, Cloud, Skills, settings, themes and account surfaces. Word and other formats are renderers for documents inside that shell, not separate destinations. There is no Return to Markie, Return to Markdown, Classic workspace or switch-back action. Select documents through the normal Library/Open flow; retain unsaved buffers, including untitled Markdown, as selectable documents there.

Keep one simplified Markie formatting toolbar. Reuse its actual controls for overlapping functions across renderers, with format-aware behavior and honest capability limits. Do not copy Microsoft Word's Home/Insert/Layout/Review/View tab strip or ribbon. Advanced Format, Insert, Layout, Review and View actions belong in native macOS/Windows application menus; parameterized actions may open focused dialogs. Browser fallback uses Markie's existing command palette, not a new ribbon. Vault content stays explicitly scoped and excluded from ordinary search.

Markdown's Rich Text, Markdown Source and Split choices belong in the native View menu, not a mode toggle in the top toolbar. Preserve Cmd/Ctrl+1/2/3 and the existing command-palette alternatives, including browser access, with the same large-file and literal-text safety checks.

The existing Library and Cloud use the same compact search/type/sort vocabulary. Keep native files, ordinary recovery copies and cloud snapshots visibly distinct; never invent file paths or silently merge unrelated copies by name. Search only fields a source actually provides: native names/paths, bounded extracted recovery text/tags/collections, and cloud metadata until explicitly opened. Filters must not scan or download bodies in the background. Preserve default ordering unless a user explicitly selects another sort, with a clear reset and honest empty/error state.

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

Word style controls use imported style labels and supported effective properties, without rewriting direct formatting when choosing a named paragraph style. Mixed or unresolved formatting must be identified honestly, not replaced with guessed values. Rendering inherited styles and changing viewing preferences must not bake those values into saved run formatting. Cloud rows require the exact confirmed account/server identity; a successful save requires acknowledgment of the exact document, version and submitted content before clearing dirty state.

Document theme colors and supported default Latin theme fonts are resolved inside the original codec, not by a second renderer/theme system. They style the document, not Markie's chrome. Preserve raw theme/settings/style bytes; unsupported font slots/scripts/languages stay unresolved. Stored system-color fallbacks and deterministic tint/shade rounding must not be presented as full source-Word or operating-system fidelity.

Word print/PDF is a supported-view projection from the original document model, not a screenshot of the editor or a Word-compatible pagination claim. Reuse the actual Export menu and native File commands. Keep printed paper light and preserve document typography independently of the app theme. Disclose excluded comments and font/printer limitations; unsupported packages, pending revisions and unrepresentable structures must not be silently flattened. Printing never acknowledges an external file save or clears unsaved edits, and protected/private or composing sessions cannot leak into output.

Do not put a permanent generic Print/PDF disclaimer above every document, especially a new blank file. Keep routine output information in the existing Export context and document details. If the actual document contains review comments that output would omit, ask at the output action before proceeding; cancellation must be source-neutral. Real document-specific protection and unsupported-feature reasons remain accessible and enforced. Normal desktop formatting groups should use measured available space/capability-aware fit, rather than hiding most actions below a wide fixed breakpoint; narrow layouts overflow the actual shared controls with keyboard/focus continuity.

RTF and ODT reuse the same rich-text canvas, Page Setup dialog, native Layout/View commands and Print/PDF projection through private format-aware adapters. Each codec owns its source, immutable snapshots and original-format writer; neither impersonates a DOCX package. Local recovery records retain the original format and bytes. Supported static page geometry must round-trip in the source format, and output never marks the document saved. Unsupported commands are withheld at every entry point, and unsupported semantics must not be flattened into editable content. This does not imply cloud upload, vault integration, tables, media or Word-only review support for these formats. Show compatibility warnings only for a real document-specific limit, not a blanket claim that an editable format cannot be edited.

Darkmown is a distinct interactive document type, not a Markdown conversion. Its first local milestone reuses Markie's actual source toolbar and native View commands for source/preview/split, with explicit trust for the exact active source. Source changes or blocked/inactive sessions dispose the running opaque frame. The pinned first-party compiler runs off-thread with bounded input/output and a disposable execution budget. Only reviewed offline state/buttons/inputs/calculations/local forms are admitted by the sanitizer; authored scripts, resource URLs, network, navigation, persistence and host access remain unavailable. Runtime state is temporary and never written into authored defaults. A fixed, one-way theme projection sends only a literal light/dark choice to the exact frame; the frame has no host capability bridge, replies or state/secrets channel. Untrusted previews remain scriptless. Media, document-defined host-toolbar controls, portable styles/assets, scoped API connectors and personal/shared state remain later milestones, not implied by trusting this local preview.

## Accessibility

Target keyboard-complete operation and WCAG AA text readability without silently overriding existing owner-approved theme boundaries. Give every control a meaningful label, disclose selected tabs/filters, use proper headings/regions and live status/error messages, keep focus visible and manage focus when dialogs close. Do not use color as the only save/lock/permission signal. Do not require hover for an essential action.

## Responsive behavior

At desktop widths, keep list and editor visible. At narrow widths, allow a document/list switch or collapse the library; do not compress the editor into a narrow strip. Tool groups may wrap or scroll with clear reachability. No horizontal page overflow at 390px. Touch controls must remain usable, and keyboard shortcuts are enhancements rather than the only entry point.

## Interaction states

Linked sign-ins live in the existing Account settings section. Email changes require primary-email confirmation followed by new-address verification; explicit Google linking appears only when the server advertises it. Linking preserves the primary UID and never implies account merge or permission transfer. Cloud areas are labeled organization within that same account, not accounts or ACL boundaries. The Cloud list shares one area filter across legacy files and document snapshots; upload actions visibly retain Default cloud or an explicitly chosen verified destination, and existing placements move only through an explicit move action. Account/server/bearer changes clear scoped identity and area metadata without discarding editor buffers.

Document media opens as a temporary viewer, not an edit: clicking the backdrop or pressing Escape closes it, controls inside remain usable, focus returns to the source, and closing/switching documents stops playback and removes embedded frames. Render overlays outside transformed/clipped editor containers. Preserve native inline video controls and offer an explicit expand action.

Ordinary HTTP(S) links use the device's default browser, never another Markie web window. Explicit video play controls may use the isolated media viewer. Hover/focus link cards are metadata only, after deliberate intent, with a visible destination hostname, no eager requests, no account cookies/tokens, no page execution and a working off switch. Main owns bounded, per-hop public-network validation and transport; private, credential-bearing or unsafe destinations must not become preview fetches. Keep local document/file-link authorization separate from web links.

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
