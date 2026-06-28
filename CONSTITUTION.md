# Constitution — Markie

> Non-negotiable rules. Human edits only. The loop obeys these over any task or progress note.
> Hard guarantees should also be enforced by harness hooks or sandbox policy where possible.

## Stack (fixed)
- Language/runtime: TypeScript and JavaScript on Node.js 22+.
- Framework(s): Electron 41, Next.js 16 static export, React 19, Tailwind 4, CodeMirror 6, TipTap /
  ProseMirror, Yjs, Hono, better-auth, better-sqlite3.
- Datastore: local SQLite registry in Electron; server SQLite with Litestream/B2 backups.
- Deploy target: Electron desktop builds for Apple Silicon macOS, Intel macOS, Windows, and Linux;
  optional server API on the existing Markie cloud host.

## Always
- Verify a feature by reproducing its `steps[]` as a real user before marking it `passes:true`.
- Ship every refinement or bugfix with a regression test when the behavior is testable.
- Keep each run's diff small and reviewable; one task per run.
- Leave the tree clean and mergeable; commit with the Lore commit protocol every run.
- Preserve local-first behavior: account, sync, sharing, and collaboration must stay optional.
- Keep dark mode and light mode fully legible across primary app surfaces before adding speculative
  product surface.
- Improve toward a refined, modern, native-feeling desktop layout in small verified passes.
- Prefer existing utilities and patterns over new dependencies or new architectural layers.

## Never (hard prohibitions)
- Never change the stack above unattended.
- Never delete, weaken, or skip tests to make a task look done.
- Never add a new external dependency without escalating first.
- Never run destructive or irreversible commands, force-push, publish, notarize, or deploy.
- Never touch production data, billing, auth provider configuration, release credentials, or cloud
  infrastructure unattended.
- Never commit secrets, tokens, private keys, release credentials, or user document contents.

## Human checkpoints (escalate, do not decide unattended)
- Schema / data-model changes.
- Public API shape, including MCP tools, server routes, deep-link contracts, and bundled CLI commands.
- Major visible design / UI direction. Small consistency fixes within the established design are okay.
- Release, deployment, notarization, credential rotation, or external service configuration.

## Severity floor
Act unattended on findings of severity **medium** and above when they stay inside the autonomy bounds.
Record lower-severity findings but do not task them unless the backlog is otherwise empty.

## Assumed defaults — ratify or correct
- Mode is `build`: the app already works, and the loop should add/refine one verified feature per run.
- Cadence is hourly, with a 45 minute / 60 turn cap per run.
- Escalation is file-based until an external tracker is specified: write blockers to `PROGRESS.md` and
  keep blocked items in `BACKLOG.md`.
- Review rotation is product, real-user-flow, code review, and security review.
- In-bounds work is local-first Markie functionality, Electron/renderer/MCP/server tests, developer
  experience, light-mode/style fixes, cross-platform desktop enablement, download-page preparation,
  React Native planning/prep that does not add a new app stack unattended, and documented roadmap
  items that do not require production credentials.
