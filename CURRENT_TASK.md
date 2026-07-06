# Current Task - Library organization polish

## Task
Make the Library view organize local, cloud-only, and shared documents in a predictable order that
surfaces actionable documents before ordinary recent files.

## Acceptance Criteria
1. Library buckets are produced by a shared, tested organizer instead of ad hoc component filters.
2. Conflict, behind, and missing local files sort ahead of ordinary documents.
3. Ordinary documents sort by latest known activity, then by natural filename order.
4. The Library panel shows section counts or alert counts without breaking light or dark mode.
5. Focused Library tests, lint, build, visual theme guard, and local release preflight pass.

## Scope Guard
Do not push, publish, deploy, sign/notarize, change release credentials, or run production update
feeds. Windows native launch still requires a Windows host/workflow run.
