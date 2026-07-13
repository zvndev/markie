# Current Task - Repeatable Full Release Workflow

## Task
Make Markie's full desktop release process repo-owned, auditable, and difficult to publish
incorrectly. Use one canonical stable-channel manifest for Electron Builder, updater feeds,
website downloads, and email links.

## Acceptance Criteria
1. One committed manifest defines storage, updater feed paths, platform publication status, and
   stable public download routes.
2. Electron Builder and the server both consume that manifest.
3. Version bumps update every versioned package file through one command.
4. Signed release preparation is separate from public upload and produces durable evidence.
5. Public upload publishes immutable artifacts before the mutable updater feed.
6. Public verification proves feed version, artifact integrity, stable website redirects, and the
   machine-readable latest-release route.
7. Release docs and `AGENTS.md` tell future agents exactly how to prepare, approve, publish,
   verify, finalize, and recover a release.
8. Full preflight and focused release/server regression tests pass.

## Scope Guard
Do not publish a production feed while implementing or testing this workflow. Windows remains a
prepared-but-private target until code signing and exact-commit native Windows launch evidence are
available.
