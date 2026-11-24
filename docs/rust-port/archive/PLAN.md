# Markie RS: the Rust rewrite plan

> Archived 2026-11-24. It was the first plan for Markie RS as a side build, and its phase estimates (the 1.5 to 2 week platform phase, Windows and Linux included, among them) were sized before the Mac port existed and are wrong. Superseded by [PLATFORMS.md](../PLATFORMS.md) for the plan and [SCORE.md](../SCORE.md) for parity. Kept for history: do not plan from it.

Date: 2026-11-21. Branch: `rust/markie-rs`. Worktree: `/Users/macbookpro-kirby/Desktop/Coding/ZVN/markie-rs`.

Markie RS is a side build. It rebuilds desktop Markie in native Rust next to the shipping Electron app, and replaces it only if Kirby decides so at the end.

## Ground rules

These keep the side build from touching the main release channels.

| Rule | How it is enforced |
|---|---|
| Separate app | Name "Markie RS", bundle id `com.zvn.markie.rs`. `open -a Markie` still opens Electron. |
| Separate data | Its own folder, `~/Library/Application Support/Markie RS`. It never opens the Electron registry, drafts or sign-in. |
| No release pipeline | No updater, feed, upload or signing identity. `rust/scripts/bundle-mac.sh` builds a local, ad-hoc-signed app. |
| No file-type takeover | It claims no file types and no `markie://` scheme. Double-clicking a `.md` still opens Markie. |
| No CI noise | CI runs on pushes to `main` and on pull requests only. A branch push runs nothing. |
| Electron packaging can't see it | Electron Builder ships only `electron/`, `out/` and one MCP file. `rust/` is excluded from TypeScript too. |
| Same server | It talks to Markie Cloud through the same API as web and phone. No server changes for the port. |

## Phases

Each phase has a closed list and a finish line. Estimates are agentic wall-clock time with agents working in parallel. They assume the GPUI toolkit holds up, and they name the serial limits.

| Phase | Scope | Finish line | Estimate |
|---|---|---|---|
| 0. Foundation | Workspace, core crate, device index, View and Source, save, search, type filters, themes, local app bundle | **Done 2026-11-21.** 20 core tests pass; app opens, edits, saves byte-exact, indexes 107k files. | Done |
| 1. Local parity | See list below | Every [stable] local feature in PARITY.md sections 1 to 7, 9, 13, 24, 28, 29 works, with tests. | 3 to 4 days |
| 2a. Rich editor spike | Block editor prototype on GPUI | Passes the round-trip corpus from `src/lib/rich-roundtrip.corpus.test.tsx` byte for byte, and shares a live room with the web app. | 2 days, then a go or no-go call |
| 2b. Rich editor | Full View mode | Headings, lists, tasks, tables, images, math, embed cards, highlight and colour marks, section rail, zoom. Corpus and collab tests pass. **Built 2026-11-21** (`RICH-EDITOR.md`); open items listed there. | 1.5 to 2.5 weeks, the longest serial track |
| 3. Cloud | Sign-in, sync, sharing, comments, collaboration | Sign in with Google, Apple, email; sync, share and comment on a document that web and phone users see live. | 1 to 1.5 weeks, parallel with 2b |
| 4. Office engine | DOCX, RTF, ODT, DOC, HTML import | Port our TypeScript codecs; native Word page view; unchanged files keep their bytes. | 1.5 to 2 weeks, parallel with 2b |
| 5. Web islands and export | `.wd` preview, Live Docs, embeds, PDF, print, HTML export | Darkmown preview runs sandboxed in `wry`; PDF and print through `typst`. | 4 to 5 days |
| 6. Platform | Agent bridge, MCP, vault, Touch ID, deep links, default apps, crash reports, updater, Windows and Linux, data migration | Same agent socket protocol; vault opens existing vaults; migration moves tokens, themes and vault out of Chromium storage. | 1.5 to 2 weeks |
| 7. Dogfood and decision | Kirby uses Markie RS daily | Parity checklist signed off, then a cutover decision. | 1 week of use |

Total, if every gate passes: about 7 to 10 weeks of wall-clock time.

The serial limits are the rich editor (one design, hard to split), Kirby's sign-in and approval steps, Apple signing and notarization when it ships, and Windows and Linux test runs on CI.

### Phase 1 list

Status on 2026-11-21: items 2, 3, 6, 8 and 11 are done. Items 1, 4, 5, 7, 9 and 10 are mostly done; what is left of each is noted.

1. File operations: new document modal with every type, rename, move, trash, reveal, duplicate. Done except move, and new Word, Darkmown and vault documents (phases 4 to 6).
2. Outside-edit watcher, ignoring Markie's own writes. Done, as a 1 s poll like Electron's.
3. Autosave (1 s idle, at most every 5 s while typing), crash drafts, save-conflict strip. Done.
4. Version history in the same on-disk format as `electron/history.js`, with diff and restore. Done except the diff view.
5. Find and replace, section rail, statistics panel, zoom and page width. Done except find in View mode, which waits for the rich editor.
6. Command palette, full menus and shortcuts from PARITY.md section 29. Done for every command that exists so far.
7. Settings with the eight style templates in light and dark, and custom presets. Done except custom presets and template typography.
8. Large-document tier (source only above 1 MB, refuse above 100 MB), CSV table view. Done.
9. Library tabs: Recent, Starred, Projects, workspace folders. Done except Projects and removing a folder.
10. Link previews on hover, with the same size, timeout and address limits. The address rules and page parsing are ported and tested; the hover card waits for the rich editor and the fetch for phase 3 networking.
11. A read-only import of the Electron registry: recents, roots and stars. Done.

## The rich editor gate

Phase 2a is the decision point for the whole port.

The editor keeps the Markdown source as the truth. It parses blocks with their byte ranges, renders each block as editable styled text, and rewrites only the blocks the user touched. For collaboration it maps blocks to the same Yjs elements TipTap uses (`XmlFragment("default")`, its node and mark names), through `yrs`.

If the spike fails either test, the fallback is a native Markie with Source plus a rendered preview, and rich editing in a `wry` web view running today's TipTap. That would no longer be "fully Rust", so it comes back to Kirby as a decision.

## Decisions for Kirby

| Question | Recommendation |
|---|---|
| Toolkit | Keep GPUI Kit. It built and ran with no surprises. |
| Web content | Allow `wry` for `.wd` previews, Live Docs and video embeds. Rust hosts it; no JavaScript app code ships. |
| MCP server | Keep the Node MCP through Phase 6, then port it to Rust so the whole product is one language. |
| Tracking | File this plan in Circular as a project, one task per phase with these finish lines. |
| Backup | Push the `rust/markie-rs` branch to GitHub. A branch push runs no CI. |

## How to run it

```sh
cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/markie-rs/rust
cargo test -p markie-core          # core tests
cargo run -p markie-app -- <file>  # debug build
./scripts/bundle-mac.sh            # target/release/Markie RS.app
```

Set `MARKIE_RS_DATA_DIR` to point the app at a scratch data folder for testing.
