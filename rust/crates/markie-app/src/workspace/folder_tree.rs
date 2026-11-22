//! Browse's nested folder tree, a port of `src/lib/folder-tree.ts`: one
//! node per folder level, single-child chains folded into one label
//! (`Users/me/notes`), the first branching level open until the person
//! opens or closes a folder, and their choices read against the tree as it
//! stands today (`openWithAncestors`).

use std::cmp::Ordering;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// A file in the tree: its index in Browse's hit list.
#[derive(Clone, Debug)]
pub(super) struct FileEntry {
    pub hit: usize,
    pub name: String,
    pub dir: PathBuf,
    pub mtime_ms: f64,
}

#[derive(Clone, Debug)]
pub(super) struct FolderNode {
    pub path: PathBuf,
    pub label: String,
    pub files: Vec<FileEntry>,
    pub children: Vec<FolderNode>,
    pub total: usize,
    pub latest_mtime_ms: f64,
}

/// `localeCompare` closely enough for file names: case-insensitive first.
fn locale_cmp(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b))
}

fn is_sep(c: char) -> bool {
    c == '/' || c == '\\'
}

/// `/Users/me/notes` → `Users` (`/Users`), `me` (`/Users/me`), `notes`.
fn ancestors_of(dir: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let chars: Vec<(usize, char)> = dir.char_indices().collect();
    let mut start = 0;
    for i in 0..=chars.len() {
        let at_end = i == chars.len();
        let byte = if at_end { dir.len() } else { chars[i].0 };
        if !at_end && !is_sep(chars[i].1) {
            continue;
        }
        if byte > start {
            let segment = &dir[start..byte];
            let drive = out.is_empty() && !at_end && segment.len() == 2 && segment.ends_with(':') && segment.as_bytes()[0].is_ascii_alphabetic();
            let end = if drive { byte + 1 } else { byte };
            out.push((segment.to_string(), dir[..end].to_string()));
        }
        start = byte + if at_end { 0 } else { chars[i].1.len_utf8() };
    }
    out
}

struct Building {
    path: String,
    segment: String,
    files: Vec<FileEntry>,
    children: Vec<Building>,
}

fn insert(level: &mut Vec<Building>, ancestors: &[(String, String)], row: FileEntry) {
    let Some(((segment, path), rest)) = ancestors.split_first() else { return };
    let node = child(level, segment, path);
    if rest.is_empty() {
        node.files.push(row);
    } else {
        insert(&mut node.children, rest, row);
    }
}

fn child<'a>(level: &'a mut Vec<Building>, segment: &str, path: &str) -> &'a mut Building {
    let i = match level.iter().position(|b| b.segment == segment) {
        Some(i) => i,
        None => {
            level.push(Building { path: path.to_string(), segment: segment.to_string(), files: Vec::new(), children: Vec::new() });
            level.len() - 1
        }
    };
    &mut level[i]
}

pub(super) fn build_folder_tree(rows: Vec<FileEntry>) -> Vec<FolderNode> {
    let mut roots: Vec<Building> = Vec::new();
    for row in rows {
        let dir = row.dir.to_string_lossy().into_owned();
        let ancestors = ancestors_of(&dir);
        if ancestors.is_empty() {
            continue;
        }
        insert(&mut roots, &ancestors, row);
    }
    let mut out: Vec<FolderNode> = roots.into_iter().map(collapse).collect();
    out.sort_by(|a, b| locale_cmp(&a.label, &b.label));
    out
}

fn collapse(node: Building) -> FolderNode {
    let mut label = node.segment.clone();
    let mut current = node;
    while current.files.is_empty() && current.children.len() == 1 {
        let only = current.children.pop().expect("one child");
        label = format!("{label}/{}", only.segment);
        current = only;
    }
    let mut children: Vec<FolderNode> = current.children.into_iter().map(collapse).collect();
    children.sort_by(|a, b| locale_cmp(&a.label, &b.label));
    let mut files = current.files;
    files.sort_by(|a, b| locale_cmp(&a.name, &b.name));
    let total = files.len() + children.iter().map(|c| c.total).sum::<usize>();
    let latest = files.iter().map(|f| f.mtime_ms).chain(children.iter().map(|c| c.latest_mtime_ms)).fold(0.0, f64::max);
    FolderNode { path: PathBuf::from(current.path), label, files, children, total, latest_mtime_ms: latest }
}

/// Every folder that holds files, for a filter that opens the tree to its matches.
pub(super) fn paths_to_files(nodes: &[FolderNode]) -> HashSet<PathBuf> {
    let mut open = HashSet::new();
    fn walk(n: &FolderNode, open: &mut HashSet<PathBuf>) {
        if n.total > 0 {
            open.insert(n.path.clone());
        }
        n.children.iter().for_each(|c| walk(c, open));
    }
    nodes.iter().for_each(|n| walk(n, &mut open));
    open
}

pub(super) fn count_nodes(nodes: &[FolderNode]) -> usize {
    nodes.iter().map(|n| 1 + count_nodes(&n.children)).sum()
}

/// Untouched, each root opens down to its first branching level.
pub(super) fn initial_open_set(nodes: &[FolderNode]) -> HashSet<PathBuf> {
    let mut open = HashSet::new();
    for root in nodes {
        let mut node = Some(root);
        while let Some(n) = node {
            open.insert(n.path.clone());
            if n.files.len() + n.children.len() != 1 {
                break;
            }
            node = n.children.first();
        }
    }
    open
}

fn is_under(path: &Path, dir: &Path) -> bool {
    let (p, d) = (path.to_string_lossy(), dir.to_string_lossy());
    p.len() > d.len() && p.starts_with(d.as_ref()) && p[d.len()..].starts_with(is_sep)
}

