//! Each image in an imported Doc, saved as a file beside the Doc's Markdown.
//!
//! - **Where.** A folder beside the file, named after it when the first image
//!   arrives (`Field notes images/` for `Field notes.md`), and kept by that
//!   name in the record (`images_dir`) from then on. Renaming the file leaves
//!   the folder and every link alone: links are relative to the file's
//!   folder. Moving the file to another folder in Markie takes the images
//!   folder along (`follow_move`). A name that is taken on disk, or by another
//!   synced file in that folder, gets " (2)" and so on, so two Docs never
//!   share a folder.
//! - **Names.** The image's object ID and an extension from the response's
//!   content type (`kix.abc123.png`). Stable, so a pull that changes nothing
//!   writes nothing: a file whose bytes are the same is not touched.
//! - **Markdown.** `![alt](Field%20notes%20images/kix.abc123.png)`. The
//!   destination is percent-encoded so it holds no space or bracket: that is
//!   the form markie-rich writes when it saves an image back (`normalize_href`
//!   keeps it, `serialize::image` leaves it bare), so an editor save keeps the
//!   line byte for byte. The reader and editor (`markie_editor::media::resolve`)
//!   and export (`markie_export::assets::candidate_path`) decode it.
//! - **When.** On import, on Refresh, and on every sync round that reads a
//!   Doc whose Drive version moved. A round that only sends local edits
//!   downloads only images it has no file for.
//! - **Failures.** A download that fails (offline, 403, an expired URL, not an
//!   image) keeps the copy an earlier sync saved, or else leaves that image
//!   as a link to Google, as before. It never fails the import or the round.
//! - **Removed in Google.** Its file is deleted, and the folder once empty.
//!   Only files this record says Markie wrote, only in that folder, and never
//!   one the Markdown still points at.
//! - **Read-only.** A block with an image is read-only for sync (`md.rs`), so
//!   moving, deleting or editing one never sends anything to Google. The Doc
//!   JSON is marked with each image's local destination before any
//!   conversion (`LOCAL_SRC`), so the synced base, the Doc as sync reads it
//!   and the file all say the same line: an image never reads as a change.
//! - **Conflict copies** get their own images folder with copies of the
//!   images they show (`copy_for`), so a later pull can't take them away.
use crate::api::DocsSource;
use crate::store::{self, SyncRecord};
use rusqlite::Connection;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

/// The key `localize` sets on an image's `embeddedObject`: its Markdown
/// destination. Never sent to Google; the Doc JSON is only read.
pub const LOCAL_SRC: &str = "markieLocalSrc";

/// Downloads bigger than this are refused, and the image stays a link.
pub const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;

/// The images Markie saved for one synced file.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Saved {
    /// The images folder's name, beside the Markdown file.
    pub dir: Option<String>,
    /// Object ID to file name in `dir`, for every file Markie wrote there.
    pub files: BTreeMap<String, String>,
}

impl Saved {
    pub fn of(rec: &SyncRecord) -> Self {
        Self { dir: rec.images_dir.clone(), files: rec.images.clone() }
    }

    pub fn store(&self, rec: &mut SyncRecord) {
        rec.images_dir = self.dir.clone();
        rec.images = self.files.clone();
    }

    /// `newer` over this one: what a second read in the same round starts from.
    pub fn overlay(&self, newer: &Saved) -> Saved {
        let mut files = self.files.clone();
        files.extend(newer.files.clone());
        Saved { dir: newer.dir.clone().or_else(|| self.dir.clone()), files }
    }

    fn folder(&self, md: &Path) -> Option<PathBuf> {
        Some(md.parent()?.join(self.dir.as_deref().filter(|d| safe_dir(d))?))
    }
}

/// Every file a round knows Markie wrote: the record's, and any it saved.
/// What a pull may clean up, and what a conflict copy may copy.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Known {
    pub dir: Option<String>,
    /// (object ID, file name), each pair once.
    pub files: Vec<(String, String)>,
}

impl Known {
    pub fn of(list: &[&Saved]) -> Known {
        let mut out = Known::default();
        for s in list {
            if out.dir.is_none() {
                out.dir = s.dir.clone();
            }
            for (id, name) in &s.files {
                if !out.files.iter().any(|(i, n)| i == id && n == name) {
                    out.files.push((id.clone(), name.clone()));
                }
            }
        }
        out
    }

