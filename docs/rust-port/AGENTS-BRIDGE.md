# Markie RS: local agents, remote tokens, and Skills

Scope: PARITY.md sections 15 and 16. Reference: Electron Markie 0.9.7 and its source. This is a side build, not a cutover. No MCP client configuration is changed by Markie RS.

## Connect a local MCP client

1. Build the local macOS bundle with `rust/scripts/bundle-mac.sh` and open **Markie RS**.
2. In its activity rail, open **Connect an agent (MCP)** and copy the setup for your client. It points to the RS bootstrap, not the Electron app. Node 22.15 or newer must be on the client's PATH.
3. Apply the setup yourself if you want the connection. Keep Markie RS running. A stopped RS instance is never replaced by Electron, and this setup does not auto-launch RS.

Example for Claude Code, using the absolute path of a bundle you built:

```sh
claude mcp add markie-rs -- node '/absolute/path/Markie RS.app/Contents/Resources/markie-rs-mcp.mjs'
```

Example for Codex, in the configuration of the client you intend to connect:

```toml
[mcp_servers.markie-rs]
command = "node"
args = ["/absolute/path/Markie RS.app/Contents/Resources/markie-rs-mcp.mjs"]
```

For a scratch app, set the same absolute `MARKIE_RS_DATA_DIR` in the MCP process environment. A source checkout can run `rust/crates/markie-agent/mcp/markie-rs-mcp.mjs` instead of the bundled entry. Its default source is the checkout's unchanged `mcp/markie-mcp.mjs`. The optional `MARKIE_RS_MCP_SERVER` must name a compatible Node server file; the bootstrap rejects source it cannot safely adapt.

The socket is `<RS data>/agent/markie-rs.sock`, and discovery is `<RS data>/agent/agent-bridge-a65.json`. The directory is mode 0700 and the socket and discovery file are mode 0600. The file carries a per-launch credential; do not inspect or paste it. If a very long scratch path exceeds the macOS Unix socket path limit, use a short path under `/tmp`. Use the RS bootstrap, not an unadapted `node mcp/markie-mcp.mjs`, which defaults to Electron discovery.

## Section 15: bridge, MCP, and remote agents

| Item | Status and reason | Verification |
| --- | --- | --- |
| Claude, Codex, and other local clients | **Matches** the stdio MCP contract. **Differs** in setup name, bootstrap path, manual-only setup, and no launch fallback. The 520 px Agents dialog has setup blocks, tool list, Cloud permission and Projects conventions. It uses GPUI widgets and does not reproduce the Electron dialog pixel for pixel. | Node MCP interop; RS dialog capture |
| Find/search/read/write, Markdown aliases, skills listing, Markdown and Darkmown checks, and guide | **Matches:** same Node MCP source and tool schemas. Only local app discovery and open dispatch are adapted. Existing filesystem guards and read-only Office handling remain. | `node-lib.log`: reference Node suite, 116 passed; `crate.log`: stdio integration |
| Unix discovery and authenticated one-request JSON framing | **Matches** the envelope, method names, token shape, argument/result framing, errors and Electron discovery schema. **Differs** in socket location and filename, single owner per RS data folder, byte-based 64 KiB cap, and bounded concurrent connections. Windows bridge remains off. | Real `mcp/agent-client.mjs` and `mcp/lib.mjs`, scratch socket modes, duplicate start, bad credentials/JSON/method, oversized and fragmented frames; `crate.log` |
| `cloud_status` | **Matches** local response and linked document metadata shape. **Differs** in this checkout: uses the agent's own temporary registry binding, not records created through the separate Cloud UI lane. | Running app local request in `app-smoke.log`; mock linked result in `crate.log` |
| `cloud_sync` | **Matches** syncable types, size cap, private response/link, first-write agent attribution, optimistic version and conflict handling. **Differs** in UI integration: agent binding is separate and the current default is Markie Cloud; shared account scope/asset sync are pending integration. | In-memory session and mock PUT success/conflict; `crate.log` |
| `cloud_public_link`, `cloud_revoke_public_link` | **Matches** GET, explicit create after native confirmation, DELETE, owner refusal, and the Live Doc rule including an existing-link warning. No “always allow” path to public creation. The record lookup has the same shared Cloud binding gap as sync. | Mock HTTP read/confirm boundary/create/revoke and Live Doc refusal; `crate.log` |
| Native consent and `agent-permissions.json` | **Matches** asking until permission is granted, persistence as `{"cloudSync":"always"}`, revocation in Agents, and separate public confirmation. **Differs** in native prompt controls: a third Always Allow button instead of Electron's checkbox. IPC is replaced by direct GPUI calls. | Persistence/revocation/corruption test; Agents capture. No live upload |
| `history_note_write` | **Matches** accepting a hash announcement for an existing or future file and attributing the matching version without doing the write for the agent. | Real Node transport and live app acknowledged the scratch announcement; `crate.log` and `app-smoke.log` |
| `comments_list`, `comments_add`, `comments_reply`, `comments_resolve` | **Matches** the stable 0.9.7 gate: each returns the stable “nothing was saved” error. **Not built:** super-nightly local comment storage and anchor UI, which must ship together before this gate is lifted. | Real Node agent-client and stdio tests; running app list refusal |
| `markie_open_in_markie` | **Matches** opening the guarded, existing document in the requested desktop app and raising its window. **Differs** intentionally: use the RS socket, not an Electron app name or system association; the RS app must already be running. | Scratch Node tools test and running app opened the scratch skill; `app-smoke.log`, `rs-opened-skill.png` |
| Remote agents and `GET` / `POST` / `DELETE /api/agent-tokens` | **Matches** the hosted API, token name limit, list/create/revoke, idempotent revoke, and hosted setup snippets. The hosted MCP and its permissions remain server-owned. **Differs** in the GPUI token UI: fresh secrets are copy-only and memory-only. The merged shell still has a sign-in stub; live sign-in and selected self-hosted origin need account-lane integration. | Mock token lifecycle; no production calls or real tokens |
| Node runtime and packaging | **Differs:** macOS side build includes the unchanged MCP source and RS bootstrap, and expects system Node just as the setup instructs. No embedded Node binary. Linux bundle and Windows GUI were not exercised. | `bundle-final.log` and stdio tests |

