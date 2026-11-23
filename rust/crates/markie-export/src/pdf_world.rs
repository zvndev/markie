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
    // Faces Word documents name most often, for the Office print path.
    "/System/Library/Fonts/Supplemental/Georgia.ttf",
    "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
    "/System/Library/Fonts/Supplemental/Georgia Italic.ttf",
    "/System/Library/Fonts/Supplemental/Georgia Bold Italic.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Courier New.ttf",
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
    fonts.extend(typst_assets::fonts().flat_map(|data| Font::iter(Bytes::new(tex_sub_drop(data)))));
    let book = FontBook::from_fonts(&fonts);
    Fonts { book: LazyHash::new(book), fonts }
});

/// KaTeX drops a subscript under a big operator or a group by TeX's
/// `sub_drop`, 0.05em of the script size; New Computer Modern Math's MATH
/// table asks for 0.2em, which hangs `\int_0^1` 1.8pt lower than Electron's
/// and pushes every later line down. This sets `SubscriptBaselineDropMin` in
/// the PDF's copy of a math font to TeX's value. Other fonts pass unchanged.
pub fn tex_sub_drop(data: &'static [u8]) -> Vec<u8> {
    let mut out = data.to_vec();
    let be16 = |b: &[u8], at: usize| b.get(at..at + 2).map(|s| u16::from_be_bytes([s[0], s[1]]) as usize);
    let be32 = |b: &[u8], at: usize| b.get(at..at + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]) as usize);
    let Some(tables) = be16(data, 4) else { return out };
    for i in 0..tables {
        let rec = 12 + i * 16;
        if data.get(rec..rec + 4) != Some(b"MATH".as_slice()) {
            continue;
        }
        let (Some(math), Some(upm_head)) = (be32(data, rec + 8), head_upm(data, tables)) else { return out };
        // MATH header: version (4 bytes), then the MathConstants offset.
        let Some(constants) = be16(data, math + 4).map(|o| math + o) else { return out };
        // Four 16-bit fields, then MathValueRecords of 4 bytes each:
        // MathLeading, AxisHeight, AccentBaseHeight, FlattenedAccentBaseHeight,
        // SubscriptShiftDown, SubscriptTopMax, SubscriptBaselineDropMin.
        let at = constants + 8 + 6 * 4;
        let value = (upm_head as f64 * 0.05 * 0.7).round() as i16;
        if let Some(slot) = out.get_mut(at..at + 2) {
            slot.copy_from_slice(&value.to_be_bytes());
        }
        return out;
    }
    out
}

/// The font's units per em, from its `head` table.
fn head_upm(data: &[u8], tables: usize) -> Option<usize> {
    for i in 0..tables {
        let rec = 12 + i * 16;
        if data.get(rec..rec + 4) == Some(b"head".as_slice()) {
            let off = u32::from_be_bytes(data.get(rec + 8..rec + 12)?.try_into().ok()?) as usize;
            return data.get(off + 18..off + 20).map(|s| u16::from_be_bytes([s[0], s[1]]) as usize);
        }
    }
    None
}

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
