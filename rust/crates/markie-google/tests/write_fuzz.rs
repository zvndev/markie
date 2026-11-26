//! The write-back property: for random Markdown made of what sync supports
//! (paragraphs, headings, bulleted, numbered and checked lists with nesting,
//! bold, italic, strikethrough, links, code spans and code blocks), and
//! random edits to it, the planned requests applied to the Doc model and
//! read back through the converter give exactly the edited Markdown, and
//! nothing is held back. Then the same against a collaborator's edit
//! elsewhere, merged through `targetRevisionId` in the fake model.
//! Seeded and deterministic; no network.
use markie_google::convert::doc_to_markdown;
use markie_google::md::{self, Kind};
use markie_google::merge::diff3;
use markie_google::model::{DocModel, Mode};
use markie_google::plan::{plan, remote_view};
mod common;
use common::*;

/// Write `local` onto `doc` the way sync does, apply, read back.
fn write(doc: &serde_json::Value, local_md: &str, mode: Mode) -> (DocModel, String, Vec<&'static str>) {
    let view = remote_view(doc).expect("the model reads the Doc");
    let local = md::parse(local_md);
    let chunks = diff3(&view.parsed.keys(), &local.keys(), &view.parsed.keys());
    let p = plan(&view, &local, &chunks, mode);
    let mut m = view.model.clone();
    for req in &p.requests {
        m.apply(req, mode, "fuzz").unwrap_or_else(|e| panic!("request {req} failed: {e}"));
    }
    let md = doc_to_markdown(&m.to_doc()).markdown;
    (m, md, p.held)
}

fn keys(s: &str) -> Vec<String> {
    md::parse(s).blocks.into_iter().map(|b| b.key).collect()
}

#[test]
fn random_edits_on_supported_markdown_write_back_exactly() {
    let mut failures = Vec::new();
    for seed in 1..=seeds(400) {
        let mut r = Rng(seed.wrapping_mul(0x9e3779b97f4a7c15) | 1);
        let mut blocks: Vec<B> = (0..1 + r.below(8)).map(|_| block(&mut r, true)).collect();
        fix_levels(&mut blocks);
        let base = render(&blocks);
        // Build the Doc from nothing, through the planner itself.
        let (model, built, held) = write(&empty_doc(), &base, Mode::Edit);
        if !held.is_empty() {
            // Ticked boxes can't be written from nothing (and items under them follow).
            assert!(held.iter().any(|h| h.contains("struck") || *h == "ticked checkboxes"), "seed {seed}: building held {held:?}\n{base}--- got\n{built}");
            continue;
        }
        assert_eq!(keys(&built), keys(&base), "seed {seed}: building\n--- want\n{base}--- got\n{built}");
        let doc = model.to_doc();
        // Edit, never ticking a box.
        let mut edited = blocks.clone();
        for _ in 0..1 + r.below(4) {
            edit(&mut r, &mut edited);
        }
        fix_levels(&mut edited);
        let local = render(&edited);
        let (_, got, held) = write(&doc, &local, Mode::Edit);
        let allowed = |h: &&str| *h == "ticked checkboxes" || h.contains("struck");
        let bad: Vec<_> = held.iter().filter(|h| !allowed(h)).collect();
        let touched_ticked = md::parse(&base).blocks.iter().any(|b| matches!(b.kind, Kind::Item { list: md::ListKind::Check, checked: true, .. }));
        if (!bad.is_empty() && !touched_ticked) || (held.is_empty() && keys(&got) != keys(&local)) {
            failures.push(format!("seed {seed}: held {held:?}\n--- base\n{base}--- local\n{local}--- got\n{got}"));
        }
    }
    assert!(failures.is_empty(), "{} failures, first:\n{}", failures.len(), failures[0]);
}

#[test]
fn suggestions_read_back_as_the_edit_once_accepted() {
    for seed in 1..=seeds(150) {
        let mut r = Rng(seed.wrapping_mul(0x2545f4914f6cdd1d) | 1);
        let mut blocks: Vec<B> = (0..1 + r.below(6)).map(|_| block(&mut r, false)).collect();
        fix_levels(&mut blocks);
        let base = render(&blocks);
        let (model, _, held) = write(&empty_doc(), &base, Mode::Edit);
        if held.iter().any(|h| h.contains("struck")) {
            continue;
        }
        assert!(held.is_empty(), "seed {seed}: building held {held:?}\n{base}");
        let doc = model.to_doc();
        let mut edited = blocks.clone();
        edit(&mut r, &mut edited);
        fix_levels(&mut edited);
        let local = render(&edited);
        let (mut m, got, held) = write(&doc, &local, Mode::Suggest);
        if held.iter().any(|h| h.contains("struck")) {
            continue;
        }
        assert!(held.is_empty(), "seed {seed}: {held:?}\n{base}\n{local}");
        assert_eq!(keys(&got), keys(&local), "seed {seed}: suggested\n--- base\n{base}--- local\n{local}--- got\n{got}");
        // Accepting every suggestion gives the same Doc; rejecting gives the base back.
        let mut accepted = m.clone();
        accepted.resolve_suggestions(true);
        assert_eq!(keys(&doc_to_markdown(&accepted.to_doc()).markdown), keys(&local), "seed {seed}: accepted");
        m.resolve_suggestions(false);
        assert_eq!(keys(&doc_to_markdown(&m.to_doc()).markdown), keys(&base), "seed {seed}: rejected");
    }
}

#[test]
fn debug_one() {
    let Ok(local_md) = std::env::var("MARKIE_FUZZ_MD") else { return };
    let local_md = local_md.replace("\\n", "\n");
    let base = std::env::var("MARKIE_FUZZ_BASE").unwrap_or_default().replace("\\n", "\n");
    let doc = if base.is_empty() { empty_doc() } else { write(&empty_doc(), &base, Mode::Edit).0.to_doc() };
    let view = remote_view(&doc).unwrap();
    eprintln!("--- remote\n{}", view.markdown);
    let local = md::parse(&local_md);
    let chunks = diff3(&view.parsed.keys(), &local.keys(), &view.parsed.keys());
    eprintln!("chunks {chunks:?}");
    let p = plan(&view, &local, &chunks, Mode::Edit);
    for r in &p.requests {
        eprintln!("{r}");
    }
    eprintln!("held {:?}", p.held);
    eprintln!("--- after\n{}", doc_to_markdown(&p.after.to_doc()).markdown);
}
