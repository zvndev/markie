# Markdown styles and the font library

Electron Markie gained Markdown style profiles (zvndev/markie#150) and a font library (#151) on 2026-11-23. This is how Markie RS carries both. Branch `t3/markie-rs-styles-fonts`, from `rust/markie-rs` at a55cbae.

## One source for both apps

The lists that must not drift are generated from Electron's own modules, never typed twice:

```sh
MARKIE_ELECTRON_SRC=<electron checkout> node rust/scripts/export-styles-fonts.mjs
```

| File | What it holds |
|---|---|
| `rust/crates/markie-core/data/fonts.json` | The 26 bundled families (ids, names, files, sizes, SHA-256, licenses), the nine system faces and the group labels |
| `rust/crates/markie-core/data/markdown-style.json` | Preset ids, every choice and its options, every number and its range, the six presets, the editor's groups and labels, and the CSS rules of each option |
| `rust/crates/markie-core/data/markdown-style-golden.json` | What Electron's functions answer for a set of styles and stores. The Rust tests hold every function to it |
| `rust/crates/markie-core/src/fonts/files.rs` | The embedded font files and license texts |
| `src/assets/fonts/` | The font files themselves, the same bytes Electron ships |

Run the script again when Electron adds a family, an option or a preset. Never edit the JSON by hand.

## Fonts

- The files are Electron's woff2 files. CoreText reads woff2 and lists every named weight of a variable font as its own face, which GPUI's font matching needs. So at launch the files are written once to `<data folder>/fonts` and registered with CoreText for this process only (`kCTFontManagerScopeProcess`). Nothing is installed and no system font folder is touched.
- CoreText files seven of the families under the name of their default instance ("Source Sans 3 ExtraLight"). `fonts::native::native_name` keeps the name it reports, and `fonts::native_family` answers with it.
- A font from this computer is stored as `local:<bundled id>:<family>`, the shape Electron stores. Where the font is missing, the bundled face in the id is drawn.
- The code font chosen on this computer is the setting `fonts.v1` (`{"codeFont": id}`, Electron's `markie.fonts.v1`). It never enters the theme store, so it never syncs.
- Office stand-ins (Carlito, Caladea, Arimo, Tinos, Cousine, Gelasio) are used only when the real font is not installed (`fonts::office_native_family`). The name in the file is never changed.
- A Word file's embedded fonts (`word/fonts/*.odttf`) are read by `markie_office::docx::fonts`, loaded into GPUI's memory font source, and kept in the file byte for byte on save.
- PDF export unpacks the woff2 files to TrueType for Typst (`pdf_world::woff2_to_ttf`).

## Styles

- `markie_core::markdown_style` is the schema, the presets, the cleaner, the store transitions and the export stylesheet.
- `ThemeStore.markdownStyle` carries the account's styles in the JSON shape Electron writes, so `GET` and `PUT /api/me/themes` sync them both ways.
- Fonts are layered as `findTheme` lays them: the template's, then the style's, then the person's own (a Typography choice, this computer's code font).
- The renderer reads the style through `markie_editor::md`, which turns each option into the numbers its CSS rule means. Spacious answers what the renderer always drew.
- A pinned look is `markie_core::theme::pinned_look`: checked colours, the owner's style, and one set of faces for every reader, in either mode.

## Drawing the gallery

```sh
G=<your worktree>/.autoloop/runs/styles-fonts
python3 rust/scripts/screen/scene/style-gallery.py jobs $G $S/jobs.json     # then shoot.mjs, as SCREEN.md says
python3 rust/scripts/screen/scene/style-gallery.py rs $G                    # needs the scene build
python3 rust/scripts/screen/scene/style-gallery.py build $G                 # writes $G/gallery and $G/GALLERY.md
```

Each sheet is Electron's editing view, Markie RS, and Electron's read view, for one preset and tone.

## Different from Electron on purpose

- **Pictures in the editing view.** Electron's editing view ignores a style's picture placement and captions, because its selectors do not match TipTap's picture nodes. Its read view and its exports draw them. Markie RS draws them in View, as the read view does.
- **A pinned look shows in either mode.** Markie RS used to paint an owner's pinned theme only in the mode its background belonged to. It now paints it in light and dark, as Electron does.

## Not the same yet

- **Embedded Word fonts keep their own family name.** Electron loads them under a private alias for that page. Markie RS loads them into the process under the font's own name until the app quits.
- **Hyphenation.** A justified paragraph is spread to both edges but not hyphenated.
- **Small caps** use the font's own small capitals. Chromium draws scaled capitals when a font has none.
- **Link underline on hover** (Spacious's own link look) is still not drawn.
- **PDF export** applies fonts, spacing, headings, paragraphs, lists, quotes, code blocks, dividers, links and table borders, header and width. It does not yet apply inline code style, task style, picture options, table density, list indent or the space between list items. No style PDF was compared with Electron's.
