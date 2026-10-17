# Documents in Markie

Markie adds imported documents, notes and working copy to its existing app and Library. Windows and macOS desktop apps are the primary product surface; the new web surface is secondary. Supported Word files use the original Office engine, not a Markdown conversion or third-party Word editor. Local editing does not require an account.

## Opening and editing documents

Markie keeps its established toolbar, activity bar, resizable Library, Projects, Browse, Cloud, Skills, settings and themes. Opening a Word file changes only the renderer inside that shell. Markdown and Word reuse the same compact formatting controls where their capabilities overlap; unsupported actions are not presented as working tools. There is no Word ribbon, tab strip, separate document destination or switch-back control.

When space is tight, secondary formatting and viewing controls move into **More formatting**, not another toolbar row. The same controls remain keyboard-accessible; Escape closes the popover and returns focus to its button. Available paragraph styles and formatting follow the open file type.

Use the normal Library and Open flow to select a different document. The retained Markdown document stays selectable in Recent under its filename, or as `Untitled.md` when it has not been named. Selecting it restores its existing editor and unsaved buffer without reloading the app.

On macOS and Windows, advanced actions live in the native **Format**, **Insert**, **Layout** and **Review** application menus, alongside the existing **File**, **Edit** and **View** menus. Menu availability follows the active renderer, permissions and current modal/lock state. File includes document creation, details and History; supported Word View actions include layout, outline and zoom. Parameterized operations open focused tools rather than another toolbar. The browser exposes supported actions through Markie's existing command palette, not a copied desktop menu bar or ribbon.

For Markdown, choose **View → Rich Text**, **Markdown Source** or **Split** instead of a top-bar mode toggle. Cmd/Ctrl+1, 2 and 3 still work, and the command palette offers the same modes on the web. Literal text and oversized documents retain their existing source-only protections.

The isolated **Markie Preview** desktop build runs the same Markie shell from bundled assets. It does not need a development server or browser tab. The preview name is for testing isolation, not a separate product: it has a separate app identifier, profile, session and logs, and neither replaces installed Markie nor registers its file associations or `markie://` links. Automatic updates and the production browser OAuth callback are disabled in this preview. Email sign-in can still use the configured service, but new document-platform sharing requires the matching server deployment.

## Testing the desktop preview

On macOS, open `Markie Preview.app`. Apple Silicon and Intel builds are separate; the local build is ad-hoc signed, not Developer ID signed or notarized. It is a development preview, not an installer or public release. On Windows, extract the entire x64 archive and open `Markie Preview.exe` inside its folder. Keep the accompanying DLLs, locales and resources together. The Windows preview is unsigned.

Use copies of documents first. Choose **Open** from Markie's current toolbar or File menu and select a DOCX. Edit a supported paragraph with the shared formatting controls; try a supported native menu action such as **Insert → Link** or **Layout → Page Setup**. Choose **Export → Save a Copy** to make a new Word file without touching the original. Reopen that copy in Markie and Microsoft Word. In Recent, select the retained named or untitled Markdown row and confirm its unsaved text remains, then select the recovered Word row. Neither selection should reload the shell.

The existing Library's Recent section contains recovered document rows plus **New Markdown document**, **New Word document**, **New text document** and **Locked vault** actions. Recovery copies are labeled separately from synced files. Test **Save file** on an expendable TXT copy, including a supported BOM/CRLF fixture. Local recovery and external-file saving have distinct status messages. Unsupported Word print/PDF/HTML actions are not enabled just because the Markdown editor supports them.

The vault is experimental. Use a synthetic note and a new long passphrase to test save, lock, quit, relaunch and unlock. Do not put irreplaceable or sensitive originals into this preview. There is no forgotten-passphrase reset or biometric unlock yet.

For repository development:

```sh
npm run desktop:preview:mac
MARKIE_ALLOW_E2E=1 npm run desktop:preview:run
npm run desktop:preview:windows
```

The Windows build can be produced on this Mac but must run on Windows. Explicit Intel Mac builds use `node scripts/desktop-preview.mjs build mac-x64`. Each build writes a unique ignored `.desktop-preview/` directory and a target-specific latest receipt. No command installs into Applications or publishes a release. The Codex Run action builds and opens only the preview; it does not force-close existing app windows.

Imported files become local recovery records displayed in the existing Library. Recent can filter by document type and sort by name, most recent or type; Clear filters restores the established default order. Search includes recovery names, tags, collection and extracted body text, capped at the first million characters. Native registry rows support available names/paths, not unindexed bodies. Tags and collections belong to local records, not automatically to the original file's metadata. Native files, retained buffers and recovery copies keep distinct identities and save destinations.

Word and other supported files dropped onto the desktop Library use the existing protected native file-opening path, not Markdown's text decoder. Mixed batches wait for each native import and recovery before opening the following file. A failed import or conversion requiring consent stops the batch rather than hiding the problem behind another document; finish that operation and drop the remaining files again. No imported original is overwritten by dropping or recovering it.

The device-wide Browse index remains Markdown-focused. Type filters and recovery-text search are not a claim that every unopened Word file on the machine has been body-indexed. Broad binary indexing still needs its bounded extraction and privacy/performance acceptance work.

## Supported formats

