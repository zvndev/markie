# Markie document platform and web support

Product direction agreed with Kirby on October 14, 2026. This is the requested durable product plan; implementation evidence and task ownership live in Circular, not in a second local task tracker.

## Product outcome

Priority update from Kirby, October 15, 2026: Windows and macOS desktop apps are the primary surface for these features. Web support is new and secondary. Acceptance must include actual launchable desktop artifacts and packaged native workflows; a browser preview or development-only Electron launch is not delivery of the desktop product. Preserve shared document logic, but schedule native file/menu/window/recovery/security and desktop packaging verification ahead of further web expansion.

Product continuity correction from Kirby, October 15, 2026: extend the existing real Markie application. Preserve its shell, navigation, Library, editor conventions, settings and identity. New original document engines plug into that app; they do not authorize a new standalone Documents application, branded dashboard or replacement interface. Word mode belongs in the current editor area. Isolated preview identities protect installed data only and are not a new product direction. Keep Markdown editing state when switching formats and have one active owner for commands plus combined recovery on close.

Interaction correction from Kirby, October 15, 2026: formats are renderers inside Markie, not workspaces to enter and leave. Select documents through the existing Library/Open flow, including the retained named or untitled Markdown document, without reloading the shell. Reuse the actual compact formatting controls across renderers. Do not add a Word ribbon/tab strip, a duplicate toolbar or a switch-back action. Format, Insert, Layout and Review are native top-level system menus on macOS/Windows; existing File/Edit/View remain. Browser fallback uses the existing command palette. These constraints supersede the earlier tab-based Word UI proposal throughout this plan.

One local-first workspace for text, documents, and written copy: open, write, organize, search, sort, share, and collaborate on the same material on desktop and web. Desktop provides deeper filesystem integration; web is a first-class editor, not a read-only companion. Accounts and cloud storage remain optional for local editing. A protected vault encrypts sensitive content and metadata at rest and exposes it only during an authorized unlocked session.

Kirby explicitly selected Markie's existing Electron desktop experience, approved a from-scratch DOC/DOCX engine rather than a third-party document engine, requested ordinary text-file support, and requested a passcode/biometric protected area. The October 14 instruction authorizes this product expansion. Existing VISION.md and CONSTITUTION.md are human-maintained and are not silently rewritten. Markdown remains canonical for Markdown files; Office packages remain canonical for Office files. A later human-owned reconciliation of the older Markdown-only vision is required before a public product/release change.

## Existing implementation and integration points

- The React/Vite renderer shares the existing Markie shell across Electron and browser builds. Offline shell caching exists; Safari/Firefox and platform-specific browser acceptance still require independent validation: vite.config.ts, src/lib/offline-app.ts.
- RichView accepts canonical Markdown and rich updates serialize back into it. Retain that editor and buffer while another format is selected; represent the retained named or untitled document in the normal Library: src/components/rich-view.tsx, src/app/page.tsx, src/components/library.tsx.
- Desktop Open offers supported formats through the normal file dialog. Opaque byte leases handle Office and encoding-sensitive text without broadening the classic UTF-8 grant path. Browser document adapters use permission-granted handles or explicit downloads: electron/document-files.cjs, src/lib/native-document-files.ts, src/lib/web-files.ts.
- Markdown and Word reuse the same compact formatting component through format-specific adapters. Selection styling, document properties and viewing preferences remain distinct; shared controls do not imply identical format semantics: src/components/formatting-toolbar.tsx, src/components/doc-toolbar.tsx, src/components/documents/word-toolbar.tsx.
- The native menu command catalog is capability-based and shared with the existing browser command palette. Disabled, read-only, modal and private states must be enforced again at execution, not only reflected in menu appearance: electron/document-menu-commands.json, electron/document-menu.js, src/lib/document-commands.ts, src/app/page.tsx.
- Markdown page width is a reading-column setting, and its existing PDF styling is not an Office pagination engine. Word automatic pagination and print/PDF remain separate work: src/lib/doc-appearance.ts, src/lib/pdf-styles.ts.
- Existing Markdown multiplayer/comments remain on their Yjs path. Local Word comments and supported text revisions use the original package-aware document model; neither implies live Office co-editing.
- Desktop text registry/history contracts remain distinct from byte-oriented document sessions and IndexedDB recovery. Reuse authorization, atomic replacement and conflict handling without putting Office packages into text payloads: src/lib/electron.ts, electron/main.js, src/lib/document-library/.
- Existing server docs.content, Markdown sync, MCP and device index contracts remain text-oriented. The additive document-platform service uses versioned byte snapshots and requires a separate server deployment; it is not silently substituted into those contracts: server/src/docs.ts, server/src/document-platform.ts, electron/sync.js, electron/mdindex.js, mcp/markie-mcp.mjs.

