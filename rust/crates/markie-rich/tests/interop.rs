//! Yjs interop with the web app's TipTap rooms.
//!
//! Without environment variables this checks the Rust side alone: every
//! case survives model -> yrs update -> model. With `interop/run.sh` it runs
//! in two phases around a Node pass over the repo's own yjs, y-tiptap and
//! TipTap schema (`interop/interop.test.ts`):
//!
//! * export (`MARKIE_INTEROP_PHASE=export`): write each case as a yrs update,
//!   plus a shared base document and a Rust edit made on it;
//! * import (`MARKIE_INTEROP_PHASE=import`): read the updates Node wrote,
//!   a TipTap-seeded room per case and an edit made in a real TipTap editor
//!   bound with the Collaboration extension, and check what Rust makes of
//!   them.

use std::fs;
use std::path::{Path, PathBuf};

use markie_rich::room::{self, RoomNode};
use markie_rich::{ydoc, Document};
use serde_json::{json, Value};
use yrs::{Any, ReadTxn, Text, Transact, Xml, XmlFragment, XmlOut};

const CASES: &str = include_str!("../interop/cases.json");

struct Case {
    name: String,
    markdown: String,
}

fn cases() -> (Vec<Case>, String) {
    let v: Value = serde_json::from_str(CASES).unwrap();
    let cases = v["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| Case { name: c["name"].as_str().unwrap().into(), markdown: c["markdown"].as_str().unwrap().into() })
        .collect();
    (cases, v["editBase"].as_str().unwrap().to_string())
}

/// What a room holds for a document: its body's nodes (front matter never
/// enters a room).
fn room_of(md: &str) -> Vec<RoomNode> {
    room::to_room(&Document::parse(md).nodes())
}

/// TipTap's TrailingNode keeps an empty paragraph at the end of every rich
/// document. It is the editor's, not the file's.
fn without_trailing_empty(mut nodes: Vec<RoomNode>) -> Vec<RoomNode> {
    while matches!(nodes.last(), Some(RoomNode::Element { name, children, .. }) if name == "paragraph" && children.is_empty()) {
        nodes.pop();
    }
    nodes
}

/// The client id every Rust write uses, so the base document is the same
/// bytes in both phases.
const RUST_CLIENT: u64 = 7;

fn base_doc(edit_base: &str) -> yrs::Doc {
    ydoc::doc_with(&room_of(edit_base), RUST_CLIENT)
}

/// The Rust edit: type " Rust bold" at the end of the second paragraph, the
/// two words in bold, and
/// tick the first task. Done on the yrs document directly, as an editor
/// binding would.
fn rust_edit(doc: &yrs::Doc) {
    let frag = ydoc::fragment(doc);
    let mut txn = doc.transact_mut();
    let Some(XmlOut::Element(p)) = frag.get(&txn, 2) else { panic!("second paragraph") };
    let Some(XmlOut::Text(t)) = p.get(&txn, 0) else { panic!("paragraph text") };
    let end = t.len(&txn);
    t.insert_with_attributes(&mut txn, end, " ", Default::default());
    let bold: yrs::types::Attrs = [("bold".into(), Any::Map(Default::default()))].into_iter().collect();
    t.insert_with_attributes(&mut txn, end + 1, "Rust bold", bold);
    let Some(XmlOut::Element(list)) = frag.get(&txn, 3) else { panic!("task list") };
    let Some(XmlOut::Element(item)) = list.get(&txn, 0) else { panic!("task item") };
    item.insert_attribute(&mut txn, "checked", Any::Bool(true));
}

fn dir() -> Option<PathBuf> {
    std::env::var("MARKIE_INTEROP_DIR").ok().map(PathBuf::from)
}

fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

#[test]
fn interop() {
    match std::env::var("MARKIE_INTEROP_PHASE").as_deref() {
        Ok("export") => export(&dir().expect("MARKIE_INTEROP_DIR")),
        Ok("import") => import(&dir().expect("MARKIE_INTEROP_DIR")),
        _ => rust_only(),
    }
}

fn rust_only() {
    let (cases, edit_base) = cases();
    for c in &cases {
        let nodes = room_of(&c.markdown);
        let doc = ydoc::doc_with(&nodes, RUST_CLIENT);
        let back = ydoc::read_doc(&doc).unwrap();
        assert_eq!(back, nodes, "{}: yrs round trip", c.name);
        let fresh = ydoc::new_doc(99);
        ydoc::apply(&fresh, &ydoc::encode_state(&doc)).unwrap();
        assert_eq!(ydoc::read_doc(&fresh).unwrap(), nodes, "{}: through an update", c.name);
        let model = room::from_room(&back).unwrap();
        assert_eq!(model, Document::parse(&c.markdown).nodes(), "{}: model from room", c.name);
    }
    // The Rust edit folds back onto the file touching only its two blocks.
    let base = Document::parse(&edit_base);
    let doc = base_doc(&edit_base);
    rust_edit(&doc);
    let after = base.with_room_nodes(&room::from_room(&ydoc::read_doc(&doc).unwrap()).unwrap());
    assert_eq!(after.to_markdown(), expected_after_rust_edit(&edit_base));
    println!("rust-only interop: {} cases through yrs, edit folds back", cases.len());
}

fn expected_after_rust_edit(base: &str) -> String {
    base.replace("Second paragraph gets\nan edit from Rust.", "Second paragraph gets an edit from Rust. **Rust bold**")
        .replace("- [ ] a task", "- [x] a task")
}

fn export(dir: &Path) {
    let (cases, edit_base) = cases();
    let mut index = Vec::new();
    for (i, c) in cases.iter().enumerate() {
        let nodes = room_of(&c.markdown);
        let doc = ydoc::doc_with(&nodes, RUST_CLIENT);
        let file = format!("case-{i:02}");
        write(&dir.join("rust").join(format!("{file}.bin")), &ydoc::encode_state(&doc));
        write(
            &dir.join("rust").join(format!("{file}.json")),
            serde_json::to_string_pretty(&room::to_json(&nodes)).unwrap().as_bytes(),
        );
        index.push(json!({"name": c.name, "file": file, "markdown": c.markdown}));
    }
    // The shared base, and the Rust edit as an incremental update on it.
    let doc = base_doc(&edit_base);
    write(&dir.join("rust/edit-base.bin"), &ydoc::encode_state(&doc));
    let sv = doc.transact().state_vector();
    rust_edit(&doc);
    write(&dir.join("rust/edit-rust.bin"), &ydoc::encode_since(&doc, &sv));
    let base = Document::parse(&edit_base);
    let after = base.with_room_nodes(&room::from_room(&ydoc::read_doc(&doc).unwrap()).unwrap());
    write(&dir.join("rust/edit-rust.md"), after.to_markdown().as_bytes());

    // Optional corpus: real files a room can carry, for structural agreement.
    if let Ok(corpus) = std::env::var("MARKIE_INTEROP_CORPUS") {
        let max: usize = std::env::var("MARKIE_INTEROP_CORPUS_MAX").ok().and_then(|s| s.parse().ok()).unwrap_or(300);
        let mut files = Vec::new();
        collect(Path::new(&corpus), &mut files);
        let mut entries = Vec::new();
        for f in files {
            if entries.len() >= max {
                break;
            }
            let Ok(md) = fs::read_to_string(&f) else { continue };
            if md.len() > 16_000 || md.trim().is_empty() {
                continue;
            }
            let d = Document::parse(&md);
            // A room cannot carry these (live-room-carry.ts); the web app never
            // writes such a file from a room, so they are not interop cases.
            if d.blocks.iter().any(|b| b.is_opaque()) {
                continue;
            }
            let body = &md[d.front_matter.len()..];
            let k = entries.len();
            let doc = ydoc::doc_with(&room::to_room(&d.nodes()), RUST_CLIENT);
            write(&dir.join(format!("corpus/{k:04}.bin")), &ydoc::encode_state(&doc));
            entries.push(json!({"file": f.display().to_string(), "body": body, "bin": format!("{k:04}.bin")}));
        }
        write(&dir.join("corpus/index.json"), serde_json::to_string(&entries).unwrap().as_bytes());
        println!("exported {} corpus documents", entries.len());
    }
    write(&dir.join("rust/index.json"), serde_json::to_string_pretty(&index).unwrap().as_bytes());
    println!("exported {} cases to {}", cases.len(), dir.display());
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            collect(&p, out);
        } else if name.to_ascii_lowercase().ends_with(".md") {
            out.push(p);
        }
    }
}

