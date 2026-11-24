# Markie docs index

Last audited 2026-11-24.

Before planning from a doc, check its status here. Archived docs are history.

- **Current**: describes how things work now. Fix it when it goes wrong.
- **Reference**: a spec, contract or record that is still true, but not a plan.
- **Archived**: a superseded plan or finished project. It lives in `docs/archive/`.

Open work is tracked in Circular, not in these files. Markie RS, the Rust app that now carries the
Mac super-nightly, keeps its own docs (`docs/rust-port/`, including `PLATFORMS.md`, the platform
plan of record). They are not indexed here.

## Start here

| Doc | Status | What it is for |
| --- | --- | --- |
| [README.md](../README.md) | Current | What Markie is, install, the MCP, build from source |
| [VISION.md](../VISION.md) | Current | Product north star. Human edits only |
| [CONSTITUTION.md](../CONSTITUTION.md) | Current | Non-negotiable rules for agents. Human edits only |
| [AGENTS.md](../AGENTS.md) | Current | Operating manual for coding agents: commands, layout, commit and release protocol |
| [CLAUDE.md](../CLAUDE.md) | Current | Points Claude Code at AGENTS.md |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Current | From a clone to a passing pull request |
| [SECURITY.md](../SECURITY.md) | Current | How to report a vulnerability, and what is in scope |
| [DESIGN.md](../DESIGN.md) | Current | Design source of truth for the document features |
| [BACKLOG.md](../BACKLOG.md) | Current | Scratch list of scoped items waiting to be filed in Circular |
| [CHANGELOG.md](../CHANGELOG.md) | Current | User-facing notes for every release |
| [PROGRESS.md](../PROGRESS.md) | Reference | Append-only release and operations log. Old entries describe the state at the time |

## Releases, hosting and deploys

| Doc | Status | What it is for |
| --- | --- | --- |
| [RELEASING.md](RELEASING.md) | Current | The desktop release runbook: early access, soak, stable, rollback |
| [PRIVATE_RELEASES.md](PRIVATE_RELEASES.md) | Current | The private super-nightly lane and its gateway. Draft PR #156 updates it for the Rust app on the Mac lane and the retired `rs-nightly` lane; until that merges, its `rs-nightly` section is out of date |
| [WINDOWS-TESTING.md](WINDOWS-TESTING.md) | Current | Build a Windows test installer on a Mac and check it on a real PC |
| [SELF-HOSTING.md](SELF-HOSTING.md) | Current | Run your own Markie server |
| [deploy/DEPLOY.md](../deploy/DEPLOY.md) | Current | The self-hosting kit, and where Markie Cloud's deploy lives |
| [live-docs-hosting.md](live-docs-hosting.md) | Current | Serving Live Docs (`.wd` documents) from the server |

## Product and features

| Doc | Status | What it is for |
| --- | --- | --- |
| [document-workspace.md](document-workspace.md) | Current | How documents, formats, the Library and recovery work in the app |
| [FONTS.md](FONTS.md) | Current | The bundled fonts, their registry and how to rebuild them |
| [live-docs-area.md](live-docs-area.md) | Reference | The Live Docs area on the Mac as built in step M3, behind the nightly gate |
| [security/document-vault.md](security/document-vault.md) | Reference | The vault's encryption, threat model and limits |
| [superpowers/specs/2026-10-18-word-processor-product.md](superpowers/specs/2026-10-18-word-processor-product.md) | Reference | The word processor product contract. Task status is in Circular |

## Phone app

