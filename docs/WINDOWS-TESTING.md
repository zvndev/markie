# Windows x64 — build on a Mac, test on a real PC

Markie's Windows build is **unsigned and private** until the gates in `docs/RELEASING.md` are met.
This page is the practical loop for producing an installer on an Apple Silicon Mac and proving it on
a real Windows 11 machine.

## 1. Build on the Mac

No Wine, mono, or rcedit is needed: electron-builder 26.x runs a native macOS `makensis`, and
`scripts/local-electron-builder.mjs` forces `signAndEditExecutable=false` and strips every `CSC_*`
/ `APPLE_*` variable, so nothing tries to sign.

First run downloads (one-time, cached under `~/Library/Caches/electron-builder` and
`~/Library/Caches/electron`): the NSIS toolchain (~10 MB), Electron win32-x64 (~100 MB), and the
`better-sqlite3` Windows prebuild. After the build the script restores the darwin `better-sqlite3`
prebuild; if the network drops at that moment run `npm run native:restore`.

```sh
cd markie
npm run electron:build:win     # next build && electron-builder --win --publish never
npm run electron:smoke:win     # structure + PE-header checks of dist/win-unpacked (mac-side)
```

Outputs (`dist/`):

| File | What |
|---|---|
| `Markie-<ver>-x64.exe` | NSIS installer (one-click, per-user, `%LOCALAPPDATA%\Programs\Markie`) |
| `Markie-<ver>-x64.zip` | portable zip |
| `win-unpacked/Markie.exe` | unpacked app — what the launch smoke drives |
| `latest.yml` | generated updater feed — **not published**; Windows updates are disabled in-app |

## 2. Get it onto the PC (LAN, no public upload)

Do **not** upload unsigned Windows artifacts to the public release bucket (`docs/RELEASING.md`).

On the Mac:

```sh
cd dist
shasum -a 256 Markie-*-x64.exe Markie-*-x64.zip | tee SHA256SUMS.txt
ditto -c -k --sequesterRsrc --keepParent win-unpacked win-unpacked.zip
python3 -m http.server 8000 --bind "$(ipconfig getifaddr en0)"
```

On the PC (PowerShell; Node 22 required for the smoke scripts):

```powershell
$mac = "http://<mac-ip>:8000"
curl.exe -O "$mac/Markie-<ver>-x64.exe"
curl.exe -O "$mac/win-unpacked.zip"
curl.exe -O "$mac/SHA256SUMS.txt"
Get-FileHash .\Markie-<ver>-x64.exe -Algorithm SHA256   # compare with SHA256SUMS.txt

git clone https://github.com/zvndev/markie.git
cd markie
git checkout <exact-commit-the-mac-built>
Expand-Archive ..\win-unpacked.zip -DestinationPath .\dist\   # → .\dist\win-unpacked\Markie.exe

npm run electron:smoke:win          # structure + PE checks (Node builtins only, no npm ci)
MARKIE_ALLOW_E2E=1 npm run electron:smoke:win:launch   # real launch over CDP; writes evidence
# (the launch smoke boots a real window, so it needs MARKIE_ALLOW_E2E=1; see scripts/lib/e2e-consent.mjs)
```

Stop the Mac's HTTP server (Ctrl-C) when done.