## Architecture

Keep shared document logic with explicit format capabilities and separate platform implementations inside Markie's existing shell. The active format selects a renderer, not another app destination. Avoid a universal Markdown buffer or replacement navigation, and retain the original Markdown editor and unsaved state across selections.

```text
Existing Markie shell, Library, shared compact controls and document actions
  Markdown -> existing Markdown editor/codec
  Plain text -> source text without Markdown normalization
  CSV -> current table adapter with CSV preservation
  DOCX -> original OOXML package model, editor and writer
  DOC -> original CFB/MS-DOC reader, then explicit conversion/editing support
  RTF/HTML/ODT -> explicit text-only imports; richer codecs are future work

Desktop host: authorized filesystem, native menus, binary recovery, local index
Web host: browser pickers/downloads, browser recovery, offline app cache
Optional cloud: versioned documents/assets, ACLs, multiplayer and sharing
Protected vault: encrypted storage, unlocked-only local index and key lifecycle
```

Each document session owns format, identity, original source bytes, edit revision, saved revision, disk/remote fingerprint, diagnostics and allowed operations. Word sessions additionally own package parts, relationships, styles, numbering, media, layout, comment/revision ranges, and an original-byte snapshot. Rendering is derived from the model and must not become the authoritative save source.

Keep interfaces narrow: classify/open, inspect capabilities, apply supported edits, export a candidate, validate, save. Separate format support from platform support and from authorization. Do not use a document's filename extension alone as proof of its contents or editability.

## File format commitments

| Format | Initial foundation | Required product behavior |
| --- | --- | --- |
| .md/.markdown/.mdx | Existing behavior preserved | Markdown source/rich editing; no unexpected rewrites |
| .txt/.text/.log | Plain-text classification, decoding and saving | Preserve text, BOM/encoding policy and newlines; no Markdown serializer |
| .csv | Existing behavior preserved | Explicit table/text workflow without accidental conversion |
| .docx | Original bounded ZIP/OOXML opening and safe supported text edits | Rich document model, layout, review and package-preserving export |
| .doc | Original bounded CFB/Word97-2003 text reader | Honest import capability, original retained; richer interpretation follows |
| .rtf/.html/.odt | Explicit text-only import copies with loss warnings | Richer codecs implemented separately; originals retained and active content never executed |
| Unknown/binary | Reject or attach read-only | Never reinterpret arbitrary binary bytes as editable text |

Legacy .doc is not OOXML. Text extraction is not a complete DOC editor. Native DOC saving is a separate milestone; conversion to a new DOCX is explicit and never overwrites the original DOC. Reject encrypted/protected/macro-enabled variants until their behavior and security model are implemented.

## Original engine provenance

Implement from public ECMA-376 / OPC, Microsoft MS-DOC and MS-CFB format specifications, standard platform APIs, and fixtures authored by this team. Do not copy, translate, install, inspect or derive implementation from another document engine's source, minified artifacts, proprietary packages, demos or code-derived summaries. Existing generic ZIP/XML/crypto platform primitives are permitted; document engines and converters are not dependencies. No new dependencies in the initial milestone.

