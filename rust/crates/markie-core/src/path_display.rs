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

/// A path for one line of a settings row: home folds to `~`, and a path
/// still longer than `max` characters loses its middle to `…`. The start
/// (where it is) and the end (the folder itself) both stay readable. Show the
/// full path in a tooltip beside it.
pub fn fit_path(path: &Path, home: &Path, max: usize) -> String {
    middle_truncate(&compact_home_path(&path.to_string_lossy(), &home.to_string_lossy()), max)
}

/// At most `max` characters, the middle replaced by `…`. The end keeps a
/// little more than the start, since it names the file or folder. Cuts
/// fall on a `/` when one is near, so no folder name is cut in half there.
pub fn middle_truncate(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max || max < 5 {
        return s.to_string();
    }
    let room = max - 1;
    let head_n = room * 2 / 5;
    let tail_n = room - head_n;
    let mut head = head_n;
    // Prefer to end the start just after a separator, within the last third.
    if let Some(i) = (head_n.saturating_sub(head_n / 3)..head_n).rev().find(|&i| chars[i] == '/') {
        head = i + 1;
    }
    let mut tail_start = chars.len() - tail_n;
    // And to begin the end on a separator, within its first third.
    if let Some(i) = (tail_start..tail_start + tail_n / 3).find(|&i| chars[i] == '/') {
        tail_start = i;
    }
    let mut out: String = chars[..head].iter().collect();
    out.push('…');
    out.extend(&chars[tail_start..]);
    out
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

    #[test]
    fn fits_a_long_path_by_its_middle() {
        let home = Path::new("/Users/sam");
        // Short enough: only home folds.
        assert_eq!(fit_path(Path::new("/Users/sam/Documents/Markie/Google Docs"), home, 60), "~/Documents/Markie/Google Docs");
        // Too long: the start and the folder itself both survive.
        let long = Path::new("/Users/sam/Documents/Clients/Northwind Traders/Shared drive exports/2026/Markie/Google Docs");
        let fit = fit_path(long, home, 48);
        assert!(fit.chars().count() <= 48, "{fit}");
        assert!(fit.starts_with("~/Documents/"), "{fit}");
        assert!(fit.ends_with("/Markie/Google Docs"), "{fit}");
        assert_eq!(fit.matches('…').count(), 1);
        // Outside home it stays absolute, still cut in the middle.
        let fit = fit_path(Path::new("/Volumes/Archive/very/deep/folder/tree/that/goes/on/and/on/Google Docs"), home, 40);
        assert!(fit.starts_with("/Volumes/") && fit.ends_with("Google Docs") && fit.chars().count() <= 40, "{fit}");
        // Never shorter than it needs to be, and never mangles short input.
        assert_eq!(middle_truncate("abc", 2), "abc");
        assert_eq!(middle_truncate("abcdefghij", 10), "abcdefghij");
        assert_eq!(middle_truncate("abcdefghijk", 10).chars().count(), 10);
    }
}