    fn folder(&self, md: &Path) -> Option<PathBuf> {
        Some(md.parent()?.join(self.dir.as_deref().filter(|d| safe_dir(d))?))
    }
}

/// Download the images the Doc shows that need it, save each beside `md`,
/// and mark `doc` with each saved image's destination, so the converter
/// writes a Markdown image of the file. `refetch`: Google may have changed
/// an image, so download it again even when a file is there.
pub fn localize(src: &dyn DocsSource, db: &Connection, doc: &mut Value, md: &Path, prior: &Saved, refetch: bool) -> Saved {
    let shown = crate::convert::doc_to_markdown(doc).image_ids;
    let mut out = Saved { dir: prior.dir.clone().filter(|d| safe_dir(d)), files: BTreeMap::new() };
    let Some(parent) = md.parent() else { return out };
    let uris = content_uris(doc);
    let mut dests: HashMap<String, String> = HashMap::new();
    for id in shown {
        let existing = prior.files.get(&id).filter(|name| safe_name(name) && out.dir.as_deref().is_some_and(|d| safe_dir(d) && parent.join(d).join(name).is_file())).cloned();
        let fetched = if existing.is_some() && !refetch {
            None
        } else {
            uris.get(&id).and_then(|uri| src.image(uri).ok()).and_then(|(bytes, mime)| {
                let ext = extension(&mime)?;
                let dir = out.dir.get_or_insert_with(|| choose_dir(db, md)).clone();
                let name = format!("{}.{ext}", file_part(&id));
                write_if_changed(&parent.join(&dir).join(&name), &bytes).ok().map(|()| name)
            })
        };
        if let Some(name) = fetched.or(existing) {
            let dir = out.dir.clone().unwrap_or_default();
            dests.insert(id.clone(), destination(&dir, &name));
            out.files.insert(id, name);
        }
    }
    mark(doc, &dests);
    out
}

/// After a pull wrote `text` to `md`: delete each file in `known` that the
/// Doc no longer shows (`now`) and the file doesn't point at, and the folder
/// once nothing is left in it. A file the Markdown still points at stays in
/// `now`, to go once nothing does.
pub fn prune(md: &Path, known: &Known, now: &mut Saved, text: &str) {
    if now.dir.is_none() {
        now.dir = known.dir.clone();
    }
    let Some(folder) = now.folder(md) else { return };
    let mut live: HashSet<String> = now.files.values().cloned().collect();
    for (id, name) in &known.files {
        if live.contains(name) || !safe_name(name) {
            continue;
        }
        if text.contains(name.as_str()) && !now.files.contains_key(id) {
            now.files.insert(id.clone(), name.clone());
            live.insert(name.clone());
            continue;
        }
        let _ = std::fs::remove_file(folder.join(name));
    }
    if now.files.is_empty() {
        // Fails, and keeps the folder, if anything else is in it.
        let _ = std::fs::remove_dir(&folder);
        if !folder.exists() {
            now.dir = None;
        }
    }
}

/// The text of a conflict copy at `copy`, with its own images: each image of
/// `saved` that `text` shows is copied to a folder named after the copy, and
/// its line points there, so the copy keeps its pictures whatever a later
/// pull deletes.
pub fn copy_for(md: &Path, copy: &Path, known: &Known, text: &str) -> String {
    let (Some(dir), Some(from), Some(parent)) = (known.dir.as_deref(), known.folder(md), copy.parent()) else { return text.to_string() };
    let names: Vec<&String> = {
        let mut seen = HashSet::new();
        known.files.iter().map(|(_, n)| n).filter(|n| safe_name(n) && seen.insert(n.as_str()) && text.contains(&format!("]({})", destination(dir, n)))).collect()
    };
    if names.is_empty() {
        return text.to_string();
    }
    let stem = copy.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Conflict".into());
    let Some(new_dir) = (1..1000).map(|n| dir_name(&stem, n)).find(|d| !parent.join(d).exists()) else { return text.to_string() };
    let mut out = text.to_string();
    for name in names {
        let target = parent.join(&new_dir).join(name);
        let copied = std::fs::create_dir_all(parent.join(&new_dir)).and_then(|()| std::fs::copy(from.join(name), &target));
        if copied.is_ok() {
            out = out.replace(&format!("]({})", destination(dir, name)), &format!("]({})", destination(&new_dir, name)));
        }
    }
    out
}