Evidence lands in `.autoloop\runs\windows-launch-smoke-<stamp>\` as `launch-smoke.json` and
`screenshot.png`. Keep both: they are the "exact-commit native Windows launch" evidence the release
gate asks for.

## 3. Manual checklist (Windows 11 x64)

Ordered so an early failure tells you to stop. Record the result of each.

**Install & launch**
1. Installer runs. Note the exact SmartScreen wording (expect *Windows protected your PC → More info →
   Run anyway* — the build is unsigned; this is the evidence for the signing blocker).
2. Installs to `%LOCALAPPDATA%\Programs\Markie`, auto-launches, window appears within ~10 s;
   Desktop + Start Menu shortcuts exist.
3. `npm run electron:smoke:win` passes against the copied `dist\win-unpacked`.
4. `npm run electron:smoke:win:launch` passes; `screenshot.png` shows real Markie UI, not a blank
   window.

**Native modules**
5. Open the **Library** — it populates. A blank Library or crash dialog here means `better-sqlite3`
   failed to load (`%1 is not a valid Win32 application`).
6. Open the **Terminal** panel — a real `cmd.exe` prompt appears and echoes typed input. A dead black
   pane means node-pty's ConPTY payload stayed inside `app.asar`.
7. Star a file, quit, relaunch — the star persists (SQLite writes, not just reads).

**Path handling**
8. Time the first Browse/index scan. > ~30 s, or results from `AppData`/VS Code extension READMEs,
   means the indexer exclusions are still wrong for Windows.
9. Where did the default workspace land: `C:\Users\<you>\Documents\Markie` vs
   `…\OneDrive\Documents\Markie`? With OneDrive Known-Folder-Move on, it must match Explorer's
   "Documents".
10. Add a workspace root via the folder picker, then drag-drop a file from that same folder into the
    app. "Outside the workspace" = case-sensitivity bug in `withinRoots`.
11. Create a new file named `Q3: notes.md` in the Files view — it must be refused or sanitized, not
    silently vanish (NTFS alternate data stream). Then try `CON.md` (must be refused).
12. Create a folder with a space and a Unicode character (`Notes – 2026 ✓`), put a `.md` inside,
    open, edit, save.
13. Rename a folder whose sibling has a similar name with an underscore (`bob_dev` next to `bobXdev`)
    — the sibling's Library entries are untouched.
14. Open the same file twice via two different path casings (picker vs drag-drop) — it must not
    appear twice in the Library.

**Chrome, menus, shell integration**
15. Count the title bars at the top of the window. Two (native caption + Markie toolbar) = the
    `hiddenInset` gating regressed. Window drag by the Markie toolbar works; Snap Layouts (hover the
    maximize button) behave.
16. Open every menu. There should be no leading "Markie" menu with inert Hide / Hide Others / Unhide,
    and no dead Zoom / Bring All to Front.
17. `Ctrl+N`, `Ctrl+O`, `Ctrl+S`, `Ctrl+Z`, **`Ctrl+Y`** (Redo), `Ctrl+F` all work.
18. Right-click a file → "Show in Explorer" — Explorer opens with the file selected.
19. Delete a file from the Files view — it lands in the **Recycle Bin**, not gone.

**Integration & updates**
20. Close Markie. Double-click a `.md` in Explorer — opens in Markie (or note that Windows claims the
    association and the app offers no in-app way to fix it). With Markie running, double-click a
    second `.md` — the existing window focuses and opens it (`second-instance`), no second process.
21. `Start-Process "markie://test"` from PowerShell with the app running — the window focuses.
    After uninstall, check whether `HKCU\Software\Classes\markie` survives.
22. Menu → **Check for Updates…** — expect the modal *"Automatic updates are not enabled for Windows
    yet."* Anything else is a bug.
23. Uninstall via Settings → Apps; install dir + shortcuts removed; workspace files under Documents
    untouched.

Capture `.autoloop\runs\windows-launch-smoke-*\` and a short screen recording of items 5, 6, 8, 15.

## 4. What still blocks a *public* Windows download

| Blocker | Where | Unblock |
|---|---|---|
| Manifest says `planned`, no feed | `server/download-manifest.json` `windows-x64` | flip to `public` + add `feed` (needs the updater feed below), redeploy server |
| No Authenticode signing | `scripts/local-electron-builder.mjs` deliberately can't sign | OV/EV cert or Azure Trusted Signing; a separate signed-release wrapper; verify with `Get-AuthenticodeSignature` |
| No exact-commit native launch evidence | `.github/workflows/windows-launch-smoke.yml` blocked by Actions billing | fix billing and `workflow_dispatch`, **or** run §2 on the PC and archive the evidence |
| Updater is macOS-only | `electron/update-policy.js`, `electron/main.js` autoUpdater wiring, `scripts/release-preflight.mjs` doc assertion | add `windows-x64.feed.path`, teach update-policy about `latest.yml`, wire `setupAutoUpdate` for win32 |
| Release runner is macOS-only | `scripts/release.mjs` (`prepare`/`publish`/`verify`/`rollback` assert darwin) | Windows-side equivalent with artifact-first/feed-last ordering and SHA-512 verification |
| Update-from-previous-version test | release gate | waived for the first Windows release, mandatory from the second |
| Human release decision | `docs/RELEASING.md` | owner's call |