Implementers must cite the relevant public specification in code/tests where non-obvious binary rules are encoded. Preserve fixture provenance and avoid committing private user documents. Do not claim this process is a legal certification, universal patent clearance or proof of arbitrary Word fidelity.

## Document editing experience

Use one compact Markie formatting toolbar, reusing the actual controls for overlapping Markdown and Word actions. Format-aware adapters determine which actions work, what they change and whether they are enabled. Do not reproduce Word's tab strip or ribbon. On desktop, advanced operations use native Format, Insert, Layout and Review system menus alongside the existing File/Edit/View menus. Browser users find supported operations in the existing command palette. Parameterized actions may open focused dialogs.

Library/Open remains the document-selection model. A retained Markdown file, including an unnamed `Untitled.md` buffer, stays selectable there while a Word or text renderer is active. Selecting another document must not reload the shell, replace its navigation or discard unsaved work. Private and modal scopes must settle safely before selection changes.

The following is the full target scope, not a claim that every item is implemented in the preview:

| Area | Product scope |
| --- | --- |
| Shared controls and Format | Character styling, named paragraph/character styles, lists/numbering, alignment, indents, spacing, search/replace |
| Insert | Tables with widths/merged cells, inline pictures, links, page breaks, supported fields, headers/footers and page numbers |
| Layout | Letter/A4, units, margins, orientation, paragraph rules, explicit sections and pagination |
| Review | Portable local comments/replies, authors, resolved state, then true revisions and accept/reject |
| View | Paged/continuous layout, zoom independent of document font, outline, ruler and comments visibility |

Comments, undo history, durable versions and Track Changes are distinct. An unsupported existing revision must not be silently accepted or deleted. Missing fonts and unsupported layout must be disclosed. Do not imply that page-shaped backgrounds provide Word-equivalent layout.

## Full web support

1. Extract actual desktop-only operations from shared document logic. Use separate desktop/web host implementations rather than null Electron checks scattered throughout UI.
2. Complete browser open, drag/drop, Save and Save As for text and binary packages. Use permission-granted file handles where supported, explicit downloads elsewhere. Display whether an action saved the original, downloaded a copy, or only stored a recovery draft. A download is not evidence of a durable write to the original file.
3. Use browser-local durable storage for drafts and document blobs with quota/permission/eviction handling. Never present browser storage as a guaranteed backup. Handle private browsing, revoked file permission and cleared site data without a false saved indicator.
4. Package an offline-capable app shell, engine code, fonts and workers. Version caches carefully; no runtime CDN dependency for basic local editing. Handle updates without mixing incompatible document/editor versions or reloading dirty work.
5. Serve via HTTPS with CSP and correct worker policies. Audit web authentication, cookies/tokens, CORS, logout and cross-account data isolation independently of the desktop deep-link flow. Keep local editing account-free.
6. Keep reading/editing/layout/comments capabilities shared. Browser filesystem scanning, native terminal, automatic disk watching and local agent/MCP installation remain desktop-specific. Do not advertise unrestricted machine access from web.
7. Legacy DOC parsing must run locally in a worker with limits. No automatic document upload or hidden server converter.
8. Validate Safari, Firefox and Chromium, including IME, keyboard selection, clipboard, accessibility, mobile/touch behavior, print and local-file permission changes. Desktop-only Chromium compatibility is insufficient.

Web acceptance: open/edit/export supported Markdown/TXT/DOCX without an account; supported operations work offline after caching; zero document uploads without explicit user action; reload restores recovery state; permission denial/storage exhaustion/export failure cannot report successful durable saving; non-Chromium download fallback remains usable.

Web uses the same Markie shell and existing command palette. It does not copy the desktop menu bar into the renderer or introduce a different document application. Web completion follows desktop integration and packaged native verification, rather than displacing them.

## Search and organization

Use stable document identities with display name, format, origin, folder/collection, tags, modified time and sync/access state. Offer search over title/body/comments where authorized, sort by name/modified/created/type, and clear scopes for local/cloud/shared/vault results. Preserve existing project organization rather than imposing a second taxonomy.

