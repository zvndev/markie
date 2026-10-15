# Markie document platform and web support

Product direction agreed with Kirby on October 14, 2026. This is the requested durable product plan; implementation evidence and task ownership live in Circular, not in a second local task tracker.

## Product outcome

Priority update from Kirby, October 15, 2026: Windows and macOS desktop apps are the primary surface for these features. Web support is new and secondary. Acceptance must include actual launchable desktop artifacts and packaged native workflows; a browser preview or development-only Electron launch is not delivery of the desktop product. Preserve shared document logic, but schedule native file/menu/window/recovery/security and desktop packaging verification ahead of further web expansion.

One local-first workspace for text, documents, and written copy: open, write, organize, search, sort, share, and collaborate on the same material on desktop and web. Desktop provides deeper filesystem integration; web is a first-class editor, not a read-only companion. Accounts and cloud storage remain optional for local editing. A protected vault encrypts sensitive content and metadata at rest and exposes it only during an authorized unlocked session.

Kirby explicitly selected Markie's existing Electron desktop experience, approved a from-scratch DOC/DOCX engine rather than a third-party document engine, requested ordinary text-file support, and requested a passcode/biometric protected area. The October 14 instruction authorizes this product expansion. Existing VISION.md and CONSTITUTION.md are human-maintained and are not silently rewritten. Markdown remains canonical for Markdown files; Office packages remain canonical for Office files. A later human-owned reconciliation of the older Markdown-only vision is required before a public product/release change.

## Existing implementation and integration points

- The React/Vite renderer is shared-capable, but currently targets Electron's Chromium. Browser support needs its own build target and real Safari/Firefox validation: vite.config.ts.
- RichView accepts canonical Markdown, and rich updates serialize back into it: src/components/rich-view.tsx:46,376. Keep this path for Markdown only.
- Open has a browser file-input fallback: src/app/page.tsx:921. Save/Save As require Electron: src/app/page.tsx:978,1044. These need actual web implementations rather than silent returns.
- Font/size with selected text modifies document content; without selection it changes viewing preferences: src/components/doc-toolbar.tsx:192. Word document styles/default fonts must be distinct from zoom and reading preferences.
- Page width is a reading-column setting: src/lib/doc-appearance.ts. Current PDF styling hardcodes A4: src/lib/pdf-styles.ts:22. Neither is an Office pagination engine.
- Comments currently mount only with a live Yjs session: src/components/rich-view.tsx:686. Local portable Word comments need their own package-aware persistence and anchor mapping.
- Electron authorization, atomic replacement, conflict handling and recovery patterns are useful. Existing payloads, hashes and snapshots are text-only: src/lib/electron.ts, electron/main.js, electron/snapshots.js:143.
- Server docs.content is TEXT, and current sync/MCP/indexing contracts assume Markdown: server/src/docs.ts:23, electron/sync.js, electron/mdindex.js, mcp/markie-mcp.mjs. Do not stuff Office bytes into those text contracts or silently broaden tool permissions.

## Architecture

Keep a shared document/workspace layer with explicit format capabilities and separate platform implementations. Avoid a universal Markdown buffer and avoid replacing the entire existing editor at once.

