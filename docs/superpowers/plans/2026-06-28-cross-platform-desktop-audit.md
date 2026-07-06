# Cross-Platform Desktop Audit

_Created: 2026-06-28_

## Scope
This audit maps the macOS-only and Apple-Silicon-only assumptions that block first-class desktop
support for Apple Silicon macOS, Intel macOS, Windows, and Linux. It is a checklist only: no runtime
behavior, packaging, publishing, notarization, upload, deploy, or credentialed release action changed
in this pass.

## Summary
Markie already has some platform-aware Electron behavior for file opens, deep links, and app
lifecycle, but the product is still configured, documented, and marketed as an Apple Silicon macOS
app. The highest-impact safe path is:

1. Make one runtime fallback fully platform-aware and test it across `darwin`, `win32`, and `linux`.
2. Expand local packaging scripts/config so all four desktop targets can be validated without
   publishing.
3. Extend release docs and preflight metadata to describe the full artifact matrix.
4. Add a repo-local download manifest, then update the download-page source or integration contract.

## Findings By Category

### Runtime Behavior
- [x] `electron/terminal.js` starts PTYs with `process.env.SHELL || "/bin/zsh"`. On Windows this
      needs an explicit shell selection such as PowerShell or `cmd.exe`, plus tests for `darwin`,
      `win32`, and `linux`.
      Completed 2026-07-03: `resolveShell` now selects macOS, Linux, and Windows shell fallbacks
      with regression coverage in `electron/terminal.test.ts`.
- [x] `electron/terminal.js` discovers only macOS `.app` terminal candidates and opens external
      terminals via `open -a`. Non-macOS currently returns no external terminal apps and
      `"macOS only"` for launch requests. Decide whether Windows/Linux should expose native
      launchers or hide the launcher with clearer copy.
      Completed 2026-07-04: external terminal candidates now cover macOS `.app` launchers,
      Windows Terminal / PowerShell / Command Prompt, and Linux `$TERMINAL` plus common detected
      emulators, with focused command-shape tests across `darwin`, `win32`, and `linux`.
- [x] `mcp/markie-mcp.mjs` implements `markie_open_in_markie` with `spawn("open", ["-a", "Markie",
      path])`. This needs a platform guard or platform-specific opener before MCP is advertised as
      cross-platform.
      Completed 2026-07-03: MCP open command selection now covers `darwin`, `win32`, and `linux`
      through a side-effect-free helper tested in `mcp/lib.test.mjs`.
- [x] `src/components/browse-view.tsx` derives `~` display paths only from `/Users/<name>`, so
      Windows paths and most Linux home paths will not shorten correctly.
      Completed 2026-07-03: Browse and Skills share cross-platform home-path compaction for
      `/Users`, `/home`, and Windows user homes.
- [x] `src/components/toolbar.tsx` correctly applies the traffic-light padding only on Darwin. Keep
      this as the desktop-chrome pattern when adding Windows/Linux window controls or spacing.
      Completed 2026-07-05: the toolbar reads `getElectronAPI().platform` and applies hiddenInset
      traffic-light padding only when the platform is `darwin`.
- [x] `electron/main.js` handles Darwin `open-url`/`open-file`, Windows/Linux argv handoff, and
      non-Darwin `window-all-closed` quit behavior. Preserve these paths when adding packaged
      cross-platform launch tests.
      Completed 2026-07-05: `electron/desktop-intents.js` now centralizes Markie deep-link,
      openable file argv, and file-URL detection with tests covering Windows/Linux argv handoff and
      OS-level file URL opens. `main.js` uses that helper for cold-start and second-instance opens,
      while retaining Darwin `open-file`/`open-url` events and non-Darwin quit behavior.
- [x] `electron/main.js` default Markdown handler actions are explicitly Darwin-only through Swift
      and LaunchServices. For cross-platform support, either add Windows/Linux registration flows or
      keep the UI hidden/unsupported with tests proving graceful fallback.
      Completed 2026-07-05: desktop intent tests now prove default-handler registration is exposed
      only for packaged macOS, while Windows/Linux and dev builds get explicit unsupported fallback
      copy.