October 17 continuation: the existing Library/Cloud now share compact type/name/recent sorting and source-aware queries. Native filenames/paths, extracted ordinary-recovery text/tags/collections and cloud metadata are distinct sources; no fake records or filename-only identity merging. Cloud snapshots can be listed/opened through existing services without a seed local file; this is versioned-copy access, not live Office multiplayer or background sync. The device-wide index remains Markdown-focused until safe bounded binary extraction, authorization and privacy/performance checks are implemented. Do not treat sidebar filtering as evidence of completed all-files body search.

Text extraction is a codec capability. DOCX content is indexed from document semantics, not raw XML. Locked vault items contribute no plaintext content or sensitive titles/snippets to the ordinary index, logs, OS search, recent-files lists or thumbnails. Initially build an in-memory vault index only after unlock, clearing it on lock. Server-side search cannot inspect end-to-end-encrypted vault content; do not pretend it can.

## Multiplayer and sharing

Keep cloud optional. Design a versioned Office-capable document and asset transport before enabling sync; existing Markdown content TEXT routes remain unchanged. Stable block/run/range identities must support collaboration, local editing, comments, revisions and export without diverging models. Define undo ownership, offline reconnection, conflicts, revocation and server-authorized viewer/commenter/editor roles. A hidden button is not access control.

Sharing must distinguish live editable collaboration, invited read/comment access, expiring/revocable links and exported copies. Vault sharing is a separate key-distribution flow with explicit confirmation; do not automatically publish a decrypted vault item through an existing public-link endpoint. Revocation prevents future authorized access but cannot recall plaintext or exported copies already received. E2EE collaboration requires client key distribution/rotation and encrypted history/assets; do not claim E2EE from TLS or at-rest encryption alone.

## Protected vault

Use standard authenticated encryption, random vault/document keys, passphrase-based key wrapping, fresh nonces and authenticated envelope version/context. Encrypt sensitive metadata, assets, comments, history, drafts and recovery copies as well as document bodies. Store no plaintext passcodes or derived unlock secrets in ordinary app storage.

Start with a high-entropy passphrase. A short numeric PIN alone is inadequate against offline guesses of a copied vault. Native biometrics must gate access to an OS-protected wrapping key, not return a boolean that releases a plaintext key stored nearby. Web passkeys/biometrics require a supported key-protection mechanism such as WebAuthn PRF, feature detection, user verification and fallback/recovery design; a login assertion is not automatically an encryption key.

Lock on explicit request and supported inactivity/system-lock events. Lock must cancel pending operations and dispose of decrypted sessions, in-memory indices, previews and object URLs. JavaScript memory cannot promise forensic zeroization, and a compromised unlocked client/XSS remains outside the protection of at-rest encryption. Threat model clipboard, print/export, screen capture, temporary files, crash dumps, telemetry, OS indexing and multiplayer before offering a vault UI. Never move or delete a user's original plaintext source automatically.

The experimental passphrase vault now has encrypted local storage/recovery and lifecycle integration; this is not a production security certification or biometric unlock. OS-protected keys, native biometric integration and independent security/leak acceptance remain further gates. Forgotten-secret recovery is an explicit product choice, not an implicit server backdoor. Do not put irreplaceable sensitive originals into the preview.

## Delivery sequence and verification