| Format | Editing and export contract |
| --- | --- |
| DOCX | Supported paragraph/run and selected-text formatting, headings, simple lists, spacing/alignment, page dimensions/margins, basic tables, PNG/JPEG pictures, safe text hyperlinks, explicit page breaks, whole-paragraph comments and simple text revisions. Unsupported package features remain read-only. |
| Markdown | Markdown source and the established rich editor, without using Markdown as an Office serialization format. |
| TXT, TEXT, LOG | Literal text with supported UTF-8/UTF-16 BOM and newline preservation. |
| CSV | Literal CSV editing with a table preview. |
| JSON, YAML, XML | Literal text editing, not schema-aware structured editors. |
| Legacy DOC | Word 97–2003 main-story extraction in a disposable local worker, producing a text-only copy. No DOC writer. Five-second worker time budget and 32 MiB input limit. |
| RTF, HTML, ODT | Explicit conversion consent creates a newly named UTF-8 TXT copy with loss warnings. Originals are not overwritten or relabeled; active content and external resources are not loaded. |

The shared formatting controls and native menus operate only on supported document capabilities. Word style choices show imported names; choosing a named paragraph style preserves unrelated direct run formatting. Supported document defaults, paragraph/character style inheritance and direct overrides are resolved for display separately from saved direct formatting. Mixed font, size and character properties are shown honestly. Theme font/color resolution, exact line heights, table/numbering styles and full Word fidelity remain incomplete. Page-shaped rendering and explicit page breaks are not Word-equivalent automatic pagination. Text tracking records actual authored OOXML insertion/deletion ranges inside existing paragraphs. It does not track new paragraph marks, formatting, table/layout or picture changes; unsupported revision forms remain read-only. Comments, undo history, local recovery and tracked changes are separate mechanisms.

## Saving and recovery

Local recovery is stored transactionally in IndexedDB with revision checks and bounded history. It is distinct from saving an external file. Clearing site data, browser eviction or deleting an app profile can remove this recovery. Export important files to keep an independent backup.

Browsers with permission-granted filesystem handles can save matching formats to that handle. Other browsers launch a download; a download does not prove that the original file was saved. Exporting revision N does not mark newer revision N+1 as saved. Failed writes, permission denial, stale sessions and conflicting versions keep the open edits.

Desktop access uses opaque leases issued only after an operating-system file choice or file-open request. Leases are scoped to the owning window, bounded and released as sessions end. Saves check source fingerprints, serialize writes to the same target and stage an atomic replacement. Newly appeared destinations and source changes fail rather than silently overwrite. New-file no-clobber commits require filesystem hard-link support. This is practical conflict protection, not a kernel-level cross-process compare-and-swap guarantee.

One close handshake covers retained Markdown, document recovery, vault and cloud-draft guards. The current shell is temporarily inert while those guards run; failed or unconfirmed recovery cancels the exact close request. A timeout keeps the window open rather than discarding edits. Leaving the protected editor locks its retained vault scope.

## Offline web editing

The production build includes a versioned service worker for the application shell and emitted assets, including the legacy DOC worker. After a successful cache fill, supported local editing, recovery, search and export can continue offline. Updates do not force a waiting worker to replace an active editing session.

Only exact public application resources are cached. Document APIs, account responses, public download links and private vault files are excluded. Document storage is separate from this shell cache. Browser APIs and storage availability still vary; a build target alone is not a compatibility certification.

## Sharing and collaboration

Sharing is explicit and optional. The additive `/api/document-platform` service stores versioned byte snapshots, with SHA-256 verification, owner/editor/viewer permissions, conflict detection, bounded history, verified-account access and expiring/revocable read-only download links. Ordinary snapshots are not end-to-end encrypted. Inviting an account does not send an invitation email.

The existing left-side Cloud page now includes ordinary document snapshots alongside legacy Markdown sync. Its shared name/type/sort controls filter metadata without downloading document bodies. Open a DOCX, Markdown or text snapshot directly from that list without first opening or uploading a local file. The guarded cloud editor reuses supported Word controls; cloud snapshots remain separate from local files/recovery, not automatic background sync. Missing-service and connection errors are distinct from an empty cloud account.

The sharing panel can open, edit and save accessible cloud snapshots. Concurrent saves use a version check; a conflict keeps the losing editor's unsaved copy. A save acknowledgment must match the submitted document, next version and exact content before dirty state clears. Account/server changes immediately hide prior rows and cancel stale work; only the confirmed identity may fetch or apply data. Viewer access excludes historical versions that could contain removed text. Revocation cannot recall downloaded copies.

This is versioned document collaboration, not live Word co-editing. Existing Markdown multiplayer remains separate. Live Office synchronization, peer cursors and collaborative undo need a further reviewed implementation.

The new service creates additive `dp_*` tables on server startup and leaves legacy Markdown endpoints unchanged. Updated server code must be deployed separately before remote sharing is available. Extra web origins require exact HTTPS entries in `MARKIE_WEB_ORIGINS` (HTTP is limited to loopback development). Local tests do not deploy this service.

## Protected local vault

The experimental vault has a separate encrypted IndexedDB database, strong-passphrase unlock, encrypted metadata/files, explicit lock, inactivity/hidden-page lock, editing and confirmed decrypted export. It never silently encrypts, deletes or uploads an imported original. Locked titles and bodies do not enter the ordinary library or its search index.

Vault search currently covers decrypted filenames while unlocked. Its encrypted recovery, browser-eviction risks and limits are detailed in [Document vault](security/document-vault.md). There is no short-PIN security claim, Touch ID/passkey unlock, lost-secret reset, encrypted multiplayer or guarantee of forensic memory erasure.

## Remaining compatibility work

The full [document platform plan](superpowers/plans/2026-10-14-document-platform.md) still includes automatic pagination and print/PDF, sections, headers/footers/page fields, merged/complex tables, advanced review, a native DOC writer, live Office co-editing and platform-protected biometric unlock. A broader sanitized Word-generated corpus, Windows runtime QA, physical Intel Mac QA and release signing/notarization remain release gates. Unsupported features must not be silently flattened to meet a visual approximation.