/// A synced file moved to another folder in Markie: its images folder goes
/// with it, keeping its name, so every link still works. A rename in place
/// changes nothing. Call after the record has moved (`store::move_path`).
pub fn follow_move(db: &Connection, from: &Path, to: &Path) -> crate::Result<()> {
    let Some(rec) = store::get(db, to)? else { return Ok(()) };
    let Some(dir) = rec.images_dir.filter(|d| safe_dir(d)) else { return Ok(()) };
    let (Some(a), Some(b)) = (from.parent(), to.parent()) else { return Ok(()) };
    if a == b {
        return Ok(());
    }
    let (old, new) = (a.join(&dir), b.join(&dir));
    if old.is_dir() && !new.exists() {
        std::fs::rename(&old, &new)?;
    }
    Ok(())
}

/// An image line as the converter writes it: the form markie-rich writes
/// back, so an editor save never changes it.
pub fn markdown_image(alt: &str, destination: &str) -> String {
    format!("![{}]({destination})", clean_alt(alt))
}

/// `dir/name`, percent-encoded so it holds only characters markie-rich's
/// `normalize_href` keeps and no space or bracket.
pub fn destination(dir: &str, name: &str) -> String {
    let mut out = String::new();
    for b in format!("{dir}/{name}").bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Alt text that reads back as itself in Markdown and through markie-rich's
/// parse and save: no characters that would start markup, one space
/// between words, at most 200 characters, "Image" when empty.
pub fn clean_alt(alt: &str) -> String {
    let chars: Vec<char> = alt.chars().collect();
    let word = |c: Option<&char>| c.is_some_and(|c| c.is_alphanumeric());
    let mapped: String = chars
        .iter()
        .enumerate()
        .map(|(i, &c)| match c {
            '\\' | '[' | ']' | '*' | '`' | '~' | '<' | '>' | '&' | '|' | '{' | '}' | '$' | '^' => ' ',
            '_' if !(i > 0 && word(chars.get(i - 1)) && word(chars.get(i + 1))) => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let joined = mapped.split_whitespace().collect::<Vec<_>>().join(" ");
    let short: String = joined.chars().take(200).collect();
    let short = short.trim().to_string();
    if short.is_empty() { "Image".into() } else { short }
}

/// A file extension for an image content type, or None when the response
/// is not an image.
pub fn extension(content_type: &str) -> Option<&'static str> {
    let mime = content_type.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    Some(match mime.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" | "image/pjpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/bmp" | "image/x-ms-bmp" => "bmp",
        "image/tiff" => "tiff",
        "image/heic" => "heic",
        "image/heif" => "heif",
        "image/avif" => "avif",
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        _ => return None,
    })
}

/// An object ID as a file name's first part: letters, digits, `.`, `-` and
/// `_` only, no leading dot.
fn file_part(id: &str) -> String {
    let s: String = id.chars().take(100).map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).collect();
    let s = s.trim_start_matches('.').to_string();
    if s.is_empty() { "image".into() } else { s }
}

