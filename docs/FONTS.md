# Fonts

Markie ships 26 open-licensed font families: 20 offered for Markdown
documents, and 6 that stand in for Office fonts a computer does not have.
All of them are in the desktop app, in the server's web bundle and in the phone
app, so a document looks the same in each.

Everything about them is in one place, `src/lib/fonts/registry.ts`: ids, names,
kinds, CSS stacks and files. `TYPEFACES` in `src/lib/theme.ts` is that list.

## The library

| Family | Group | License | Version | Files | Size |
|---|---|---|---|---|---|
| Inter | Sans serif | SIL OFL 1.1 | 4.001 | 2 | 231 KB |
| Source Sans 3 | Sans serif | SIL OFL 1.1 | 3.052 | 2 | 147 KB |
| IBM Plex Sans | Sans serif | SIL OFL 1.1 | 3.201 | 2 | 124 KB |
| Space Grotesk | With personality | SIL OFL 1.1 | 2.000 | 1 | 35 KB |
| Atkinson Hyperlegible Next | Easy to read | SIL OFL 1.1 | 2.001 | 2 | 88 KB |
| Lexend | Easy to read | SIL OFL 1.1 | 1.007 | 1 | 55 KB |
| Nunito | Rounded | SIL OFL 1.1 | 3.602 | 2 | 120 KB |
| Quicksand | Rounded | SIL OFL 1.1 | 3.006 | 1 | 40 KB |
| Source Serif 4 | Serif | SIL OFL 1.1 | 4.004 | 2 | 154 KB |
| Literata | Serif | SIL OFL 1.1 | 3.103 | 2 | 179 KB |
| Lora | Serif | SIL OFL 1.1 | 3.008 | 2 | 96 KB |
| EB Garamond | Serif | SIL OFL 1.1 | 1.003 | 2 | 250 KB |
| Roboto Slab | Serif | Apache 2.0 | 2.002 | 1 | 41 KB |
| Fraunces | With personality | SIL OFL 1.1 | 1.000 | 2 | 116 KB |
| Playfair Display | With personality | SIL OFL 1.1 | 1.203 | 2 | 95 KB |
| Caveat | With personality | SIL OFL 1.1 | 2.000 | 1 | 84 KB |
| JetBrains Mono | Monospace | SIL OFL 1.1 | 2.211 | 2 | 92 KB |
| Fira Code | Monospace | SIL OFL 1.1 | 5.002 | 1 | 40 KB |
| Source Code Pro | Monospace | SIL OFL 1.1 | 1.026 | 2 | 90 KB |
| Atkinson Hyperlegible Mono | Monospace | SIL OFL 1.1 | 2.001 | 2 | 45 KB |

2.07 MB in all.

## Stand-ins for Office fonts

Each has the same letter widths as the font it stands in for, so lines and
pages break where they did in Word. A stand-in is used only when the real font
is not installed, because the real name always comes first in the CSS. It is
never written into a file: saving keeps the font name the document had.

| Family | Stands in for | License | Version | Files | Size |
|---|---|---|---|---|---|
| Carlito | Calibri | SIL OFL 1.1 | 1.104 | 4 | 263 KB |
| Caladea | Cambria | SIL OFL 1.1 | 1.001 | 4 | 71 KB |
| Arimo | Arial, Helvetica | SIL OFL 1.1 | 1.341 | 2 | 229 KB |
| Tinos | Times New Roman, Times | SIL OFL 1.1 | 1.340 | 4 | 227 KB |
| Cousine | Courier New, Courier | SIL OFL 1.1 | 1.241 | 4 | 160 KB |
| Gelasio | Georgia | SIL OFL 1.1 | 1.008 | 2 | 124 KB |

1.05 MB in all. The whole set is 3.12 MB.

## Where the files come from

Every file was built from the official Google Fonts repository,
`https://github.com/google/fonts`, at one pinned commit
(`scripts/fonts/sources.json`). Each family's own license text is beside its
files in `src/assets/fonts/<id>/LICENSE.txt` and ships in every build. The
Tinos folder at that commit carries no license file, so its text comes from the
foundry's repository, `googlefonts/tinos`, at the commit the folder names.

The files are variable woff2 where the family is variable, cut down to Latin
and Latin Extended, with every axis but weight dropped and TrueType hinting
removed. `src/lib/fonts/bundled-files.generated.ts` records each file's size and
SHA-256, and `src/lib/fonts/registry.test.ts` checks the files on disk against
it.

To add, remove or update a family:

1. Edit `scripts/fonts/sources.json`. Only SIL OFL 1.1 or Apache 2.0 families,
   and only from the repository above.
2. Run `python3 -I scripts/fonts/build-fonts.py` from the repo root. It needs
   Python 3 with `fonttools` and `brotli`.
3. Add or remove the family's entry in `FAMILY_META` in the registry.
4. Run `npm test`. Watch the renderer bundle budget in `.github/workflows/ci.yml`.

Never rename or reuse an id. Themes that people saved, synced and pinned to
shared documents name fonts by id.

## Fonts on this computer

On the desktop, and in a Chromium browser, Settings can list the fonts
installed on the computer. Choosing one stores an id of the form
`local:<bundled id>:<family>`. The family paints here. A shared link, the phone
or another person's computer shows the bundled face the id names.

## Fonts inside a Word file

A Word file can embed its fonts (`word/fonts/*.odttf`). Markie reads them
(`src/lib/office/docx-fonts.ts`), shows that document's text in them, and
carries them into its PDF and print output. They are loaded for the page only,
under a private name. They are never installed and never written to disk.
Saving keeps them in the file exactly as they arrived.

## What a font costs

A build declares every face and downloads none: a browser reads a font file
only when some text is set in it. An exported HTML file or PDF carries, inside
itself, only the families that document uses.

## Fonts in a Markdown style

A Markdown style (`src/lib/markdown-style.ts`) can name a face for text, for
headings and for code. Each built-in style but Spacious does. They are
defaults: a font chosen in Typography, or a code font chosen in Settings, is
used instead (`findTheme` in `src/lib/theme.ts` lays them in that order).

The ids a style may hold are written out in `src/lib/markdown-style-schema.ts`,
because the server checks a pinned style against a copy of that file. A test
holds the list to the registry. After adding or removing a family here, add or
remove its id there and run `(cd server && npm run markdown-style:sync)`.

A font from one computer (`local:` id) is never stored in a style. The bundled
face it names is stored in its place.

A pinned look carries its faces twice: the text and heading faces in the theme
tokens, as before, and all three in the style. A public link reads the code
face from the style, since it is handed no token outside a checked list.
