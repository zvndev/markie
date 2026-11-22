//! The mitex command spec, patched for the Typst version we ship.
//!
//! mitex 0.2.4 maps LaTeX commands to Typst symbol names as they were at its
//! release. Typst 0.14/0.15 (codex 0.3) removed some of those names, so the
//! converted code fails with "unknown variable" or "unknown symbol modifier".
//! We rewrite the aliases once at startup (the vendored converter in
//! `mitex_convert.rs` honours a custom spec; upstream 0.2.4 does not). The
//! `coverage` test probes every command, so a later rename shows up there.

use std::sync::LazyLock;

use mitex_parser::spec::{CommandSpec, CommandSpecItem};

/// (old Typst name, new Typst name). An entry matches the alias itself or the
/// alias followed by more modifiers (`sect` also rewrites `sect.big`).
const RENAMES: &[(&str, &str)] = &[
    ("sect", "inter"),
    ("diff", "partial"),
    ("angle.l", "chevron.l"),
    ("angle.r", "chevron.r"),
    ("bracket.l.double", "bracket.l.stroked"),
    ("bracket.r.double", "bracket.r.stroked"),
    ("plus.circle", "plus.o"),
    ("minus.circle", "minus.o"),
    ("dot.circle", "dot.o"),
    ("times.circle", "times.o"),
    ("ast.circle", "convolve.o"),
    ("dash.circle", "dash.o"),
    ("circle.nested", "compose.o"),
    ("planck.reduce", "planck"),
    ("arrow.l.dash", "arrow.l.dashed"),
    ("arrow.r.dash", "arrow.r.dashed"),
    ("ohm.inv", "Omega.inv"),
];

/// Commands KaTeX has that the 0.2.4 spec lacks, as (command, existing
/// command whose shape it copies, Typst alias; empty keeps the template's
/// alias). Found by the KaTeX command probe (see MATH.md); only ones real
/// documents plausibly use.
const ADDED: &[(&str, &str, &str)] = &[
    ("gtrapprox", "approx", "gt.approx"),
    ("gtreqqless", "approx", "⪌"),
    ("mathscr", "mathcal", "scr"),
    ("mapsfrom", "approx", "arrow.l.bar"),
    ("textcopyright", "approx", "copyright"),
    ("lmoustache", "approx", "mustache.l"),
    ("rmoustache", "approx", "mustache.r"),
    ("enskip", "approx", "space.en"),
    ("allowbreak", "approx", "zws"),
    ("varvdots", "approx", "dots.v"),
    ("smallfrown", "approx", "frown"),
    ("shortmid", "approx", "divides"),
    ("nshortmid", "approx", "divides.not"),
    ("nshortparallel", "approx", "parallel.not"),
    ("Bbbk", "approx", "bb(k)"),
    // environments: KaTeX's starred matrices and d-variants
    ("matrix*", "matrix", ""),
    ("pmatrix*", "pmatrix", ""),
    ("bmatrix*", "bmatrix", ""),
    ("Bmatrix*", "Bmatrix", ""),
    ("vmatrix*", "vmatrix", ""),
    ("Vmatrix*", "Vmatrix", ""),
    ("dcases", "cases", ""),
    ("drcases", "rcases", ""),
    ("darray", "array", ""),
];

fn rename(alias: &str) -> Option<String> {
    for (old, new) in RENAMES {
        if alias == *old {
            return Some((*new).to_string());
        }
        if let Some(rest) = alias.strip_prefix(old).filter(|r| r.starts_with('.')) {
            return Some(format!("{new}{rest}"));
        }
    }
    None
}

pub static SPEC: LazyLock<CommandSpec> = LazyLock::new(|| {
    let default = &*mitex_spec_gen::DEFAULT_SPEC;
    let mut commands: Vec<(String, CommandSpecItem)> = default
        .items()
        .map(|(name, item)| {
            let mut item = item.clone();
            match &mut item {
                CommandSpecItem::Cmd(shape) => {
                    if let Some(new) = shape.alias.as_deref().and_then(rename) {
                        shape.alias = Some(new);
                    }
                }
                CommandSpecItem::Env(shape) => {
                    if let Some(new) = shape.alias.as_deref().and_then(rename) {
                        shape.alias = Some(new);
                    }
                }
            }
            (name.to_string(), item)
        })
        .collect();
    for (name, template, alias) in ADDED {
        if default.get(name).is_some() {
            continue;
        }
        let Some(mut item) = default.get(template).cloned() else { continue };
        if !alias.is_empty() {
            match &mut item {
                CommandSpecItem::Cmd(shape) => shape.alias = Some((*alias).to_string()),
                CommandSpecItem::Env(shape) => shape.alias = Some((*alias).to_string()),
            }
        }
        commands.push(((*name).to_string(), item));
    }
    CommandSpec::new(commands.into_iter().collect())
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renames_match_whole_modifiers_only() {
        assert_eq!(rename("sect").as_deref(), Some("inter"));
        assert_eq!(rename("sect.big").as_deref(), Some("inter.big"));
        assert_eq!(rename("plus.circle.big").as_deref(), Some("plus.o.big"));
        assert_eq!(rename("section"), None);
        assert_eq!(rename("plus"), None);
    }

    #[test]
    fn spec_is_patched() {
        let cap = SPEC.get_cmd("cap").unwrap();
        assert_eq!(cap.alias.as_deref(), Some("inter"));
        for (name, _, _) in ADDED {
            assert!(SPEC.get(name).is_some(), "{name} not added");
        }
        assert!(SPEC.get_cmd("frac").is_some());
    }
}
