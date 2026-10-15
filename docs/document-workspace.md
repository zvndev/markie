# Document workspace

Markie's document workspace brings imported documents, notes and working copy into a searchable local library. Windows and macOS desktop apps are the primary product surface; the new web surface is secondary. Both use the original Office engine, not a Markdown conversion or third-party Word editor. Local editing does not require an account.

## Opening the workspace

Markie keeps its established toolbar, activity bar, resizable Library, Projects, Browse, Cloud, Skills, settings and themes. Opening a Word file changes only the editor inside that shell. It does not navigate to a second app or replace the Markdown interface. Word's Home, Insert, Layout, Review and View tools appear below Markie's top bar. Return to Markdown restores the retained editor and buffer, rather than reloading the page.

The isolated **Markie Preview** desktop build runs the same Markie shell from bundled assets. It does not need a development server or browser tab. The preview name is for testing isolation, not a separate product: it has a separate app identifier, profile, session and logs, and neither replaces installed Markie nor registers its file associations or `markie://` links. Automatic updates and the production browser OAuth callback are disabled in this preview. Email sign-in can still use the configured service, but new document-platform sharing requires the matching server deployment.

## Testing the desktop preview

On macOS, open `Markie Preview.app`. Apple Silicon and Intel builds are separate; the local build is ad-hoc signed, not Developer ID signed or notarized. It is a development preview, not an installer or public release. On Windows, extract the entire x64 archive and open `Markie Preview.exe` inside its folder. Keep the accompanying DLLs, locales and resources together. The Windows preview is unsigned.

Use copies of documents first. Choose **Open** from Markie's current toolbar or File menu and select a DOCX. Edit a supported paragraph, then choose **Export → Save a Copy** to make a new Word file without touching the original. Reopen that copy in Markie and Microsoft Word. The existing Library's Recent section contains recovered document rows plus **New Word document**, **New text document** and **Locked vault** actions. Recovery copies are labeled separately from synced files. Test **Save file** on an expendable TXT copy. Local recovery and external-file saving have distinct status messages.

The vault is experimental. Use a synthetic note and a new long passphrase to test save, lock, quit, relaunch and unlock. Do not put irreplaceable or sensitive originals into this preview. There is no forgotten-passphrase reset or biometric unlock yet.

For repository development:

```sh
npm run desktop:preview:mac
MARKIE_ALLOW_E2E=1 npm run desktop:preview:run
npm run desktop:preview:windows
```

The Windows build can be produced on this Mac but must run on Windows. Explicit Intel Mac builds use `node scripts/desktop-preview.mjs build mac-x64`. Each build writes a unique ignored `.desktop-preview/` directory and a target-specific latest receipt. No command installs into Applications or publishes a release. The Codex Run action builds and opens only the preview; it does not force-close existing app windows.

Imported files become local library records. Search covers names, tags, collection and indexed body text, with type filters and name/recent sorting. Body indexing is capped at the first million characters. Tags and collections belong to local records, not automatically to the original file's metadata. The classic desktop index is not silently migrated into this library.

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

The Word toolbar contains Home, Insert, Layout, Review and View. Page-shaped rendering and explicit page breaks are not Word-equivalent automatic pagination. Text tracking records actual authored OOXML insertion/deletion ranges inside existing paragraphs. It does not track new paragraph marks, formatting, table/layout or picture changes; unsupported revision forms remain read-only. Comments, undo history, local recovery and tracked changes are separate mechanisms.

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

The sharing panel can open, edit and save accessible cloud snapshots. Concurrent saves use a version check; a conflict keeps the losing editor's unsaved copy. Account changes clear account-bound content and cancel stale work. Viewer access excludes historical versions that could contain removed text. Revocation cannot recall downloaded copies.

This is versioned document collaboration, not live Word co-editing. Existing Markdown multiplayer remains separate. Live Office synchronization, peer cursors and collaborative undo need a further reviewed implementation.

The new service creates additive `dp_*` tables on server startup and leaves legacy Markdown endpoints unchanged. Updated server code must be deployed separately before remote sharing is available. Extra web origins require exact HTTPS entries in `MARKIE_WEB_ORIGINS` (HTTP is limited to loopback development). Local tests do not deploy this service.

## Protected local vault

The experimental vault has a separate encrypted IndexedDB database, strong-passphrase unlock, encrypted metadata/files, explicit lock, inactivity/hidden-page lock, editing and confirmed decrypted export. It never silently encrypts, deletes or uploads an imported original. Locked titles and bodies do not enter the ordinary library or its search index.

Vault search currently covers decrypted filenames while unlocked. Its encrypted recovery, browser-eviction risks and limits are detailed in [Document vault](security/document-vault.md). There is no short-PIN security claim, Touch ID/passkey unlock, lost-secret reset, encrypted multiplayer or guarantee of forensic memory erasure.

## Remaining compatibility work

The full [document platform plan](superpowers/plans/2026-10-14-document-platform.md) still includes automatic pagination and print/PDF, sections, headers/footers/page fields, merged/complex tables, advanced review, a native DOC writer, live Office co-editing and platform-protected biometric unlock. A broader sanitized Word-generated corpus, Windows runtime QA, physical Intel Mac QA and release signing/notarization remain release gates. Unsupported features must not be silently flattened to meet a visual approximation.