/// A name Markie could have written: one plain file name, nothing that
/// climbs out of the folder.
fn safe_name(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// One folder name beside the file, nothing that leaves the file's folder.
fn safe_dir(dir: &str) -> bool {
    !dir.is_empty() && dir != "." && dir != ".." && !dir.contains(['/', '\\']) && !dir.chars().any(char::is_control)
}

fn dir_name(stem: &str, n: usize) -> String {
    if n == 1 { format!("{stem} images") } else { format!("{stem} images ({n})") }
}

/// A new images folder name for `md`: not on disk, and not another synced
/// file's in the same folder.
fn choose_dir(db: &Connection, md: &Path) -> String {
    let stem = md.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Untitled".into());
    let parent = md.parent().unwrap_or(Path::new("."));
    let claimed: HashSet<String> = store::all(db).unwrap_or_default().into_iter().filter(|(p, _)| p.parent() == Some(parent) && p != md).filter_map(|(_, r)| r.images_dir).collect();
    (1..10_000).map(|n| dir_name(&stem, n)).find(|d| !claimed.contains(d) && !parent.join(d).exists()).unwrap_or_else(|| dir_name(&stem, 10_000))
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if std::fs::read(path).is_ok_and(|b| b == bytes) {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    markie_core::save::atomic_write(path, bytes).map_err(|e| std::io::Error::other(e.to_string()))
}

/// Every tab's content: each tab's `documentTab`, or the Doc itself when it
/// was read without tabs.
fn tab_contents_mut(doc: &mut Value) -> Vec<&mut Value> {
    fn walk<'a>(tabs: &'a mut [Value], out: &mut Vec<&'a mut Value>) {
        for tab in tabs {
            let Some(obj) = tab.as_object_mut() else { continue };
            let mut children = None;
            let mut content = None;
            for (k, v) in obj.iter_mut() {
                match k.as_str() {
                    "documentTab" => content = Some(v),
                    "childTabs" => children = v.as_array_mut(),
                    _ => {}
                }
            }
            if let Some(c) = content {
                out.push(c);
            }
            if let Some(ch) = children {
                walk(ch, out);
            }
        }
    }
    let tabbed = doc.get("tabs").and_then(Value::as_array).is_some_and(|t| !t.is_empty());
    if !tabbed {
        return vec![doc];
    }
    let mut out = Vec::new();
    if let Some(tabs) = doc.get_mut("tabs").and_then(Value::as_array_mut) {
        walk(tabs, &mut out);
    }
    out
}

const OBJECT_MAPS: [(&str, &str); 2] = [("inlineObjects", "inlineObjectProperties"), ("positionedObjects", "positionedObjectProperties")];

/// Each image object's `contentUri`, by object ID.
fn content_uris(doc: &mut Value) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for tab in tab_contents_mut(doc) {
        for (map, props) in OBJECT_MAPS {
            let Some(objects) = tab.get(map).and_then(Value::as_object) else { continue };
            for (id, obj) in objects {
                if let Some(uri) = obj.pointer(&format!("/{props}/embeddedObject/imageProperties/contentUri")).and_then(Value::as_str).filter(|u| !u.is_empty()) {
                    out.insert(id.clone(), uri.to_string());
                }
            }
        }
    }
    out
}

/// Set (or clear) `LOCAL_SRC` on each image object.
fn mark(doc: &mut Value, dests: &HashMap<String, String>) {
    for tab in tab_contents_mut(doc) {
        for (map, props) in OBJECT_MAPS {
            let Some(objects) = tab.get_mut(map).and_then(Value::as_object_mut) else { continue };
            for (id, obj) in objects.iter_mut() {
                let Some(embedded) = obj.pointer_mut(&format!("/{props}/embeddedObject")).and_then(Value::as_object_mut) else { continue };
                match dests.get(id) {
                    Some(d) => {
                        embedded.insert(LOCAL_SRC.into(), Value::String(d.clone()));
                    }
                    None => {
                        embedded.remove(LOCAL_SRC);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destinations_have_no_space_or_bracket() {
        assert_eq!(destination("Field notes images", "kix.abc.png"), "Field%20notes%20images/kix.abc.png");
        assert_eq!(destination("Plan (2) images", "kix.a.png"), "Plan%20%282%29%20images/kix.a.png");
        assert_eq!(destination("Río? #1 images", "a.png"), "R%C3%ADo%3F%20%231%20images/a.png");
    }

    #[test]
    fn alt_text_never_starts_markup() {
        assert_eq!(clean_alt("Sales by month"), "Sales by month");
        assert_eq!(clean_alt("  *bold* [link]  `code`\nnext "), "bold link code next");
        assert_eq!(clean_alt("IMG_1234 _lead trail_"), "IMG_1234 lead trail");
        assert_eq!(clean_alt(""), "Image");
        assert_eq!(clean_alt("<>&"), "Image");
        assert_eq!(clean_alt(&"x".repeat(300)).len(), 200);
    }

    #[test]
    fn extensions_come_from_image_content_types_only() {
        assert_eq!(extension("image/png"), Some("png"));
        assert_eq!(extension("image/jpeg; charset=binary"), Some("jpg"));
        assert_eq!(extension("IMAGE/GIF"), Some("gif"));
        assert_eq!(extension("text/html"), None);
        assert_eq!(extension(""), None);
    }

    #[test]
    fn object_ids_become_plain_file_names() {
        assert_eq!(file_part("kix.l2ci2pwg5ppy"), "kix.l2ci2pwg5ppy");
        assert_eq!(file_part("../etc/passwd"), "_etc_passwd");
        assert_eq!(file_part(""), "image");
        assert!(safe_name("kix.a.png") && !safe_name("../a.png") && !safe_name("a/b.png") && !safe_name(".hidden"));
        assert!(safe_dir("Field notes images") && !safe_dir("..") && !safe_dir("../x") && !safe_dir("a/b") && !safe_dir(""));
    }
}
