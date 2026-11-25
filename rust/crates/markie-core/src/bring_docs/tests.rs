//! Every folder and file here is made up, in a temporary home folder.

use super::*;
use crate::projects::folders::{History, Snapshot};
use crate::registry::Registry;

fn touch(path: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, "x").unwrap();
}

fn never() -> AtomicBool {
    AtomicBool::new(false)
}

fn names(list: &[Candidate]) -> Vec<(String, CandidateKind, bool)> {
    list.iter().map(|c| (c.name.clone(), c.kind, c.preticked)).collect()
}

/// A home with every kind of candidate, plus the traps.
fn sample_home() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    touch(&h.join("Documents/Plans/roadmap.md"));
    touch(&h.join("Desktop/todo.txt"));
    touch(&h.join("Library/Mobile Documents/com~apple~CloudDocs/Lists/groceries.md"));
    touch(&h.join("Notes/Garden Vault/.obsidian/app.json"));
    touch(&h.join("Notes/Garden Vault/Seeds.md"));
    touch(&h.join("Exports/Export-2f1c/Trip plan 0123456789abcdef0123456789abcdef.md"));
    touch(&h.join("Projects/Kiln/notes.md"));
    // Traps: a vault in Downloads, a vault inside Documents (protected, so
    // never read before a tap), and a vault inside a folder Markie knew.
    touch(&h.join("Downloads/Loose Vault/.obsidian/app.json"));
    touch(&h.join("Documents/Hidden Vault/.obsidian/app.json"));
    touch(&h.join("Projects/Kiln/Inner Vault/.obsidian/app.json"));
    home
}

#[test]
fn discovery_finds_the_usual_places_vaults_exports_and_markies_own_folders() {
    let home = sample_home();
    let h = home.path();
    let known = vec![h.join("Projects/Kiln"), h.join("Downloads")];
    let list = discover(h, &known, &HashSet::new(), &never());
    assert_eq!(
        names(&list),
        vec![
            ("Documents".into(), CandidateKind::Documents, true),
            ("Desktop".into(), CandidateKind::Desktop, false),
            ("iCloud Drive".into(), CandidateKind::ICloudDrive, false),
            ("Kiln".into(), CandidateKind::Markie, true),
            ("Export-2f1c".into(), CandidateKind::Notion, false),
            ("Garden Vault".into(), CandidateKind::Obsidian, false),
        ]
    );
    let protected: Vec<bool> = list.iter().map(|c| c.protected).collect();
    assert_eq!(protected, vec![true, true, true, false, false, false]);
}

#[test]
fn downloads_is_never_a_candidate() {
    let home = sample_home();
    let h = home.path();
    let list = discover(h, &[h.join("Downloads"), h.join("Downloads/Loose Vault")], &HashSet::new(), &never());
    assert!(list.iter().all(|c| !c.path.starts_with(h.join("Downloads"))), "{:?}", names(&list));
    assert!(is_downloads(h, &h.join("Downloads/x/y")));
    assert!(!is_downloads(h, &h.join("Documents")));
}

#[test]
fn only_documents_and_markies_folders_are_preticked() {
    let home = sample_home();
    let h = home.path();
    let chosen = candidate(h, h.join("Notes"), CandidateKind::Chosen, &HashSet::new());
    assert!(!chosen.preticked);
    let list = discover(h, &[h.join("Projects/Kiln")], &HashSet::new(), &never());
    for c in &list {
        assert_eq!(c.preticked, matches!(c.kind, CandidateKind::Documents | CandidateKind::Markie), "{}", c.name);
    }
    // Already brought in: shown as done, never ticked again.
    let done: HashSet<PathBuf> = [h.join("Documents")].into();
    let list = discover(h, &[], &done, &never());
    let docs = list.iter().find(|c| c.kind == CandidateKind::Documents).unwrap();
    assert!(docs.imported && !docs.preticked);
}

#[test]
fn a_missing_icloud_drive_is_not_listed() {
    let home = tempfile::tempdir().unwrap();
    touch(&home.path().join("Documents/a.md"));
    let list = discover(home.path(), &[], &HashSet::new(), &never());
    assert_eq!(names(&list), vec![("Documents".into(), CandidateKind::Documents, true)]);
}

#[test]
fn notion_names_end_in_a_32_character_hex_id() {
    assert!(is_notion_name("Trip plan 0123456789abcdef0123456789abcdef.md"));
    assert!(is_notion_name("Tasks 0123456789ABCDEF0123456789abcdef_all.csv"));
    assert!(is_notion_name("0123456789abcdef0123456789abcdef.md"));
    assert!(!is_notion_name("Trip plan 0123456789abcdef0123456789abcde.md"), "31 characters");
    assert!(!is_notion_name("Trip plan 0123456789abcdef0123456789abcdeg.md"), "not hex");
    assert!(!is_notion_name("Trip plan 0123456789abcdef0123456789abcdef.png"));
    assert!(!is_notion_name("plan-0123456789abcdef0123456789abcdef.md"), "Notion puts a space before the id");
}