fn import(dir: &Path) {
    let (cases, edit_base) = cases();
    let mut passed = 0;
    let mut failures = Vec::new();
    for (i, c) in cases.iter().enumerate() {
        let path = dir.join("node").join(format!("case-{i:02}.bin"));
        let bytes = fs::read(&path).unwrap_or_else(|_| panic!("missing {}", path.display()));
        let doc = ydoc::new_doc(1234);
        ydoc::apply(&doc, &bytes).unwrap();
        let incoming = without_trailing_empty(ydoc::read_doc(&doc).unwrap());
        let ours = room_of(&c.markdown);
        let mut ok = true;
        if incoming != ours {
            ok = false;
            failures.push(format!(
                "{}: TipTap room differs\n  node: {}\n  rust: {}",
                c.name,
                room::to_json(&incoming),
                room::to_json(&ours)
            ));
        }
        match room::from_room(&incoming) {
            Ok(nodes) => {
                // The TipTap-seeded room folded onto the file writes the file.
                let out = Document::parse(&c.markdown).with_room_nodes(&nodes).to_markdown();
                if out != c.markdown {
                    ok = false;
                    failures.push(format!("{}: folded output {out:?}", c.name));
                }
            }
            Err(e) => {
                ok = false;
                failures.push(format!("{}: {e}", c.name));
            }
        }
        if ok {
            passed += 1;
        }
    }
    println!("node -> rust: {passed}/{} TipTap-seeded rooms read as the same blocks and fold back byte for byte", cases.len());

    // A real TipTap editor's edit, made in a room seeded by Rust.
    let base = Document::parse(&edit_base);
    let node_edit = fs::read(dir.join("node/edit-node.bin")).expect("edit-node.bin");
    let doc = base_doc(&edit_base);
    ydoc::apply(&doc, &node_edit).unwrap();
    let after_node = base
        .with_room_nodes(&room::from_room(&without_trailing_empty(ydoc::read_doc(&doc).unwrap())).unwrap())
        .to_markdown();
    let expected_node = edit_base.replace("First paragraph stays put.", "First paragraph stays put. *Node*")
        + "\nAdded by Node.\n";
    let node_ok = after_node == expected_node;
    if !node_ok {
        failures.push(format!("node edit folded to {after_node:?}, expected {expected_node:?}"));
    }

    // Both edits made concurrently from the same base converge.
    let doc = base_doc(&edit_base);
    rust_edit(&doc);
    ydoc::apply(&doc, &node_edit).unwrap();
    let converged = without_trailing_empty(ydoc::read_doc(&doc).unwrap());
    let node_view: Value = serde_json::from_slice(&fs::read(dir.join("node/converged.json")).unwrap()).unwrap();
    let converge_ok = room::to_json(&converged) == node_view;
    if !converge_ok {
        failures.push(format!("converged rooms differ\n  rust: {}\n  node: {node_view}", room::to_json(&converged)));
    }
    let final_md = base.with_room_nodes(&room::from_room(&converged).unwrap()).to_markdown();
    let expected_final = expected_after_rust_edit(&edit_base)
        .replace("First paragraph stays put.", "First paragraph stays put. *Node*")
        + "\nAdded by Node.\n";
    let final_ok = final_md == expected_final;
    if !final_ok {
        failures.push(format!("converged file {final_md:?}, expected {expected_final:?}"));
    }
    println!("node editor edit -> rust file: {}", if node_ok { "pass" } else { "FAIL" });
    println!("concurrent edits converge in both: {}", if converge_ok { "pass" } else { "FAIL" });
    println!("converged file keeps untouched blocks: {}", if final_ok { "pass" } else { "FAIL" });

    let summary = json!({
        "nodeToRust": {"passed": passed, "total": cases.len()},
        "nodeEdit": node_ok, "converged": converge_ok, "convergedFile": final_ok,
        "failures": failures,
    });
    write(&dir.join("rust/import-report.json"), serde_json::to_string_pretty(&summary).unwrap().as_bytes());
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