### Packaging Config
- [x] `package.json` describes Markie as `macOS (Apple Silicon)` and uses `macos` as a keyword.
      Update metadata once local packaging support includes all desktop targets.
      Completed 2026-07-04: package metadata now describes native desktop Markie and local
      packaging config covers macOS arm64/x64, Windows x64, and Linux x64.
- [x] `package.json` `electron:build`, `electron:pack`, and `electron:release` are all `--mac`
      only. Add local-only scripts for macOS arm64, macOS x64, Windows, and Linux before changing
      release behavior.
      Completed 2026-07-04: added no-publish local scripts for macOS arm64, macOS x64, Windows x64,
      and Linux x64 while keeping the credentialed `electron:release` path explicit.
- [x] `package.json` `build.mac.target` emits only `arm64` `dmg` and `zip`. Add Intel Mac targets
      first, then Windows and Linux targets in a way electron-builder can parse locally.
      Completed 2026-07-04: macOS targets now include arm64/x64 `dmg` and `zip`; Windows includes
      x64 `nsis` and `zip`; Linux includes x64 `AppImage` and `deb`.
- [ ] `package.json` `build.publish` points to the `mac` release path only. Treat new publish paths
      as release/deploy work and keep them human-gated.
- [x] `electron-updater` comments and feed assumptions in `electron/main.js` are Mac feed oriented.
      Cross-platform updater work should wait until platform artifact names and feed files are
      defined.
      Completed 2026-07-05: update feed support is now centralized in `electron/update-policy.js`;
      auto-update setup runs only for packaged macOS, and packaged Windows/Linux manual checks
      return an explicit `unsupported-platform` message instead of touching the macOS feed.

### Docs And Download Page
- [x] `README.md` says files live on a Mac, Browse indexes files on a Mac, install is Apple Silicon
      macOS only, Intel Macs are unsupported, and source packaging writes to `dist/mac-arm64/`.
      Completed 2026-07-04: README now describes files on the user's machine, local packaging
      commands for macOS arm64/x64, Windows, and Linux, and clearly states only Apple Silicon macOS
      is currently public.
- [x] `docs/RELEASING.md` is titled for Apple Silicon macOS and documents only `latest-mac.yml`,
      `dist/mac-arm64/Markie.app`, and `Markie-<version>-arm64.dmg`.
      Completed 2026-07-04: release docs now include the local desktop artifact matrix and keep
      public non-macOS releases behind explicit signing/feed/download approval.
- [x] `server/src/public.ts`, `server/src/render.ts`, `server/src/shares.ts`, and
      `server/src/render.test.ts` expose only `/download/mac` and "Get Markie for macOS" copy.
      Completed 2026-07-04: public/share CTA copy now comes from `server/download-manifest.json`;
      the current primary remains Apple Silicon macOS while planned platform routes render an
      unavailable page instead of fake artifact redirects.
- [x] `server/src/public.ts` parses only `Markie-*-arm64.dmg` from `latest-mac.yml`. The download
      page needs a manifest or equivalent source of truth before it can advertise Intel Mac,
      Windows, and Linux.
      Completed 2026-07-04: artifact parsing moved behind manifest platform metadata, with
      Apple Silicon macOS as the only public feed and Intel Mac/Windows/Linux represented as
      planned targets.
- [x] `src/components/agents-dialog.tsx`, `src/components/files-view.tsx`, and
      `mcp/markie-mcp.mjs` use "this Mac" or "on your Mac" copy for local files. Update after the
      runtime fallbacks are real.
      Completed 2026-07-03 for the live Agents dialog and MCP server copy; no live Files-view
      "Mac" copy remained in source.

