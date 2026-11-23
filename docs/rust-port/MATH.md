# Markie RS: native math rendering

Date: 2026-11-21. Circular task ENG-8732, phase 2b. Crate: `rust/crates/markie-math`.

The rich editor needs to draw `$...$` and `$$...$$` without a webview. The crate turns the TeX a document holds into a standalone SVG. GPUI draws that SVG with `img()`.

## The pick

mitex converts LaTeX to Typst math. Typst lays it out with New Computer Modern Math and typst-svg writes the SVG. It is all pure Rust, with no system TeX, no network and no file access.

Why this one:

- It looks like KaTeX. Both use Computer Modern, so a formula in the native app matches the web app.
- It rendered every real formula KaTeX renders, in both corpora below.
- Typst is the most mature engine here. It has 4.3M downloads, active development and an Apache-2.0 license.
- It is fast enough to call every frame behind the cache: a median of 0.11 ms per formula on the Markie list.

The cost is size. A release binary that only renders math is 41.7 MB, against 3.0 MB for mathra. Typst embeds data the math path never uses (ICU, syntax highlighting, bibliography styles) and has no feature flags to drop it. The fonts are 7.7 MB of that.

The public API hides the engine. If size starts to matter more than the KaTeX look, mathra is the swap: change `render` and keep the tests.

### HTML export uses KaTeX's HTML instead