1. Preserve the current baseline and create the original engine provenance contract. Write regression and adversarial tests alongside new modules. No dependency, server schema, production-data or release changes in this foundation.
2. Build four isolated foundations in parallel: DOCX package editing, CFB/DOC text import, format/browser file utilities, and vault cryptographic primitives/threat model. Keep shared-file integration leader-owned.
3. Restrict the development engine workbench to generated/test fixtures, never the primary product route. Opening or previewing does not grant permission to overwrite an original. Show unsupported features and explicit copy exports; a workbench is not evidence of completed Word UI support.
4. Integrate format renderers into the existing Markie shell, shared compact controls and Library/Open selection flow, retaining named and untitled Markdown buffers. Route desktop advanced actions through native system menus and browser actions through the existing command palette. Add binary-aware desktop sessions/history/recovery only after package and conflict tests pass. Build and exercise isolated packaged macOS/Windows previews throughout integration, before further web expansion.
5. Grow the rich model/editor: paragraph/run styling, named styles/numbering, tables/media, page properties, headers/footers, page numbering, comments and revisions. Every enabled control or command needs import/edit/export support, not only an icon or menu label.
6. Implement shared layout/pagination and print/PDF, using font-aware measurements and worker/time budgets. Test tall/merged tables, missing fonts, explicit breaks and section boundaries.
7. Complete web offline storage/cache/auth and cross-browser acceptance. Add format-aware local search/sorting. Keep vault plaintext out of all global indexing paths.
8. Integrate encrypted vault storage and trusted unlock adapters; run independent security/leak review before user data enters it.
9. Add versioned Office multiplayer/sharing and encrypted-vault collaboration as separate security contracts. Preserve existing Markdown APIs and role enforcement.
10. Package and release only through Markie's human-gated release process after end-to-end review. No deployment or publication is authorized by this plan alone.

Engine acceptance: unchanged open/export returns original bytes; supported text edits survive export/reopen; unsupported/unsafe edits fail closed; package relationships/content types remain valid; Microsoft Word opens corpus outputs without repair; unknown parts remain preserved where safe; repeated round trips do not compound unexplained loss. Structural/XML validation is necessary but does not prove Word fidelity.

Security/robustness acceptance: reject malicious paths, duplicate package parts, inconsistent ZIP metadata, encrypted entries, decompression bombs, XML entities/DTDs, malformed relationships and cyclic CFB chains; enforce compressed/expanded/entry/XML/time budgets. No external resource fetching or active content execution during document opening.

Save acceptance: flush immediate keystrokes, capture immutable revision N, validate candidate, recheck source fingerprint, make recoverable checkpoint, atomically replace, acknowledge only N. A concurrent N+1 remains dirty. Test disk full, aborted export, crash before rename, revoked permission, external edit, browser eviction and stale async unlock/save results.

Regression gates: targeted tests first, then npm test, npm run typecheck, npm run lint, npm run build, MCP/server tests where contracts change, and real browser/desktop workflows when wired. Desktop UI acceptance must prove one retained shell, shared compact controls, native context-aware menus, Library/Open selection of named and untitled Markdown without reload, and preservation of edits and lock state. No broad compatibility claim until independent Word-generated fixtures and real Word reopening have been tested.

## Risks and decisions kept explicit

- Original DOC/DOCX interpretation is a long-lived engineering investment. Basic UI does not make compatibility simple. Scope support feature-by-feature and report failures instead of destructive approximation.
- Browser and Electron use the same engine logic, not identical host capabilities. Do not reduce web to a viewer or imply full native file privileges.
- Local encryption does not solve client compromise, key recovery, encrypted search or multiplayer key distribution by itself.
- Human-owned checkpoints remain for production schemas/public APIs, visible product redesign, dependencies, biometric/keychain configuration and release. Local implementations or preview artifacts do not authorize deployment, publication or a new product identity.
- No third-party document-engine adoption. Do not revive the earlier SDK recommendation without a new user decision.

## Primary specifications

- [ECMA-376 Office Open XML](https://ecma-international.org/publications-and-standards/standards/ecma-376/)
- [Microsoft Word binary format](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/ccd7b486-7881-484c-a137-51170af7cc22)
- [MS-DOC retrieving text](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/01d5d8c4-cf9c-4ef9-80fd-439e763cfe01)
- [Microsoft Compound File Binary format](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb/53989ce4-7b05-4f8d-829b-d08d6148375b)
- [Browser file-saving capability](https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker)
- [Browser storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [Web Crypto authenticated encryption](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt)
