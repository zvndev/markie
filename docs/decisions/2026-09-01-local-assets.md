# Local images, video and files in Markie

**Status:** shipped in 40e3b6f, all four decisions **Date:** 2026-09-01

Everything below was measured against the running app, not read off the source. Where I say something is broken, I watched it break.

---

## The short version

The advice you got in the other chat was wrong in a way that matters: it says Markie has
no sanitizer and that base64 data URIs "go straight through". Markie does sanitize, and
data URIs are the one form that fails in **both** places. Relative paths, the form that
chat replaced, are the form that already works in every export.

So the two client reports that were rewritten to inline their screenshots now have images
that render **nowhere**: not in Markie, and not in the PDF you would send a client. That
is worth fixing today, and it is two lines.

---

## What actually happens now

I opened a document with a relative image, an inlined image and a relative link, in a real
window, and read the DOM.

| In the document | Rich view | Export HTML / PDF / Print | Public share |
| :-- | :-- | :-- | :-- |
| `![](demo/shot.png)` | **broken image** | **works** | broken |
| `![](data:image/png;base64,…)` | **dropped entirely** | **stripped** | stripped |
| `![](https://…/shot.png)` | works | works | works |
| `[spec](spec.pdf)` | **dead click** | n/a | n/a |
| any video | not supported | not supported | not supported |

Four separate causes, all confirmed:

- **Relative paths in the app.** The renderer's origin is `app://markie/`, so
  `demo/shot.png` resolves to `app://markie/demo/shot.png`. The handler in
  `electron/main.js:772` serves only from the bundled `out/` directory and returns 403
  for anything else. This part of the other chat's diagnosis was right.

- **Data URIs in the app.** Nothing to do with the CSP, which does allow `data:`. It is
  `@tiptap/extension-image`: `allowBase64` defaults to `false`, and when it is false the
  extension's own parse rule is literally `img[src]:not([src^="data:"])`. TipTap throws
  the image away before it ever reaches the DOM. I watched the paragraph come out empty.

- **Data URIs in exports.** `src/lib/markdown-html.ts` runs `rehype-sanitize`, and
  `defaultSchema.protocols.src` is `["http", "https"]`. The `src` attribute is removed
  and an `<img alt="…">` with no source is emitted. This is the claim the other chat got
  backwards.

- **Relative paths in exports already work**, and have for a while.
  `electron/inline-images.js` folds a document's local images into data URIs at export
  time, and both `export-html` and the PDF exporter use it. It is careful work: realpath
  on both sides so a symlink cannot escape the folder, an extension allowlist, 10 MB per
  image and 30 MB per document.

- **Local file links.** TipTap renders links with `target="_blank"`, so a click goes to
  `setWindowOpenHandler`, which only forwards `http(s)` and denies everything else. A
  relative link to a PDF does nothing at all. It does not break the window, it just
  silently ignores you.

The shape of the problem, then, is not "Markie cannot do local files". It is that the
export path solved this properly and the viewer never got the same treatment.

---

## What I recommend

### 1. Relative paths are the supported way to reference an asset. Fix the viewer.

This is how every other markdown tool behaves and it is what an agent writing a report
will produce without being told. It also keeps the `.md` readable as text, which a 600 KB
base64 blob does not.

Add a `markie-asset://` scheme, registered alongside `app://`. The renderer rewrites
relative image sources against the open document's directory **at display time only** so
the file on disk is never modified. Main resolves, containment-checks and serves.

The containment rule is not new, and that is the point: it is the same rule
`inline-images.js` already enforces for exports, moved into a shared module so the viewer
and the exporter cannot drift apart.

- resolve the path, then `realpath` both it and the document's folder, so a symlink
  inside the folder cannot point at `~/.ssh`
- the result must be strictly inside the document's own folder
- extension allowlist (`png jpg jpeg gif webp svg`), never content sniffing
- the existing size caps

Then `img-src` gains `markie-asset:`.

**What this deliberately refuses:** anything outside the document's folder. Open a
markdown file someone sent you and it cannot reach a single other file on your disk. It
could not exfiltrate one anyway (a document carries no script, and `connect-src` is
locked to Markie's own API), but it could quietly embed a picture from your Desktop into
a document you then export and send to a client. Contained-to-folder removes that
outright, and it costs nothing real.

### 2. Make data URIs work in both places, so the documents you already have are fixed.

Two changes, both small:

- `Image.configure({ allowBase64: true })` in `src/lib/rich-extensions.ts`
- add `data:` to the sanitize schema's `src` protocols in `src/lib/markdown-html.ts`

Risk is low. An SVG data URI cannot execute script when it is loaded through `<img>`,
`img-src data:` is already in the CSP, and the share renderer sets the same policy.

This is worth doing on its own merits even after (1) lands: it is the format a document
arrives in when someone hands you a self-contained file, and right now Markie is the one
viewer that cannot open it.

Relative paths stay the recommended way to author. Inlining is for when the file has to
travel alone, which is what Export already does for you automatically.

### 3. A link to a local file should open it in the Finder's default app.

`[spec](spec.pdf)` resolves against the document's folder, gets the same containment
check, and goes to `shell.openPath`. Not `shell.openExternal`, which would honour
arbitrary schemes. If it fails the check, say so rather than doing nothing, because a
dead click reads as a broken app.

### 4. Video: not yet, and here is the shape it would take.

I would leave this alone until you actually want it, and the reason is specific rather
than squeamish. Markdown has no video syntax, so supporting it means either allowing raw
HTML through the pipeline, which is the app's main security boundary and is currently
closed on purpose, or inventing a Markie rule where `![](clip.mp4)` becomes a `<video>`.
The rule is the right answer if we do it, plus `media-src markie-asset:` in the CSP and a
new node in the sanitize schema.

The awkward part is exports. A self-contained HTML file with a 50 MB video inlined as
base64 is not a document anyone can email. So video would have to be the one asset type
that deliberately breaks when the document leaves the machine, and that inconsistency
wants a conscious decision rather than being discovered by a client.

---

## The one thing this left out, and what was done about it

The draft scoped everything to the document's **own folder**, which would have left a
repository that keeps `docs/report.md` alongside a top-level `assets/logo.png` showing a
broken image, because `../assets/logo.png` climbs out.

That was widened before shipping, on your "more richness is better", and widened in both
the viewer and the exporter at once so they cannot disagree: a document may reach the
folder it was opened from, **and** any of your workspace roots. Nothing else. The
workspace root is already the boundary the app uses to decide what it may read, so this
adds no new trust, and `electron/local-assets.js` is the only place that knows the rule.

Video was shipped as deferred, as recommended. It is the only one of the four that would
have added a new node to the sanitize schema, and the only one that cannot be inlined
into an export without producing a file nobody can email.

---

## Effort

| Decision | Where | Size |
| :-- | :-- | :-- |
| 2. data URIs | `rich-extensions.ts`, `markdown-html.ts` | ~2 lines plus tests |
| 3. file links | `main.js`, link handler | ~25 lines |
| 1. `markie-asset://` | `main.js`, `csp.js`, rich view, shared containment module | ~90 lines plus tests |
| 4. video | deferred | |

I would ship 2 first, on its own, because it un-breaks the two reports you already have.

Each of these gets a real-window check the way the Projects panel did, driving the actual
renderer and asserting the image loaded with a non-zero natural width, since every one of
these bugs is invisible to a unit test.
