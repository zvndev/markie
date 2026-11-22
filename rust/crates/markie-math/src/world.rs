//! A minimal in-memory Typst world: one main file, the vendored mitex scope,
//! and the embedded fonts. No file system, no packages, no network.

use std::sync::LazyLock;

use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};

/// The vendored mitex Typst scope (from `@preview/mitex` 0.2.6, Apache-2.0).
const MITEX_FILES: &[(&str, &str)] = &[
    ("/markie/scope.typ", include_str!("../typst/markie/scope.typ")),
    ("/mitex/mod.typ", include_str!("../typst/mitex/mod.typ")),
    ("/mitex/prelude.typ", include_str!("../typst/mitex/prelude.typ")),
    ("/mitex/latex/standard.typ", include_str!("../typst/mitex/latex/standard.typ")),
];

struct Shared {
    library: LazyHash<Library>,
    book: LazyHash<FontBook>,
    fonts: Vec<Font>,
    main_id: FileId,
    files: Vec<(FileId, Source)>,
}

fn file_id(path: &str) -> FileId {
    let vpath = VirtualPath::new(path).expect("static virtual path is valid");
    RootedPath::new(VirtualRoot::Project, vpath).intern()
}

/// Fonts we keep from typst-assets: the math font plus New Computer Modern
/// text faces (for `\text{}`, `\mathrm`, `\textbf`) and DejaVu Sans Mono (for
/// `\texttt`). Libertinus and the other math weights are skipped.
fn wanted_font(font: &Font) -> bool {
    let family = font.info().family.as_str();
    family == "New Computer Modern"
        || family == "DejaVu Sans Mono"
        || (family == "New Computer Modern Math" && font.info().variant.weight.to_number() == 400)
}

static SHARED: LazyLock<Shared> = LazyLock::new(|| {
    let fonts: Vec<Font> = typst_assets::fonts()
        .flat_map(|data| Font::iter(Bytes::new(data)))
        .filter(wanted_font)
        .collect();
    let book = FontBook::from_fonts(&fonts);
    let files = MITEX_FILES
        .iter()
        .map(|(path, text)| {
            let id = file_id(path);
            (id, Source::new(id, (*text).to_string()))
        })
        .collect();
    Shared {
        library: LazyHash::new(Library::default()),
        book: LazyHash::new(book),
        fonts,
        main_id: file_id("/main.typ"),
        files,
    }
});

/// Names of the loaded font families, for tests and diagnostics.
pub fn loaded_families() -> Vec<String> {
    SHARED.fonts.iter().map(|f| f.info().family.to_string()).collect()
}

pub struct MathWorld {
    main: Source,
}

impl MathWorld {
    pub fn new(main: String) -> Self {
        Self { main: Source::new(SHARED.main_id, main) }
    }
}

impl World for MathWorld {
    fn library(&self) -> &LazyHash<Library> {
        &SHARED.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &SHARED.book
    }

    fn main(&self) -> FileId {
        SHARED.main_id
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == SHARED.main_id {
            return Ok(self.main.clone());
        }
        SHARED
            .files
            .iter()
            .find(|(fid, _)| *fid == id)
            .map(|(_, s)| s.clone())
            .ok_or(FileError::AccessDenied)
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.source(id).map(|s| Bytes::from_string(s.text().to_string()))
    }

    fn font(&self, index: usize) -> Option<Font> {
        SHARED.fonts.get(index).cloned()
    }

    fn today(&self, _offset: Option<typst::foundations::Duration>) -> Option<Datetime> {
        None
    }
}