### Test And Preflight
- [x] `build/preflight.cjs` returns immediately for non-Darwin builds and uses `osascript` for the
      macOS smoke check. Add platform-specific local preflight coverage or explicit skip reporting
      before relying on Windows/Linux artifacts.
      Completed 2026-07-04: non-macOS afterPack now logs an explicit OS-level smoke skip instead
      of returning silently.
- [x] `scripts/release-preflight.mjs` validates Mac notarization, Mac entitlements, a publish
      target, and the explicit `electron:release` publishing command, but it does not validate a
      platform artifact matrix.
      Completed 2026-07-04: `release:preflight` validates local no-publish scripts, platform
      targets, and generated Windows/Linux icon assets.
- [x] `electron/release-preflight.test.ts` only asserts Mac release prerequisites. Expand it when
      `release:preflight` learns the full desktop matrix.
      Completed 2026-07-04: preflight tests now cover local packaging scripts and artifact targets.
- [x] `server/src/public.test.ts` and `server/src/render.test.ts` assert Mac-only download behavior.
      Replaced 2026-07-04 with manifest-driven platform tests for public and planned downloads.
- [x] `scripts/perf-check.mjs` documents a Mac-only `open -a dist/mac-arm64/Markie.app` command.
      Add equivalent instructions for cross-platform smoke/performance checks.
      Completed 2026-07-04: packaged-app perf instructions now include macOS, Windows, and Linux
      commands, and `scripts/package-smoke.mjs` plus `electron:smoke:*` scripts define the
      unpacked artifact structure checks for each local packaging target.
- [x] macOS Intel local package path has launch evidence.
      Completed 2026-07-04: `npm run electron:pack:mac:x64` built `dist/mac/Markie.app` through
      the certificate-free local wrapper, the macOS window preflight loaded `Markie — Markdown
      Viewer` through Rosetta, and `npm run electron:smoke:mac:x64` verified bundled app/MCP
      structure with host-compatible reporting.
- [x] Windows x64 local unpacked package has structure/native-payload evidence.
      Completed 2026-07-04: `npm run electron:pack:win` builds `dist/win-unpacked` through the
      certificate-free local wrapper, installs the Electron 41 `better-sqlite3` Windows x64
      prebuild, and `npm run electron:smoke:win` verifies `Markie.exe`, critical native `.node`
      files, app bundle, and MCP resources as Windows PE payloads. Native Windows launch evidence
      remains host-gated.
      Updated 2026-07-05: the local wrapper now passes `-c.npmRebuild=false` for Windows targets so
      macOS hosts do not fail while cross-rebuilding `node-pty`; Windows native payload correctness
      remains enforced by `install-win-native-prebuild.mjs` and `electron:smoke:win`.
- [x] Windows x64 native launch evidence has a host-runner path.
      Completed 2026-07-04: `scripts/windows-launch-smoke.mjs` runs only on `win32`, launches
      `dist/win-unpacked/Markie.exe` with a temporary profile and CDP port, and verifies the
      packaged renderer loads Markie UI. `.github/workflows/windows-launch-smoke.yml` runs
      `electron:pack:win`, `electron:smoke:win`, and `electron:smoke:win:launch` on
      `windows-latest` without signing, publishing, uploading, or release credentials.

### Human-Gated Release Or Deploy Work
- [ ] Signing, notarization, upload, publish, deployment, credential rotation, cloud storage paths,
      public release feed changes, and external service configuration remain human checkpoints.
- [ ] Windows code signing, Linux distribution format decisions, Intel Mac release notarization, and
      public download URL shape need human review before production publishing.
- [ ] Do not change the live marketing/download site or B2 bucket layout unattended. Prepare local
      manifests, docs, validation, and dry-run scripts first.

## Recommended Next Slice
For `F-016`, pick the smallest runtime assumption with clear fallback behavior and test it across
platform values. The best candidates are `mcp/markie-mcp.mjs` `markie_open_in_markie` or
`electron/terminal.js` shell selection, because both can be fixed locally without changing public
API shape, release credentials, or packaging targets.