```text
Shared workspace, organization, permissions and document actions
  Markdown -> existing Markdown editor/codec
  Plain text -> source text without Markdown normalization
  CSV -> current table adapter with CSV preservation
  DOCX -> original OOXML package model, editor and writer
  DOC -> original CFB/MS-DOC reader, then explicit conversion/editing support
  Future RTF/HTML/ODT -> explicit codecs, not renamed Markdown

Desktop host: authorized filesystem, binary recovery, local index, native unlock
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
| .rtf/.html/.odt | Recognize as unimplemented/import-only until codecs exist | Implement separately; HTML sanitized and active content never executed |
| Unknown/binary | Reject or attach read-only | Never reinterpret arbitrary binary bytes as editable text |

Legacy .doc is not OOXML. Text extraction is not a complete DOC editor. Native DOC saving is a separate milestone; conversion to a new DOCX is explicit and never overwrites the original DOC. Reject encrypted/protected/macro-enabled variants until their behavior and security model are implemented.

## Original engine provenance

Implement from public ECMA-376 / OPC, Microsoft MS-DOC and MS-CFB format specifications, standard platform APIs, and fixtures authored by this team. Do not copy, translate, install, inspect or derive implementation from another document engine's source, minified artifacts, proprietary packages, demos or code-derived summaries. Existing generic ZIP/XML/crypto platform primitives are permitted; document engines and converters are not dependencies. No new dependencies in the initial milestone.

Implementers must cite the relevant public specification in code/tests where non-obvious binary rules are encoded. Preserve fixture provenance and avoid committing private user documents. Do not claim this process is a legal certification, universal patent clearance or proof of arbitrary Word fidelity.

## Document editing experience

Keep a compact Home, Insert, Layout, Review and View toolbar for Word mode. Keep Markdown's established experience separate.

| Area | Product scope |
| --- | --- |
| Home | Character styling, named paragraph/character styles, lists/numbering, alignment, indents, spacing, search/replace |
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

## Search and organization

Use stable document identities with display name, format, origin, folder/collection, tags, modified time and sync/access state. Offer search over title/body/comments where authorized, sort by name/modified/created/type, and clear scopes for local/cloud/shared/vault results. Preserve existing project organization rather than imposing a second taxonomy.

Text extraction is a codec capability. DOCX content is indexed from document semantics, not raw XML. Locked vault items contribute no plaintext content or sensitive titles/snippets to the ordinary index, logs, OS search, recent-files lists or thumbnails. Initially build an in-memory vault index only after unlock, clearing it on lock. Server-side search cannot inspect end-to-end-encrypted vault content; do not pretend it can.

## Multiplayer and sharing

Keep cloud optional. Design a versioned Office-capable document and asset transport before enabling sync; existing Markdown content TEXT routes remain unchanged. Stable block/run/range identities must support collaboration, local editing, comments, revisions and export without diverging models. Define undo ownership, offline reconnection, conflicts, revocation and server-authorized viewer/commenter/editor roles. A hidden button is not access control.

Sharing must distinguish live editable collaboration, invited read/comment access, expiring/revocable links and exported copies. Vault sharing is a separate key-distribution flow with explicit confirmation; do not automatically publish a decrypted vault item through an existing public-link endpoint. Revocation prevents future authorized access but cannot recall plaintext or exported copies already received. E2EE collaboration requires client key distribution/rotation and encrypted history/assets; do not claim E2EE from TLS or at-rest encryption alone.

## Protected vault

Use standard authenticated encryption, random vault/document keys, passphrase-based key wrapping, fresh nonces and authenticated envelope version/context. Encrypt sensitive metadata, assets, comments, history, drafts and recovery copies as well as document bodies. Store no plaintext passcodes or derived unlock secrets in ordinary app storage.

Start with a high-entropy passphrase. A short numeric PIN alone is inadequate against offline guesses of a copied vault. Native biometrics must gate access to an OS-protected wrapping key, not return a boolean that releases a plaintext key stored nearby. Web passkeys/biometrics require a supported key-protection mechanism such as WebAuthn PRF, feature detection, user verification and fallback/recovery design; a login assertion is not automatically an encryption key.

Lock on explicit request and supported inactivity/system-lock events. Lock must cancel pending operations and dispose of decrypted sessions, in-memory indices, previews and object URLs. JavaScript memory cannot promise forensic zeroization, and a compromised unlocked client/XSS remains outside the protection of at-rest encryption. Threat model clipboard, print/export, screen capture, temporary files, crash dumps, telemetry, OS indexing and multiplayer before offering a vault UI. Never move or delete a user's original plaintext source automatically.

The initial crypto library is not a shipped vault. A user-facing vault requires platform key protection, encrypted storage/recovery, lifecycle integration, independent security review and negative leak tests. Forgotten-secret recovery is an explicit product choice, not an implicit server backdoor.

## Delivery sequence and verification

1. Preserve the current baseline and create the original engine provenance contract. Write regression and adversarial tests alongside new modules. No dependency, server schema, production-data or release changes in this foundation.
2. Build four isolated foundations in parallel: DOCX package editing, CFB/DOC text import, format/browser file utilities, and vault cryptographic primitives/threat model. Keep shared-file integration leader-owned.
3. Expose a clearly marked local engine workbench for generated/test files; opening or previewing does not grant permission to overwrite an original. Show unsupported features and export copies only. Do not use a workbench as evidence of completed Word UI support.
4. Integrate text mode and actual browser saving, preserving existing Markdown behavior. Add binary-aware desktop sessions/history/recovery only after package tests and conflict tests pass.
5. Grow the rich model/editor: paragraph/run styling, named styles/numbering, tables/media, page properties, headers/footers, page numbering, comments and revisions. Every feature needs import/edit/export support, not only a toolbar icon.
6. Implement shared layout/pagination and print/PDF, using font-aware measurements and worker/time budgets. Test tall/merged tables, missing fonts, explicit breaks and section boundaries.
7. Complete web offline storage/cache/auth and cross-browser acceptance. Add format-aware local search/sorting. Keep vault plaintext out of all global indexing paths.
8. Integrate encrypted vault storage and trusted unlock adapters; run independent security/leak review before user data enters it.
9. Add versioned Office multiplayer/sharing and encrypted-vault collaboration as separate security contracts. Preserve existing Markdown APIs and role enforcement.
10. Package and release only through Markie's human-gated release process after end-to-end review. No deployment or publication is authorized by this plan alone.

Engine acceptance: unchanged open/export returns original bytes; supported text edits survive export/reopen; unsupported/unsafe edits fail closed; package relationships/content types remain valid; Microsoft Word opens corpus outputs without repair; unknown parts remain preserved where safe; repeated round trips do not compound unexplained loss. Structural/XML validation is necessary but does not prove Word fidelity.

Security/robustness acceptance: reject malicious paths, duplicate package parts, inconsistent ZIP metadata, encrypted entries, decompression bombs, XML entities/DTDs, malformed relationships and cyclic CFB chains; enforce compressed/expanded/entry/XML/time budgets. No external resource fetching or active content execution during document opening.

Save acceptance: flush immediate keystrokes, capture immutable revision N, validate candidate, recheck source fingerprint, make recoverable checkpoint, atomically replace, acknowledge only N. A concurrent N+1 remains dirty. Test disk full, aborted export, crash before rename, revoked permission, external edit, browser eviction and stale async unlock/save results.

Regression gates: targeted tests first, then npm test, npm run typecheck, npm run lint, npm run build, MCP/server tests where contracts change, and real browser/desktop workflows when wired. No broad compatibility claim until independent Word-generated fixtures and real Word reopening have been tested.

## Risks and decisions kept explicit

- Original DOC/DOCX interpretation is a long-lived engineering investment. Basic UI does not make compatibility simple. Scope support feature-by-feature and report failures instead of destructive approximation.
- Browser and Electron use the same engine logic, not identical host capabilities. Do not reduce web to a viewer or imply full native file privileges.
- Local encryption does not solve client compromise, key recovery, encrypted search or multiplayer key distribution by itself.
- Human-owned checkpoints remain for production schemas/public APIs, visible product redesign, dependencies, biometric/keychain configuration and release. This milestone keeps those surfaces unchanged.
- No third-party document-engine adoption. Do not revive the earlier SDK recommendation without a new user decision.

## Primary specifications

- [ECMA-376 Office Open XML](https://ecma-international.org/publications-and-standards/standards/ecma-376/)
- [Microsoft Word binary format](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/ccd7b486-7881-484c-a137-51170af7cc22)
- [MS-DOC retrieving text](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/01d5d8c4-cf9c-4ef9-80fd-439e763cfe01)
- [Microsoft Compound File Binary format](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb/53989ce4-7b05-4f8d-829b-d08d6148375b)
- [Browser file-saving capability](https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker)
- [Browser storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [Web Crypto authenticated encryption](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt)
