# Pinned Darkmown browser artifacts

Markie uses its own first-party Darkmown compiler and runtime, pinned to the commit
in `PROVENANCE.json`. This is not an Office document engine. The generated compiler
targets `src/compiler/page.js:compileFromMemory`, never Darkmown's Node-facing
package barrel, CLI, project configuration, server or arbitrary colocated scripts.

Normal Markie builds are offline and use these committed files. To reproduce them,
use a clean Darkmown checkout at the recorded commit with its locked development
dependencies already installed:

```sh
node scripts/build-darkmown-vendor.mjs --source /path/to/darkmown --check
```

Omit `--check` only when intentionally regenerating reviewed artifacts. No source
path is retained in the runtime bundle. The script records every bundled input's
SHA-256, dependency versions, exact bundler version, source lock hash and output
hashes. The compiler uses Darkmown's existing first-party POSIX path and scope-id
hash browser shims. The latter is deterministic FNV-1a, not cryptographic SHA-256.

`runtime.js.txt` is data imported as raw text, not an app-level executable module.
The generated Electron policy pins its exact CSP hash. A separate reviewed
`local-form-bootstrap.js.txt` routes local button/Enter gestures into the existing
runtime's form handler while native sandbox form submission remains prohibited.
It also accepts an exact parent-only light/dark appearance message, with no
document state, commands, credentials or replies. Its SHA-256 is pinned separately
in that policy and recorded as a host adaptation in provenance; it is not an
upstream runtime change. Both compiler output and
the original trusted-author runtime require Markie's separate preview policy:
they do not sanitize HTML, authorize network access, grant filesystem access or
provide a credential store. Runtime state is not document source.

The preview compiler runs in a disposable worker, never as a synchronous renderer
fallback. The initial single-file host subset rejects active loops/includes,
computed `+` (including numeric addition, until a typed value budget is available)
and interpolation formatter pipelines before compilation. It also limits source
to 128,000 characters / 5,000 lines, applies a conservative source-length times
binding/declaration complexity budget of 1,000,000, bounds output and stops the
worker after ten seconds (including cold startup) or cancellation. These are preview limits, not edits
to authored source or claims that Darkmown itself lacks those language features.

Full upstream and bundled dependency licenses are in `THIRD-PARTY-NOTICES.txt`.
The notices and provenance are also generated into `public/darkmown/` so packaged
desktop builds distribute them, independently of JavaScript tree-shaking.