An exported HTML file is drawn by the reader's browser, which has the CSS engine GPUI lacks. So Export HTML does not use this crate. `markie-export` renders math with katex-rs, the KaTeX port in the table below, and embeds Electron's `KATEX_CSS` (KaTeX's stylesheet with 12 fonts as data: URIs). The page then draws exactly as Electron's export does: headless Chromium shows no differing pixel on a 44-formula fixture, light and dark (AUDIT-AGENTS-WEB.md row 23.3). markie-math still draws the editor's math and the PDF's, through Typst.

## Evaluation

Every engine ran on the same three input sets, scored against KaTeX 0.19.1 itself (the version the web app ships):

- **Markie list:** 98 formulas typical of Markie docs, from `tests/formulas.rs`.
- **KaTeX commands:** 1,023 probes, one per math-mode command and environment KaTeX defines, each in the first argument shape KaTeX accepts.
- **Real corpus:** 190 unique single-line math spans from 33,916 Markdown files under `~/Desktop`. KaTeX renders 47 of them.

| Engine | Output | Markie list | KaTeX commands | Real corpus (of 47) | Median time | Release size | Maturity |
|---|---|---|---|---|---|---|---|
| **mitex + typst (picked)** | SVG, glyphs as paths | 98/98 | 856 (83.7%) | 47 | 0.11 ms | 41.7 MB | typst 4.3M downloads, active. mitex 59k downloads, last release 2024-06. |
| mathra 1.12 | SVG | 98/98 | 905 (88.5%) | 47 | 0.03 ms | 3.0 MB | Created 2026-10-20, 2.1k downloads, one author. |
| latex-rust 3.0 | SVG | 87/98 | 551 (53.9%) | 42 | 0.05 ms | 2.4 MB | Created 2026-09-02, 23k downloads, one author. |
| mathjax-svg-rs 0.4 | SVG (MathJax in boa JS) | 88/98 | 306 (30%) | 47 | 5.2 ms | not built | Created 2026-04. Its worker thread dies after one async MathJax error, so every later call fails. |
| katex-rs 0.3 | KaTeX HTML | 96/98 | 1,020 (99.7%) | 47 | 0.02 ms | not built | Port of KaTeX, 212k downloads. HTML needs a CSS layout engine, which GPUI does not have. |
| katex 0.4 | KaTeX HTML (QuickJS) | not run | not run | not run | | | Last release 2023. HTML output, same problem as katex-rs. |
| pulldown-latex 0.8 | MathML | 98/98 | 1,023 | 47 | <0.01 ms | | Parses everything, including junk, so the score means little. GPUI has no MathML renderer. |

Notes on the table:

- The release sizes use the workspace profile (thin LTO, stripped). A hello world is 0.34 MB.
- mathra's command lead is smaller than it looks. About 20 of its extra wins are probe artifacts, such as `\bf` or `\displaystyle` with nothing after them. markie-math handles those in real use.
- mathra uses STIX Two by default, so it does not look like KaTeX. It has a `latin-modern` feature, untested here.
- mathra matched KaTeX's accept and reject decisions exactly on the corpus. markie-math accepted 8 junk spans that KaTeX rejects (see gaps).
- I compared six formulas side by side as PNGs from both SVG engines: integrals, matrices, cases, `aligned`, sized delimiters and accents. Both were correct. markie-math matched the KaTeX look.

## Corpus numbers

`cargo test --release -p markie-math --features corpus --test corpus`, with `MARKIE_CORPUS_DIR` set:

| Corpus | Files | Files with math | Math spans | Rendered | KaTeX-valid unique | markie-math on those |
|---|---|---|---|---|---|---|
| `~/Desktop/Coding/ZVN` | 26,156 | 76 | 361 | 115 (31.9%) | 41 | 41 (100%) |
| `~/Desktop` | 33,916 | 166 | 538 | 205 (38.1%) | 48 | 48 (100%) |

Time per formula that renders, release build, ZVN corpus: median 0.20 ms, p95 0.54 ms. The slowest was 8.3 ms, on a long run of prose the parser took for math. A failure costs about 4 µs, because mitex rejects it before Typst runs.

The low rendered share is not a renderer problem. Most spans the parser calls math are dollar signs in code, JSON and prices. KaTeX rejects them too. The real math in these folders is small, so the KaTeX command probe is the better measure of breadth.

## Public API

```rust
pub struct MathStyle { pub color: [u8; 4], pub font_size_pt: f32 }   // Default: black, 16pt
pub struct Rendered { pub svg: String, pub width_pt: f32, pub height_pt: f32, pub baseline_pt: f32 }
pub enum MathError { Empty, Convert(String), Typeset(String), Panic(String) }

pub fn render(tex: &str, display: bool, style: &MathStyle) -> Result<Rendered, MathError>;
pub fn strip_delimiters(source: &str) -> Option<(&str, bool)>;
pub fn to_typst(tex: &str) -> Result<String, MathError>;   // debugging

pub struct MathCache { /* Mutex<HashMap<(source, display, color, size bits), Arc<Result<..>>>> */ }
impl MathCache { pub fn new(capacity: usize) -> Self; pub fn get(&self, tex, display, style) -> Arc<Result<Rendered, MathError>>; pub fn len/is_empty/clear }
pub fn global_cache() -> &'static MathCache;
pub fn render_cached(tex: &str, display: bool, style: &MathStyle) -> Arc<Result<Rendered, MathError>>;
pub fn warm_up();
pub fn loaded_families() -> Vec<String>;
```

How it behaves:

- `strip_delimiters` accepts `$x$`, `$$x$$`, `\(x\)` and `\[x\]`. It trims whitespace and newlines inside the delimiters. It returns `None` for an empty body.
- `render` never panics. The whole pipeline runs under `catch_unwind`.
- `display` uses display style, like KaTeX `displayMode`.
- `baseline_pt` is measured from the top of the SVG. Line it up with the text baseline for inline math.
- The cache stores errors too. It clears itself when it reaches its capacity (2,048 for the global one).
- `warm_up` loads the fonts and the mitex scope. That takes 10 to 22 ms once per process. Later formulas cost about 0.1 to 0.4 ms.

## Drawing it in GPUI

GPUI's `Image::from_bytes(ImageFormat::Svg, bytes)` parses with usvg 0.46 and rasterizes with resvg 0.46 (`gpui-pre 0.3.12`, `svg_renderer.rs`). typst-svg writes glyphs as `<symbol><path>` plus `<use>`, never `<text>`, so no fonts are needed.

The SVG's `width` and `height` are in `pt`. usvg reads them as px times 4/3. Size the element from `width_pt` and `height_pt` converted to GPUI pixels, not from the image's natural size.

The tests prove the GPUI path:

- Every test formula is parsed with usvg 0.46 and checked for a non-zero size and no `<text>`.
- One formula is rasterized with resvg 0.46, built without its `text` feature (no font support at all). The test checks for opaque pixels in the requested color.

## How it works

- **Typst world** (`src/world.rs`): an in-memory world with the main file and the vendored mitex scope. It loads New Computer Modern Math, New Computer Modern (for `\text`) and DejaVu Sans Mono (for `\texttt`).
- **Main file** (`main_source` in `src/lib.rs`): the page is auto-sized with no margin. The text edges are `bounds`, so the SVG is tight to the ink. Display mode wraps the equation in `math.display`.
- **Baseline:** a labelled `metadata` marker follows the equation, then an empty box. The box keeps the marker inside the line. Typst places a zero-size inline item on the line's baseline, so the marker's position is the baseline.
- **Cache memory:** after each render, `comemo::evict(256)` bounds Typst's global memo cache.

## Changes to upstream code

mitex 0.2.4 was released before Typst 0.14 and 0.15 renamed several symbols. Out of the box, `\partial`, `\cap`, `\oplus`, `\langle`, `\hbar` and about 40 more commands failed.

- **`src/mitex_convert.rs`:** mitex's converter, vendored. Upstream `convert_inner` parses with the caller's spec but then looks every alias up in `DEFAULT_SPEC`. A custom spec could not change any output. The fix is two lines, marked `MARKIE PATCH`. Drop the file when mitex fixes it.
- **`src/spec.rs`:** rewrites old Typst names in the spec at startup. Examples: `sect` to `inter`, `diff` to `partial`, `angle.l` to `chevron.l`, `plus.circle` to `plus.o`. It also adds KaTeX commands the spec lacks: `\mathscr`, `\gtrapprox`, `\mapsfrom`, starred matrices, `dcases`, `drcases` and a few symbols.
- **`typst/mitex/`:** the Typst scope from the `@preview/mitex` 0.2.6 package (Apache-2.0, license included). Two patches, marked `MARKIE PATCH`: `\bra` and `\ket` use `chevron`, and `Vmatrix` uses a one-character delimiter.
- **`typst/markie/scope.typ`:** adds `\argmax` and `\argmin`, which the spec lists but Typst does not define.

The `coverage` test renders every command in the mitex spec, so a Typst upgrade that renames more symbols fails there.

## Tests

`cargo test -p markie-math` runs 14 tests, about 1 s once built:

- 98 Markie formulas render, and each SVG passes usvg. This includes the formulas from `markie-rich/interop/cases.json` and `tests/edit.rs`.
- Bad input gives clean errors.
- Baselines sit right for descenders and fractions. Display mode is taller than inline.
- Color and size apply.
- The cache hits, keys on style and stays bounded. Renders work from 8 threads at once.
- Rasterizing with resvg works.
- All 858 math commands in the mitex spec render.

Opt-in runs:

- **Corpus:** `MARKIE_CORPUS_DIR=... MARKIE_CORPUS_MAX=... cargo test --release -p markie-math --features corpus --test corpus -- --nocapture`. `MARKIE_CORPUS_DUMP=out.jsonl` writes every formula and result. The `corpus` feature keeps markie-rich out of the default build.
- **KaTeX probes:** run `node scripts/katex-probes.mjs <katex dir> > probes.tsv`. Then run the `coverage` test's `katex` case with `MARKIE_KATEX_PROBES=probes.tsv` and `MARKIE_KATEX_PROBE_DUMP=out.jsonl`.
- **Compare with KaTeX:** `node scripts/katex-compare.mjs out.jsonl <katex dir>` works on either dump.

## Known gaps

- **KaTeX commands not supported (167 of 1,023 probes):**
  - 28 KaTeX internals (`\@...`)
  - 56 Khan Academy color macros (`\blueA`, `\red{x}`)
  - HTML and link extensions (`\href`, `\url`, `\htmlClass`)
  - TeX primitives (`\def`, `\let`, `\edef`, `\gdef`). `\newcommand` works.
  - text accents (`\'`, `\~`)
  - overlap tricks (`\llap`, `\rlap`, `\clap`, `\smash`, `\mathllap`)
  - rare symbols and arrows (`\varlimsup`, `\underrightarrow`, `\utilde`, `\ngeqq`, `\gvertneqq`)
- **Lenient parsing:** mitex is looser than KaTeX. `x^` and an unclosed `\begin{pmatrix}` render where KaTeX shows an error. 8 junk spans in the corpus rendered as math that KaTeX would show in red.
- **No CJK or emoji in `\text{}`:** only the embedded fonts are loaded. Latin, Greek and Cyrillic work.
- **Lone `\\`:** a formula that is only a line break renders as an empty 1pt image.
- **Binary size:** 41.7 MB for a math-only binary. Vendoring only the four font files we use would save about 4.5 MB, but it puts binary fonts in git.
- **No timeout:** Typst has no time limit. Mitex rejects macro loops it can see, but a pathological formula could still be slow. The worst real one took 8.3 ms.
