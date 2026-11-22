//! The Typst world PDF exports compile in: one main file, the mitex scope
//! markie-math uses (the same files, so math is the editor's math), the
//! highlight theme, the document's pictures, and fonts. No packages, no
//! network, and no file reads beyond what the export handed in.

use std::collections::HashMap;
use std::sync::LazyLock;

use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};

/// The mitex scope, read from markie-math's copy so both stay one file.
const MITEX_FILES: &[(&str, &str)] = &[
    ("/markie/scope.typ", include_str!("../../markie-math/typst/markie/scope.typ")),
    ("/mitex/mod.typ", include_str!("../../markie-math/typst/mitex/mod.typ")),
    ("/mitex/prelude.typ", include_str!("../../markie-math/typst/mitex/prelude.typ")),
    ("/mitex/latex/standard.typ", include_str!("../../markie-math/typst/mitex/latex/standard.typ")),
];

/// System fonts that stand in for the stylesheet's stacks on a Mac:
/// `-apple-system` is SF Pro, `"SF Mono", …, Menlo` is SF Mono or Menlo.
/// The rest are fallbacks for symbols and scripts SF lacks, as Chromium falls back.
const SYSTEM_FONTS: &[&str] = &[
    "/System/Library/Fonts/SFNS.ttf",
    "/System/Library/Fonts/SFNSItalic.ttf",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/LucidaGrande.ttc",
    "/System/Library/Fonts/Apple Symbols.ttf",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
];

pub struct Fonts {
    pub book: LazyHash<FontBook>,
    pub fonts: Vec<Font>,
}

pub static FONTS: LazyLock<Fonts> = LazyLock::new(|| {
    let mut fonts: Vec<Font> = Vec::new();
    for path in SYSTEM_FONTS {
        if let Ok(data) = std::fs::read(path) {
            fonts.extend(Font::iter(Bytes::new(data)));
        }
    }
    // The embedded faces: math, New Computer Modern for \text, DejaVu Sans Mono.
    fonts.extend(typst_assets::fonts().flat_map(|data| Font::iter(Bytes::new(data))));
    let book = FontBook::from_fonts(&fonts);
    Fonts { book: LazyHash::new(book), fonts }
});

static LIBRARY: LazyLock<LazyHash<Library>> = LazyLock::new(|| LazyHash::new(Library::default()));

pub fn file_id(path: &str) -> FileId {
    let vpath = VirtualPath::new(path).expect("virtual path");
    RootedPath::new(VirtualRoot::Project, vpath).intern()
}

pub struct PdfWorld {
    main_id: FileId,
    main: Source,
    sources: Vec<(FileId, Source)>,
    files: HashMap<FileId, Bytes>,
}

impl PdfWorld {
    pub fn new(main: String, files: Vec<(String, Vec<u8>)>) -> Self {
        let main_id = file_id("/main.typ");
        let sources = MITEX_FILES.iter().map(|(p, t)| (file_id(p), Source::new(file_id(p), (*t).to_string()))).collect();
        let files = files.into_iter().map(|(p, b)| (file_id(&p), Bytes::new(b))).collect();
        Self { main_id, main: Source::new(main_id, main), sources, files }
    }
}

impl World for PdfWorld {
    fn library(&self) -> &LazyHash<Library> {
        &LIBRARY
    }
    fn book(&self) -> &LazyHash<FontBook> {
        &FONTS.book
    }
    fn main(&self) -> FileId {
        self.main_id
    }
    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main_id {
            return Ok(self.main.clone());
        }
        self.sources.iter().find(|(f, _)| *f == id).map(|(_, s)| s.clone()).ok_or(FileError::AccessDenied)
    }
    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if let Some(b) = self.files.get(&id) {
            return Ok(b.clone());
        }
        self.source(id).map(|s| Bytes::from_string(s.text().to_string()))
    }
    fn font(&self, index: usize) -> Option<Font> {
        FONTS.fonts.get(index).cloned()
    }
    fn today(&self, _offset: Option<typst::foundations::Duration>) -> Option<Datetime> {
        None
    }
}

/// Families Typst sees, for tests and diagnostics.
pub fn families() -> Vec<String> {
    let mut f: Vec<String> = FONTS.fonts.iter().map(|f| f.info().family.to_string()).collect();
    f.dedup();
    f
}
