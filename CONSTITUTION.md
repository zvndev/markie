# Constitution: Markie

> Non-negotiable rules. Human edits only. Agents obey these over any task or progress note.
> Hard guarantees should also be enforced by harness hooks or sandbox policy where possible.

## Stack (fixed)
- Language/runtime: TypeScript and JavaScript on Node.js 22+.
- Framework(s): Electron 41, Vite 8 renderer build, React 19, Tailwind 4, CodeMirror 6, TipTap /
  ProseMirror, Yjs, Hono, better-auth, better-sqlite3. The phone app in `apps/mobile` is Capacitor 8
  and reuses the desktop renderer modules.
- Datastore: local SQLite registry in Electron; server SQLite with Litestream/B2 backups.
- Deploy target: Electron desktop builds for Apple Silicon macOS, Intel macOS, Windows, and Linux;
  the Markie Docs phone app for iOS and Android; the optional Markie Cloud API at
  `api.markiedocs.com`, which runs on ZVN's own boxes and deploys from `ZVN-DEV/zvn-infra` with
  Kamal. Never deploy Markie Cloud to Railway or Fly.

## Always
- Verify a feature by reproducing its user journey as a real user before calling it done.
- Ship every refinement or bugfix with a regression test when the behavior is testable.
- Keep each change small and reviewable; one task per branch and PR.
- Leave the tree clean and mergeable; commit with the Lore commit protocol.
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
  `docs/RELEASING.md` is the release runbook: early access, a 3-day soak, then promotion to stable.

## Pending amendment: release approval scope (not ratified)
Proposed with the early-access pipeline on 2026-10-20. It takes effect only when Kirby ratifies it
here; until then, ask before promoting a release to stable as well.
- Proposed: Kirby saying "release X.Y.Z" approves the early-access publish of X.Y.Z and its timed
  promotion to stable after the soak, unless he holds it. The promotion may then run unattended
  through `release:promote-due`.

## Severity floor
Act unattended on findings of severity **medium** and above when they stay inside the autonomy bounds.
Record lower-severity findings in Circular but do not task them unless the backlog is otherwise empty.

## Assumed defaults: ratify or correct
- Mode is `build`: the app already works, and each task adds or refines one verified feature.
- Agents run on request, not on a schedule. The hourly loop and its task files were retired on
  2026-10-27.
- Work and escalation are tracked in Circular (gocircular.dev). `PROGRESS.md` is the release and
  operations log; `BACKLOG.md` is a scratch list.
- Review rotation is product, real-user-flow, code review, and security review.
- In-bounds work is local-first Markie functionality, Electron/renderer/MCP/server/mobile tests,
  developer experience, light-mode/style fixes, cross-platform desktop enablement including Linux,
  download-page preparation, and documented roadmap items that do not require production
  credentials.