#[test]
fn counting_a_tree_of_thousands_sorts_documents_by_kind() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    for d in 0..40 {
        for i in 0..50 {
            let ext = ["md", "docx", "txt", "csv", "png"][i % 5];
            touch(&r.join(format!("Area {d:02}/Topic {}/note-{i:03}.{ext}", i % 3)));
        }
    }
    let found = AtomicUsize::new(0);
    let c = count_folder(r, r, &never(), &found);
    assert_eq!(c.outcome, CountOutcome::Done);
    // CSV is a data format: the index keeps at most 64 from one folder,
    // which these folders stay under.
    assert_eq!(c.counts, TypeCounts { markdown: 400, word: 400, text: 400, csv: 400 });
    assert_eq!(c.files.len(), 1600);
    assert_eq!(found.load(Ordering::Relaxed), 1600);
    assert_eq!(kinds_line(&c.counts, false), "400 Markdown · 400 Word · 400 text · 400 CSV");
    assert_eq!(total_label(c.counts.total(), false), "1,600 documents");
}

#[test]
fn counting_stops_at_the_cap() {
    let root = tempfile::tempdir().unwrap();
    for d in 0..21 {
        for i in 0..500 {
            touch(&root.path().join(format!("batch-{d:02}/n{i:03}.md")));
        }
    }
    let c = count_folder(root.path(), root.path(), &never(), &AtomicUsize::new(0));
    assert_eq!(c.outcome, CountOutcome::Capped);
    assert_eq!(c.files.len(), COUNT_CAP);
    assert_eq!(total_label(c.counts.total(), true), "10,000+ documents");
    assert!(kinds_line(&c.counts, true).ends_with("+ Markdown"));
}

#[test]
fn a_count_can_be_cancelled() {
    let root = tempfile::tempdir().unwrap();
    for d in 0..200 {
        touch(&root.path().join(format!("d{d:03}/a.md")));
    }
    let stop = AtomicBool::new(true);
    let c = count_folder(root.path(), root.path(), &stop, &AtomicUsize::new(0));
    assert_eq!(c.outcome, CountOutcome::Cancelled);
    assert!(c.files.is_empty());

    // From another thread, part way through.
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let found = std::sync::Arc::new(AtomicUsize::new(0));
    let (s, f, path) = (stop.clone(), found.clone(), root.path().to_path_buf());
    let worker = std::thread::spawn(move || count_folder(&path, &path, &s, &f));
    stop.store(true, Ordering::Relaxed);
    let c = worker.join().unwrap();
    assert!(matches!(c.outcome, CountOutcome::Cancelled | CountOutcome::Done));
    if c.outcome == CountOutcome::Cancelled {
        assert!(found.load(Ordering::Relaxed) < 200);
    }
}

#[cfg(unix)]
#[test]
fn a_folder_without_permission_counts_as_no_access() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let locked = root.path().join("Locked");
    touch(&locked.join("secret.md"));
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let readable = fs::read_dir(&locked).is_ok();
    let c = count_folder(&locked, root.path(), &never(), &AtomicUsize::new(0));
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    if readable {
        eprintln!("running as a user who can read anything: skipped");
        return;
    }
    assert_eq!(c.outcome, CountOutcome::NoAccess);
    let gone = count_folder(&root.path().join("Nope"), root.path(), &never(), &AtomicUsize::new(0));
    assert_eq!(gone.outcome, CountOutcome::Missing);
}

#[cfg(unix)]
#[test]
fn symlink_loops_are_never_followed() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    touch(&r.join("a/b/one.md"));
    touch(&r.join("a/two.md"));
    std::os::unix::fs::symlink(r.join("a"), r.join("a/b/loop")).unwrap();
    std::os::unix::fs::symlink(r, r.join("a/up")).unwrap();
    let c = count_folder(r, r, &never(), &AtomicUsize::new(0));
    assert_eq!(c.outcome, CountOutcome::Done);
    assert_eq!(c.counts.markdown, 2);
    assert!(find_specials(r, 10, &never()).is_empty());
}

#[test]
fn counting_finds_vaults_inside_the_folder() {
    let home = sample_home();
    let docs = home.path().join("Documents");
    let c = count_folder(&docs, home.path(), &never(), &AtomicUsize::new(0));
    assert_eq!(c.specials, vec![(docs.join("Hidden Vault"), CandidateKind::Obsidian)]);
}

