//! `cargo run --release -p markie-export --example export_pdf -- <in.md> <out.pdf> [light|dark] [--typst out.typ] [--style <preset id>]`
//! Exports one document the way Export PDF does, for side-by-side checks.
//! With a `.typ` input it compiles that Typst source instead (for tuning).
use markie_export::pdf::{PdfOptions, compile, typst_source};
use markie_export::Theme;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let input = std::path::PathBuf::from(&args[0]);
    let out = &args[1];
    let theme = if args.get(2).map(String::as_str) == Some("dark") { Theme::Dark } else { Theme::Light };
    let dir = input.parent().map(|p| p.to_path_buf());
    // Remote pictures through curl with Electron's 8 s image deadline.
    let fetch = |url: &str| -> Option<Vec<u8>> {
        let out = std::process::Command::new("curl").args(["-sfL", "--max-time", "8", url]).output().ok()?;
        out.status.success().then_some(out.stdout)
    };
    // `--style technical`: the preset, in the faces it brings.
    let look = match args.iter().position(|a| a == "--style").and_then(|i| args.get(i + 1)) {
        Some(id) => {
            let style = markie_core::markdown_style::MarkdownStyle::preset(id);
            let faces = markie_core::markdown_style::font_tokens(&style);
            markie_export::ExportLook { style: Some(style), body_font: faces.body_font.unwrap_or_default(), heading_font: faces.heading_font.unwrap_or_default(), code_font: faces.code_font.unwrap_or_default() }
        }
        None => Default::default(),
    };
    let opts = PdfOptions { theme, doc_dir: dir.as_deref(), fetch: Some(&fetch), look, ..Default::default() };
    let (source, files) = if input.extension().is_some_and(|e| e == "typ") {
        let md = std::fs::read_to_string(input.with_extension("md")).unwrap_or_default();
        let (_, files) = typst_source(&md, &opts).unwrap_or_default();
        (std::fs::read_to_string(&input).unwrap(), files)
    } else {
        typst_source(&std::fs::read_to_string(&input).unwrap(), &opts).unwrap()
    };
    if let Some(i) = args.iter().position(|a| a == "--typst") {
        std::fs::write(&args[i + 1], &source).unwrap();
    }
    let t = std::time::Instant::now();
    match compile(source, files) {
        Ok(pdf) => {
            std::fs::write(out, pdf).unwrap();
            eprintln!("wrote {out} in {:?}", t.elapsed());
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
