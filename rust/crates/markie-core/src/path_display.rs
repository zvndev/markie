//! Paths sized for a list row. A port of `src/lib/path-display.ts`.

use std::path::Path;

/// Home folds to `~`; a path is shown relative to it with `~/` in front.
pub fn compact_home_path(input: &str, home: &str) -> String {
    let h = home.trim_end_matches('/');
    let p = input.trim_end_matches('/');
    if h.is_empty() || !(p == h || p.starts_with(&format!("{h}/"))) {
        return input.to_string();
    }
    let rest = input[home.len().min(input.len())..].trim_start_matches('/');
    if rest.is_empty() { "~".into() } else { format!("~/{rest}") }
}

/// `compactDir`: at most `keep` trailing segments, with `…` in front when
/// anything was dropped.
pub fn compact_dir(dir: &Path, home: &Path, keep: usize) -> String {
    let input = dir.to_string_lossy();
    if input.is_empty() {
        return String::new();
    }
    let compact = compact_home_path(&input, &home.to_string_lossy());
    let segs: Vec<&str> = compact.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    if segs.len() <= keep {
        return segs.join("/");
    }
    format!("…/{}", segs[segs.len() - keep..].join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compacts_like_electron() {
        let home = Path::new("/Users/k");
        assert_eq!(compact_dir(Path::new("/Users/k"), home, 2), "~");
        assert_eq!(compact_dir(Path::new("/Users/k/Notes"), home, 2), "~/Notes");
        assert_eq!(compact_dir(Path::new("/Users/k/a/b/c"), home, 2), "…/b/c");
        assert_eq!(compact_dir(Path::new("/opt/x"), home, 2), "opt/x");
        assert_eq!(compact_home_path("/Users/kirby/x", "/Users/k"), "/Users/kirby/x");
    }
}