| Doc | Status | What it is for |
| --- | --- | --- |
| [apps/mobile/README.md](../apps/mobile/README.md) | Current | The Capacitor app (Markie Docs): run, build, test, sign-in, files, ship checklist |
| [mobile/STORE-SETUP.md](mobile/STORE-SETUP.md) | Current | Where the app stands with the App Store and Play, and what is left |
| [mobile/PUSH.md](mobile/PUSH.md) | Current | Push notifications for comments |
| [mobile/AGENT-LINKS-CONTRACT.md](mobile/AGENT-LINKS-CONTRACT.md) | Reference | The approved contract for agent links and the phone app |
| [apps/mobile/ios/App/CapApp-SPM/README.md](../apps/mobile/ios/App/CapApp-SPM/README.md) | Reference | Capacitor's generated Swift package note. Do not edit |

## Decisions, design and measurements

| Doc | Status | What it is for |
| --- | --- | --- |
| [decisions/2026-09-01-local-assets.md](decisions/2026-09-01-local-assets.md) | Reference | How local pictures, video and files are handled, shipped in 40e3b6f |
| [decisions/2026-10-14-original-document-engine.md](decisions/2026-10-14-original-document-engine.md) | Reference | Why the Office engine is original, and its provenance rules |
| [design/radius-scale.md](design/radius-scale.md) | Reference | The three corner radii |
| [perf/README.md](perf/README.md) | Reference | How to run the performance baseline, and the 0.5.4 numbers |

## Test guides

| Doc | Status | What it is for |
| --- | --- | --- |
| [document-testing/README.md](document-testing/README.md) | Current | Desktop test guide for the document features |
| [document-testing/document-types.md](document-testing/document-types.md) | Current | Checks per format: RTF, ODT, DOCX, text, CSV, legacy |
| [document-testing/editing-and-recovery.md](document-testing/editing-and-recovery.md) | Current | One workspace, saving versus recovery, the vault |
| [document-testing/everyday-writing.md](document-testing/everyday-writing.md) | Current | Mixed formatting, input and DOCX paragraph edits |
| [document-testing/darkmown.md](document-testing/darkmown.md) | Current | Interactive Darkmown checks |
| [document-testing/agent-documents.md](document-testing/agent-documents.md) | Current | Checks for documents written by agents |
| [document-testing/media-and-links.md](document-testing/media-and-links.md) | Current | Media viewers and web link previews |
| [document-testing/linked-sign-ins.md](document-testing/linked-sign-ins.md) | Current | Linked Google and Apple sign-ins and cloud areas |
| [document-testing/connected-documents.md](document-testing/connected-documents.md) | Current | Acceptance areas that are still open |
| [document-testing/samples/Rich-document.md](document-testing/samples/Rich-document.md) | Reference | Test sample |
| [document-testing/samples/Media-and-links.md](document-testing/samples/Media-and-links.md) | Reference | Test sample |

## Agent and code notes

| Doc | Status | What it is for |
| --- | --- | --- |
| [mcp/skills/markie-conventions/SKILL.md](../mcp/skills/markie-conventions/SKILL.md) | Current | The skill the Markie MCP hands agents: where documents belong, how to write them |
| [src/lib/darkmown/vendor/README.md](../src/lib/darkmown/vendor/README.md) | Current | The pinned Darkmown compiler and how to rebuild it |
| [src/lib/office/fixtures/README.md](../src/lib/office/fixtures/README.md) | Reference | Provenance of the Office test font |

## Archived

| Doc | Status | Why |
| --- | --- | --- |
| [archive/2026-06-12-markie-upcoming-features.md](archive/2026-06-12-markie-upcoming-features.md) | Archived | June roadmap. Public links and the MCP shipped; the terminal plan was never picked up |
| [archive/2026-10-14-document-platform.md](archive/2026-10-14-document-platform.md) | Archived | Its formats shipped in 0.9.0. Replaced by the word processor product contract |
| [archive/2026-10-30-doc-features-nightly.md](archive/2026-10-30-doc-features-nightly.md) | Archived | Phase plan for the Electron super-nightly, a lane that now carries the Rust app on the Mac |
| [archive/2026-11-19-apple-sign-in.md](archive/2026-11-19-apple-sign-in.md) | Archived | Shipped in 0.9.7. See the linked sign-ins checks |
