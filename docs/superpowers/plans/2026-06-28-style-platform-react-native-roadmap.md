# Markie Style, Cross-Platform, and React Native Roadmap

_Created: 2026-06-28_

## Goal
Make Markie feel more polished and native, fix existing light-mode visibility issues, ship desktop
builds for Apple Silicon macOS, Intel macOS, Windows, and Linux, expose all supported downloads from
the download page, and then prepare for a React Native version without prematurely changing the app
stack.

## Execution Shape
The hourly automation must keep the long-agent-loop contract: one bounded task per wakeup, roughly
30 minutes of implementation, real verification, ledger/progress updates, commit, and stop.

Tasks should land in this order:
1. Light-mode correctness and visual regression coverage.
2. Incremental native-feeling layout polish.
3. Cross-platform desktop runtime and packaging support.
4. Download-page/manifest preparation for all desktop platforms.
5. React Native planning and portable-code extraction, with actual RN scaffolding gated as a stack
   checkpoint.

## Guardrails
- Do not publish, notarize, deploy, upload artifacts, rotate credentials, or touch production
  infrastructure unattended.
- Do not add new dependencies unless the selected ledger item explicitly requires escalation and a
  human has approved it.
- Treat packaging config, local dry-run scripts, docs, and tests as safe; treat public release and
  deployment as human checkpoints.
- Treat React Native scaffolding as a later checkpoint. Before that, the automation may write an
  ADR, map shared code, and extract pure modules that help both Electron and RN.

## Audit Artifacts
- [Cross-platform desktop audit](./2026-06-28-cross-platform-desktop-audit.md) classifies the
  current macOS-only and Apple-Silicon-only assumptions by runtime behavior, packaging config,
  docs/download page, test/preflight, and human-gated release/deploy work.

## Chunking Standard
Each feature-ledger item should be small enough that an agent can:
- Re-ground and run `./init.sh`.
- Touch a narrow set of files.
- Verify with a focused test, build, visual screenshot, or local dry-run.
- Append evidence to `feature_list.json` / `PROGRESS.md`.
- Commit and stop.

If a task expands, the agent should complete the smallest useful slice and add the rest back to
`feature_list.json` or `BACKLOG.md`.