/// What the person opened, plus the ancestors of anything open below, unless
/// they closed that ancestor themselves.
pub(super) fn open_with_ancestors(open: &HashSet<PathBuf>, closed: &HashSet<PathBuf>, nodes: &[FolderNode]) -> HashSet<PathBuf> {
    let mut result = open.clone();
    let mut present = HashSet::new();
    fn collect(n: &FolderNode, present: &mut HashSet<PathBuf>) {
        present.insert(n.path.clone());
        n.children.iter().for_each(|c| collect(c, present));
    }
    nodes.iter().for_each(|n| collect(n, &mut present));
    let folded: Vec<&PathBuf> = open.iter().filter(|p| !present.contains(*p)).collect();
    fn visit(n: &FolderNode, parent: Option<&FolderNode>, open: &HashSet<PathBuf>, closed: &HashSet<PathBuf>, folded: &[&PathBuf], result: &mut HashSet<PathBuf>) -> bool {
        let mut below = false;
        for c in &n.children {
            if visit(c, Some(n), open, closed, folded, result) {
                below = true;
            }
        }
        let folded_into = folded.iter().any(|p| is_under(&n.path, p) && !parent.is_some_and(|par| is_under(&par.path, p)));
        let named = open.contains(&n.path) || folded_into;
        if named || (below && !closed.contains(&n.path)) {
            result.insert(n.path.clone());
        }
        named || below
    }
    for root in nodes {
        visit(root, None, open, closed, &folded, &mut result);
    }
    result
}

/// Name keeps the built order; Updated puts the newest folder and file first.
pub(super) fn sort_by_updated(nodes: &mut [FolderNode]) {
    nodes.sort_by(|a, b| b.latest_mtime_ms.total_cmp(&a.latest_mtime_ms).then_with(|| locale_cmp(&a.label, &b.label)));
    for n in nodes.iter_mut() {
        n.files.sort_by(|a, b| b.mtime_ms.total_cmp(&a.mtime_ms).then_with(|| locale_cmp(&a.name, &b.name)));
        sort_by_updated(&mut n.children);
    }
}

/// A folder shows its first 200 rows until the person asks for the rest.
pub(super) const ROW_CAP: usize = 200;

#[cfg(test)]
mod tests {
    use super::*;

    fn f(hit: usize, path: &str, mtime: f64) -> FileEntry {
        let p = Path::new(path);
        FileEntry { hit, name: p.file_name().unwrap().to_string_lossy().into(), dir: p.parent().unwrap().to_path_buf(), mtime_ms: mtime }
    }

    fn labels(nodes: &[FolderNode]) -> Vec<String> {
        nodes.iter().map(|n| n.label.clone()).collect()
    }

    #[test]
    fn folds_single_child_chains_and_nests_the_rest() {
        let tree = build_folder_tree(vec![
            f(0, "/Users/me/notes/a.md", 1.0),
            f(1, "/Users/me/notes/work/b.md", 2.0),
            f(2, "/Users/me/notes/work/deep/c.md", 3.0),
            f(3, "/Users/me/notes/Home/d.md", 4.0),
        ]);
        assert_eq!(labels(&tree), ["Users/me/notes"]);
        let notes = &tree[0];
        assert_eq!(notes.path, PathBuf::from("/Users/me/notes"));
        assert_eq!(notes.total, 4);
        assert_eq!(notes.latest_mtime_ms, 4.0);
        assert_eq!(notes.files.len(), 1);
        assert_eq!(labels(&notes.children), ["Home", "work"]);
        assert_eq!(notes.children[1].children[0].label, "deep");
    }

    #[test]
    fn ancestors_keep_their_full_paths() {
        assert_eq!(
            ancestors_of("/a/b"),
            vec![("a".to_string(), "/a".to_string()), ("b".to_string(), "/a/b".to_string())]
        );
        assert_eq!(ancestors_of("C:\\x")[0], ("C:".to_string(), "C:\\".to_string()));
    }

    #[test]
    fn opens_to_the_first_branch_until_touched() {
        let tree = build_folder_tree(vec![f(0, "/r/x/a.md", 0.0), f(1, "/r/y/b.md", 0.0)]);
        // `r` folds nothing (two children), so only it opens.
        let open = initial_open_set(&tree);
        assert_eq!(open, HashSet::from([PathBuf::from("/r")]));
    }

    #[test]
    fn a_remembered_child_opens_its_ancestors_unless_closed() {
        let tree = build_folder_tree(vec![f(0, "/r/x/deep/a.md", 0.0), f(1, "/r/y/b.md", 0.0)]);
        let open = HashSet::from([PathBuf::from("/r/x/deep")]);
        let got = open_with_ancestors(&open, &HashSet::new(), &tree);
        assert!(got.contains(Path::new("/r")));
        let closed = HashSet::from([PathBuf::from("/r")]);
        let got = open_with_ancestors(&open, &closed, &tree);
        assert!(!got.contains(Path::new("/r")));
    }

    #[test]
    fn updated_order_puts_the_newest_first() {
        let mut tree = build_folder_tree(vec![f(0, "/r/a/old.md", 1.0), f(1, "/r/b/new.md", 9.0), f(2, "/r/a/newer.md", 5.0)]);
        sort_by_updated(&mut tree);
        assert_eq!(labels(&tree[0].children), ["b", "a"]);
        assert_eq!(tree[0].children[1].files[0].name, "newer.md");
    }

    #[test]
    fn filters_open_every_folder_with_files() {
        let tree = build_folder_tree(vec![f(0, "/r/a/x.md", 0.0), f(1, "/r/b/y.md", 0.0)]);
        assert_eq!(count_nodes(&tree), 3);
        assert_eq!(paths_to_files(&tree).len(), 3);
    }
}