The parallel Cloud lane owns the canonical document binding and the authenticated server scope. When it lands, have the app dispatch fetch/persist via that workspace's `cloud.bindings` and `store_binding`, use its selected/account-scoped client, and refresh Cloud/library state after a successful write. Remove the temporary `agent-cloud:` settings namespace after migrating any test bindings; do not run two registries for the same workflow. Use the same active scope for the Remote agents dialog. Keep the agent attribution on initial PUT and keep both native confirmation gates in the app.

## Section 16: Skills and agent files

| Item | Status and reason | Verification |
| --- | --- | --- |
| Skills, instructions, commands, subagents, memory and other files grouped by Claude, Codex, Cursor, Gemini, Universal | **Matches** the grouping, cache exclusion, single representative per skill folder, skill-first order, default collapse of other kinds, and label/path/description filtering. **Differs** in visual treatment and depends on the existing RS scan; some tool-specific non-Markdown rules are not indexed. | Scratch catalog and tool groups in `crate.log` |
| Descriptions from SKILL.md front matter | **Matches** common plain, quoted, and folded/literal block descriptions without a YAML runtime. Rare YAML escape/chomp cases may differ. | Scratch folder with folded and quoted descriptions; `crate.log` |
| Opening agent files | **Matches** opening an indexed file in the editor. **Differs:** full-path toggle is per view, active styling, star and Finder shortcuts are not implemented. | Running app opened the scratch skill; Skills view uses the same open path |
| Move an installed skill to Trash / `skills-trash` | **Matches** native confirmation, real parent equal to a supported skills root, and recoverable Trash instead of deletion; project/nested/outside folders cannot be removed. **Differs:** direct Rust call instead of IPC. | Direct, nested, project and symlink guards in `crate.log`. Actual host Trash mutation not exercised |
| Registry `skill_sources`, `skill_installs` | **Not built:** the installed Skills pane derives rows from the device index. The Electron catalog registry and marketplace flow are not ported here. | No test |

## Verification evidence

All evidence is local and ignored by Git under `.autoloop/runs/agents-bridge/`. `workspace-final.log` records 669 Rust tests passed and one intentionally ignored Keychain test. `crate.log` contains the focused bridge, guarded paths, permission, skill and fake-server test results. `node-lib.log` is the unchanged Node unit/stdio suite, run with a scratch HOME. `app-smoke.log` and `rail-app-relaunch-smoke.log` record live RS interoperability before and after the rail integration. No credentials were printed. `rs-agents-dark.png` and `rs-opened-skill.png` show the initial app run using only the two scratch documents. The merged app answered the live smoke and reported its window title as `SKILL.md`; the screen tool could not capture that window, so there is no new rail visual verdict.

The Electron scratch launch exited before creating a window: the invoking environment inherited `ELECTRON_RUN_AS_NODE` and refused `--user-data-dir`. I did not retry because Electron's index can see the real home even under a scratch profile. No Electron screenshot was taken, no library list opened or captured, and no Electron bridge contacted. No visual equivalence verdict or live signed-in Cloud parity is claimed. The native RS bundle was launched by PID using the shared screen lock, with synthetic content only.

## After Phase 6: Rust MCP port plan

1. Treat the Node tool schemas, guide, stdout envelopes and fixtures as the contract. Replay the Node and future Rust implementations against the same MCP transcripts, clocks, scratch paths and socket.
2. Implement a separate Rust stdio binary in this workspace. Reuse Markie's formats guard, index, text extraction, file creation, and asset checks where they match the existing behavior. Keep only the app running under its own identity responsible for Cloud and consent.
3. Port file tools first, then guide/resources, check tools, attribution and bridge methods. Keep the Darkmown compiler adapter until its diagnostics and resource limits are proven compatible. Add symlink, format ceiling, request limit and closed-app regression tests to the parity gate.
4. Compare resolver behavior, writes, search ordering, latency and cancellation on macOS/Linux and supported local tools on Windows. Only then replace the bundled Node/bootstrap pair while preserving manual setup and the existing Electron release path.
