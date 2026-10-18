# Private Super-nightly releases

This is a separate, owner-authorized macOS distribution lane. It does not change
the stable/beta manifest, source version, normal builder configuration or public
release runner. It never pushes Git, creates a tag/GitHub release, invokes a CI
workflow, or uploads to public storage. Publication is only to the dedicated
authenticated private gateway. A private build is not DRM for public source or
independently built derivatives.

## Configuration and provenance

`electron-builder.private.cjs` derives the real Markie bundle configuration, but
removes every publishing target and extra resource (including the independently
launchable MCP server). It retains the normal app identity, hardened runtime,
Developer ID signing, notarization and native renderer launch preflight. The
wrapper passes only `--config electron-builder.private.cjs --mac --publish never`;
it accepts no arbitrary builder arguments or public fallback.

Set these non-secret values in the root agent's process:

- `MARKIE_PRIVATE_API_ORIGIN`: required exact origin
  `https://markie-super-nightly-production.up.railway.app`. A future gateway
  change requires an explicit reviewed tooling change; arbitrary HTTPS hosts
  cannot receive the publisher key.
- `MARKIE_PRIVATE_VERSION`: for example `0.8.1-super-nightly.1`. This changes only
  packaged `extraMetadata`, never source versions or public manifests.
- `MARKIE_PRIVATE_ARCHS`: `arm64` by default for the first private cut on the
  owner's ARM Mac. Other explicitly selected architectures require their own
  packaging and native verification evidence.
- `MARKIE_PRIVATE_SIGNING_TEAM_ID` (or `APPLE_TEAM_ID`): required reviewed
  10-character uppercase/digit Developer ID team. If both are set they must
  agree. This is a public certificate attribute, not owner authorization or a
  credential, and is not added to the packaged private marker.
- `MARKIE_PRIVATE_OUTPUT_DIR`: optional absolute directory outside the public
  repository. The default is the already-ignored
  `.release/private-artifacts/<version>`. Paths through symlinks and other
  repository destinations are rejected.

Every build/verify/publish requires clean exact-commit source. The packaged
`markiePrivateRelease` marker contains exactly `channel: "super-nightly"`,
`apiOrigin`, `gitCommit`, `gitDirty: false` and `version`. The build config records
the full 40-character source commit; verification must match that source and
version. `MARKIE_PRIVATE_GIT_COMMIT`, if supplied, must also match checkout HEAD.

Owner identity and publisher credentials are server-side only. Do not put them
in source, fixtures, frontend `VITE_*` settings, packaged metadata or updater
configuration. The root agent supplies signing/notary credentials privately;
this script does not load or print dotenv contents. The renderer subprocess
does not inherit owner, publisher, token or password variables. The builder
retains only signing-specific credentials among those sensitive variables.

## Root-agent execution

Only the explicitly authorized root agent executes signing/notarization,
publication and local installation. Child implementation/tests do none of them.
After committing and reviewing the intended private source locally, exporting
the non-secret settings above and privately supplying signing/notary credentials:

```sh
node scripts/private-release.mjs build
node scripts/private-release.mjs verify
```

`build` requires an empty dedicated output directory, builds the renderer, then
packages/signs/notarizes through the private builder config. It writes a custom
`super-nightly-mac.yml` from the resulting ZIP hashes and sizes because no
electron-builder publishing target is configured. It then performs the same
verification as `verify`. Each declared architecture requires a ZIP. This first
private lane is ZIP-only: DMG targets, feeds and uploads are refused, as are
DMGs found in the private output directory. The root installs the fully verified
app extracted from its ZIP. Do not repurpose a stable or beta artifact/feed as a private
build. If a root-controlled signing/archive procedure creates the final ZIP
separately, `createPrivateFeed(settings)` is the exported feed-generation seam;
it does not bypass `verify`.

The gateway publisher key is read only from `MARKIE_PRIVATE_PUBLISH_KEY` in the
root process. After server/account authorization, artifact trust checks and
independent security review have passed, the authorized root may execute:

```sh
node scripts/private-release.mjs publish-private
```

No key appears in command arguments or result output. The uploader has a closed
destination: `<apiOrigin>/private-releases/super-nightly/:filename`. It sends
versioned immutable ZIP/blockmaps first (`If-None-Match: *`), then promotes
`super-nightly-mac.yml` last. Every PUT carries `x-markie-publish-key`, base64
`x-markie-sha512` and exact `Content-Length`; every payload is bounded by the
gateway's 512 MiB limit. Redirect following and ambient browser credentials are
disabled. A failed artifact upload or changed local bytes stops before feed
promotion. The server independently enforces immutability and validates all
feed artifact hashes/sizes before atomic feed replacement. GET access to both
the feed and every artifact requires authorized account access; there is no
public redirect or public object-storage destination.

## Verification boundary

The private pre-sign hook and final ZIP verification inspect actual `app.asar`
contents and unpacked native dependencies, not merely include globs. Every
unpacked file must correspond to an ASAR entry explicitly flagged unpacked;
unindexed files and unexpected `app.asar*` siblings fail verification. All
unpacked payloads receive the same filename and sensitive-content checks. Only
`package.json`, `electron/`, `out/` and the resolved production dependency graph
are allowed. Dotenv files, tests, source maps, credential files, unexpected
application roots, Git-ignored Electron source inputs, credential patterns and
configured forbidden values are rejected. The private generic `app-update.yml`
must contain only the authenticated gateway URL and private channel; it never
contains an owner ID or token. No extra MCP/server/source resources are included.

The scanner automatically checks nontrivial sensitive environment values. To
include additional known owner identifiers in the scan, the root may privately
set `MARKIE_PRIVATE_SCAN_FORBIDDEN_JSON` to a JSON string array; values are never
logged. Pattern scanning cannot prove absence of every possible encoded secret,
so it supplements the closed include set and independent review.

Before extracting a ZIP into a fresh temporary directory, verification bounds
entry counts/expanded size and rejects escaping paths or symlinks. It inspects
the extracted bundle, checks its marker/version, runs strict deep signature
verification, requires Developer ID Application authority with the exact
reviewed `TeamIdentifier`, checks Gatekeeper and validates the notarization staple.
All file SHA-512 hashes and sizes are checked against the private feed and
rechecked immediately before each upload. Verification never signs/notarizes
an artifact or publishes anything itself.

Tests exercise config separation, destination/provenance/output guards, a real
ASAR fixture, credential/inclusion checks and mocked feed-last uploads:

```sh
npx vitest run scripts/private-release.test.ts
npx eslint electron-builder.private.cjs scripts/private-release.mjs scripts/private-release.test.ts
```

Those tests do not establish a valid Developer ID artifact, notary acceptance,
owner-only gateway authorization, a successful installed app/update or native
Windows distribution. The root records that separate exact-artifact evidence.