#[test]
fn the_plan_mirrors_folders_that_hold_documents() {
    let root = PathBuf::from("/made/up/Work");
    let files: Vec<PathBuf> = [
        "brief.md",
        "Clients/Acme/kickoff.md",
        "Clients/Acme/notes.txt",
        "Clients/Birch/plan.docx",
        "a/b/c/d/e/f/deep.md",
    ]
    .iter()
    .map(|f| root.join(f))
    .chain([PathBuf::from("/elsewhere/stray.md")])
    .collect();
    let p = plan(&root, "Work", &files);
    assert_eq!(p.name, "Work");
    assert_eq!(p.files, vec![root.join("brief.md")]);
    let kids: Vec<&str> = p.children.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(kids, vec!["a", "Clients"]);
    let clients = &p.children[1];
    assert_eq!(clients.children.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["Acme", "Birch"]);
    assert_eq!(clients.children[0].files.len(), 2);
    // Six folders down, cut at four: the file sits in a/b/c/d.
    let d = &p.children[0].children[0].children[0].children[0];
    assert_eq!(d.name, "d");
    assert!(d.children.is_empty());
    assert_eq!(d.files, vec![root.join("a/b/c/d/e/f/deep.md")]);
    assert_eq!(p.file_count(), 5);
}

#[test]
fn a_folder_inside_another_ticked_one_is_brought_by_it() {
    let a = PathBuf::from("/made/up/Documents");
    let roots = vec![a.join("Vault"), a.clone(), PathBuf::from("/made/up/Notes"), a.clone()];
    assert_eq!(outermost(&roots), vec![a, PathBuf::from("/made/up/Notes")]);
}

fn tree_names(db: &Connection) -> Vec<String> {
    fn walk(nodes: &[folders::FolderNode], depth: usize, out: &mut Vec<String>) {
        for n in nodes {
            out.push(format!("{}{} ({})", "  ".repeat(depth), n.name, n.files.len()));
            walk(&n.children, depth + 1, out);
        }
    }
    let mut out = Vec::new();
    walk(&folders::tree(db).unwrap(), 0, &mut out);
    out
}

#[test]
fn an_import_registers_roots_and_makes_projects_folders_undone_in_one_step() {
    let home = sample_home();
    let h = home.path();
    let reg = Registry::in_memory().unwrap();
    let db = reg.conn();
    // A folder the person made already: the import never takes its name.
    folders::create_folder(db, None, "Documents").unwrap();
    let docs = h.join("Documents");
    let kiln = h.join("Projects/Kiln");
    let mut roots = Vec::new();
    for (root, name) in [(&docs, "Documents"), (&kiln, "Kiln")] {
        let c = count_folder(root, h, &never(), &AtomicUsize::new(0));
        reg.add_root(root).unwrap();
        roots.push((root.clone(), plan(root, name, &c.files)));
    }
    let mut history = History::default();
    let before = Snapshot::take(db).unwrap();
    let mut job = Importer::new(db, roots).unwrap();
    assert_eq!(job.total, 2);
    // A step at a time, as the app runs it between frames.
    let mut steps = 0;
    while !job.step(db, 1).unwrap() {
        steps += 1;
    }
    assert!(steps > 1);
    history.push(db, "Import Documents", before).unwrap();
    assert_eq!(reg.roots().unwrap(), vec![docs.clone(), kiln.clone()]);
    assert_eq!(tree_names(db), vec!["Documents (0)", "Documents 2 (0)", "  Plans (1)", "Kiln (1)"]);
    assert_eq!(imported_roots(db).unwrap().len(), 2);
    assert_eq!(history.depth(), 1);

    history.undo(db).unwrap();
    assert_eq!(tree_names(db), vec!["Documents (0)"], "one ⌘Z takes the whole import back");
    assert!(imported_roots(db).unwrap().is_empty());
    history.redo(db).unwrap();
    assert_eq!(tree_names(db).len(), 4);
    assert!(fs::read_dir(&docs).is_ok(), "nothing on disk moved");
    assert!(docs.join("Plans/roadmap.md").is_file());
}

#[test]
fn importing_again_adds_only_what_is_new_and_keeps_moved_files() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    touch(&r.join("one.md"));
    touch(&r.join("Sub/two.md"));
    let reg = Registry::in_memory().unwrap();
    let db = reg.conn();
    let run = |files: Vec<PathBuf>| {
        let mut job = Importer::new(db, vec![(r.to_path_buf(), plan(r, "Google Docs", &files))]).unwrap();
        job.run(db).unwrap();
        job.added
    };
    assert_eq!(run(vec![r.join("one.md"), r.join("Sub/two.md")]), 2);
    // The person moves one.md to a folder of their own.
    let mine = folders::create_folder(db, None, "Mine").unwrap();
    folders::place_files(db, &[r.join("one.md").to_string_lossy().into_owned()], &mine, None).unwrap();
    touch(&r.join("three.md"));
    assert_eq!(run(vec![r.join("one.md"), r.join("Sub/two.md"), r.join("three.md")]), 1);
    assert_eq!(tree_names(db), vec!["Google Docs (1)", "  Sub (1)", "Mine (1)"]);
    assert_eq!(folders::folder_of(db, &r.join("one.md").to_string_lossy()).unwrap(), Some(mine));
}
