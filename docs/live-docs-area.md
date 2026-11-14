# The Live Docs area on the Mac

Status: step M3, super-nightly only. The renderer shows it when `nightlyFeaturesEnabled()` is true, and every IPC handler also checks `nightlyEnabledInMain()`.

The Live Docs area is a third pane beside the Markdown and documents panes, with its own rail button. Its home lists the Darkmown projects a person has added. Opening one shows every project file in a tree and edits any text file in one CodeMirror editor with simple tabs. An edit made outside Markie shows up in the tree and in the open tab.

M3 starts no process. Run, the preview inside the area, Problems and the terminal are M4.

## Where things live

| Piece | File |
|---|---|
| Project list, file API, watcher | `electron/live-docs-projects.cjs` |
| IPC channels | `electron/main.js`, `live-docs-project*` handlers |
| Renderer bridge | `electron/preload.js` `liveDocsProjects`, typed in `src/lib/electron.ts` |
| The pane | `src/components/live-docs/live-docs-area.tsx` |
| Tree, tabs, home list | `src/lib/live-docs/` |
| Third-pane routing | `src/app/page.tsx` (`liveDocsOpenRef`) |
| Real-window check | `scripts/live-docs-area-check.mjs` |

## Trust model

The renderer is untrusted.

- A folder enters only through the native folder picker in main. Main keeps the list in `live-docs-projects.json` under the app's user data folder.
- The renderer names a project by an opaque id and a file by its path inside the open project, such as `site/pages/index.wd`. It never sends a path that main uses as given.
- Main resolves every file under the project's real root. It refuses `..`, absolute paths, a symlink at the file, and a folder on the way that resolves outside the project.
- Main records the project folder's real path and device and inode when it opens the project, and checks both before every read and write. A folder moved, renamed, or replaced after opening is refused. This is the same `folderState` check `electron/document-files.cjs` uses for documents.
- Every handler checks the nightly gate and that the sender is the main window's main frame before it reads its arguments. A subframe gets no bridge at all.

## Files

- Reads and writes are UTF-8 text only and capped at 2 MB. A file with a NUL byte, or bytes that are not UTF-8, is refused as binary.
- A write goes to a temp file beside the target and is renamed over it. It never follows a symlink at the target, and it checks again at the moment of the rename.
- A write carries the revision the editor started from. If the file changed on disk since, main refuses it, and the area offers to reload the disk version or keep the editor's text.
- M3 edits existing files only. Creating, renaming and deleting files are not in this step.
- CodeMirror saves with `\n` line endings, so a file with Windows line endings comes back with Unix ones.

## Folders

| Folder | Tree | Watcher | Read | Write |
|---|---|---|---|---|
| `.git`, `node_modules` | hidden | ignored | refused | refused |
| `.husky`, `.githooks`, `.npmrc`, `.yarnrc*`, `.vscode`, `.idea` | hidden | ignored | refused | refused |
| Other dot files and folders, such as `.gitignore`, `.github`, `.env` | shown | watched | allowed | allowed |
| A symlink | shown as a link | not followed | refused | refused |

The hidden names match any case, look-alike letters that fold to the same name, and names with ignorable characters (zero-width joiners, direction marks, the byte-order mark), which HFS+ and exFAT drop from file names. They also apply when a symlink inside the project points into one of them.

A file with more than one name (a hard link) is refused, since its other name may be outside the project. Every file is opened, and every save's temporary file created, refusing a symlink anywhere in its path, so a folder swapped for a symlink mid-operation fails instead of reaching outside.

### What hiding does not stop

Hiding `.git`, hook managers and package-manager config keeps a compromised renderer from planting the files that run by themselves. It does not make writing to a project harmless: `api/*.js`, `package.json` scripts and `.github/workflows` are ordinary project files, and the next `darkmown dev`, `npm install` or push runs what is in them. That is why M4 must start Run only from an action taken in main (a native menu item or a dialog main shows), never from a renderer call alone. Other secrets in ordinary files, such as `.env`, stay readable through the area like any project file.

## The watcher

- One recursive watcher, for the open project only.
- It waits 150 ms after the last change, and never more than one second after the first.
- A batch lists at most 200 paths. Past that it reports an overflow, and the area reloads the tree and every open tab.
- It closes when the project closes or is removed, and when the window reloads, the renderer crashes, the window closes, the private build locks, or the app quits.

## Limits

| Limit | Value |
|---|---|
| Projects in the list | 50 |
| Rows in the tree | 5,000 |
| Folder depth in the tree | 24 |
| Open tabs | 12 |
| File size | 2 MB |

## Commands while the area shows

- Save goes to the open file, from the menu, the keyboard or the palette.
- Undo and Redo go to the open file's editor.
- Find, Save As, Duplicate, Reveal, Export, Print, Zoom, view modes, statistics, history and formatting do nothing.
- Opening or creating a document leaves the area for that document's pane.
- Closing the window with unsaved Live Docs files keeps it open and shows the area.

## Hosted Live Docs

The home lists one section per source. M3 has one source, project folders on this Mac. Hosted Live Docs join in H4 as a second section, through `src/lib/live-docs/home.ts`.

## Checking it in a window

```sh
MARKIE_ALLOW_E2E=1 node scripts/live-docs-area-check.mjs [darkmown-project]
```

The check copies the project's `package.json`, `site/` and `api/` into a temp folder and works only on the copy. It replaces `shell.openExternal` and the folder picker inside the launched app's main process before it clicks anything. The app has no switch for either.
