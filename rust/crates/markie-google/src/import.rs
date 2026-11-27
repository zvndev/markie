//! Picking, importing, refreshing and Save as Word, over any `DocsSource`.
//!
//! - A picked Doc is written to `<folder>/<title>.md`. A title that is taken
//!   gets " (2)", " (3)" and so on; an existing file is never overwritten
//!   unless it is that Doc's own file.
//! - A picked folder: Markie lists the Docs inside it. Whether `drive.file`
//!   covers them is unverified. If the list is empty or a Doc in it can't be
//!   read, the report names the folder so the app asks for the files themselves.
//! - Refresh re-reads a Doc only when Drive's `version` moved. While sync is
//!   one-way, a local file edited since the last sync is kept as a dated
//!   conflict copy beside it before Google's text replaces it.
//! - Save as Word exports `.docx` beside the Markdown file. One-way. It is
//!   Google's own export, so it has the Doc's images in it.
//! - Images are saved beside the file on import and Refresh (`images.rs`); a
//!   conflict copy gets its own copies of the images it shows.
use crate::api::{DocsSource, DriveFile};
use crate::convert::doc_to_markdown;
use crate::error::{GoogleError, Result};
use crate::images::{self, Known, Saved};
use crate::store::{self, SyncRecord};
use chrono::{DateTime, Local};
use rusqlite::Connection;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
    /// The Doc being read now.
    pub current: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// A new file.
    New,
    /// Google's newer text replaced the file.
    Updated,
    /// Nothing changed in Google since the last sync.
    Unchanged,
    /// The local file had edits: they were kept at this path, then Google's text replaced the file.
    ConflictCopy(PathBuf),
    /// Two-way sync sent Markie's edits to Google; nothing came back.
    Pushed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Imported {
    pub path: PathBuf,
    pub title: String,
    pub doc_id: String,
    pub outcome: Outcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Report {
    pub imported: Vec<Imported>,
    /// Picked folders whose Docs Markie could not read: ask for the files.
    pub folders_without_access: Vec<String>,
    /// Picked items that are not Google Docs (a Sheet, a PDF): name and why.
    pub skipped: Vec<(String, String)>,
    /// Docs that failed: name (or ID) and the sentence to show.
    pub errors: Vec<(String, String)>,
}

impl Report {
    /// The one line the app shows when an import ends.
    pub fn summary(&self) -> String {
        let n = self.imported.len();
        let mut parts = vec![match n {
            0 => "No Google Docs were imported.".to_string(),
            1 => "Imported 1 Google Doc.".to_string(),
            n => format!("Imported {n} Google Docs."),
        }];
        let copies = self.imported.iter().filter(|i| matches!(i.outcome, Outcome::ConflictCopy(_))).count();
        if copies > 0 {
            parts.push(format!("Your edits to {copies} {} were kept as a conflict copy.", if copies == 1 { "file" } else { "files" }));
        }
        for folder in &self.folders_without_access {
            parts.push(folder_note(folder));
        }
        if !self.skipped.is_empty() {
            parts.push(format!("{} picked {} not Google Docs and were skipped.", self.skipped.len(), if self.skipped.len() == 1 { "item is" } else { "items are" }));
        }
        if !self.errors.is_empty() {
            parts.push(format!("{} couldn't be imported.", self.errors.len()));
        }
        parts.join(" ")
    }
}

/// What the app says when a folder pick didn't bring its files.
pub fn folder_note(name: &str) -> String {
    format!("Google didn't let Markie read the Docs in \u{201c}{name}\u{201d}. Import from Google Docs again and pick the files themselves.")
}

/// A safe file name for a Doc title: no path separators or control
/// characters, no leading dot, at most 120 characters.
pub fn file_stem(title: &str) -> String {
    let cleaned: String = title.chars().map(|c| if matches!(c, '/' | '\\' | ':') || c.is_control() { '-' } else { c }).collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_start_matches(['.', ' ']).trim_end_matches(['.', ' ']);
    let mut stem: String = trimmed.chars().take(120).collect();
    stem = stem.trim_end_matches(['.', ' ']).to_string();
    if stem.is_empty() { "Untitled".into() } else { stem }
}

/// Reserve a new file `<stem>.<ext>`, or `<stem> (n).<ext>`, that does not
/// exist and is not another Doc's file. The file is created empty so nothing
/// else can take the name.
pub fn reserve(db: &Connection, folder: &Path, stem: &str, ext: &str) -> Result<PathBuf> {
    for n in 1..10_000 {
        let name = if n == 1 { format!("{stem}.{ext}") } else { format!("{stem} ({n}).{ext}") };
        let path = folder.join(name);
        if store::get(db, &path)?.is_some() {
            continue;
        }
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(GoogleError::Io(format!("no free name for {stem}.{ext}")))
}

/// The dated copy that keeps local edits: `Plan (conflict 2026-11-25 14.03).md`.
/// The images it shows are copied beside it (`images::copy_for`).
pub fn conflict_copy(db: &Connection, path: &Path, text: &str, now: DateTime<Local>, images: &Known) -> Result<PathBuf> {
    let folder = path.parent().unwrap_or(Path::new("."));
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Untitled".into());
    let ext = path.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "md".into());
    let copy = reserve(db, folder, &format!("{stem} (conflict {})", now.format("%Y-%m-%d %H.%M")), &ext)?;
    let text = images::copy_for(path, &copy, images, text);
    markie_core::save::atomic_write(&copy, text.as_bytes())?;
    Ok(copy)
}

pub(crate) fn record_for(file: &DriveFile, doc: &Value, markdown: &str, tabs: usize, now: DateTime<Local>, previous: Option<&SyncRecord>) -> SyncRecord {
    let access = file.access();
    // Docs this account doesn't own send suggestions unless the person chose otherwise.
    let chosen = previous.is_some_and(|p| p.suggest_chosen);
    let suggest = if chosen { previous.is_some_and(|p| p.suggest) } else { !access.owned && (access.can_edit || access.can_comment) };
    SyncRecord {
        doc_id: file.id.clone(),
        title: doc.get("title").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| file.name.clone()),
        revision_id: doc.get("revisionId").and_then(Value::as_str).map(str::to_string),
        version: file.version.clone(),
        modified_time: file.modified_time.clone(),
        synced_at: now.to_rfc3339(),
        base_markdown: markdown.to_string(),
        tabs,
        docx_path: previous.and_then(|p| p.docx_path.clone()),
        error: None,
        two_way: previous.is_some_and(|p| p.two_way),
        suggest,
        suggest_chosen: chosen,
        access: Some(access),
        held: Vec::new(),
        held_hash: None,
        conflict: previous.and_then(|p| p.conflict.clone()),
        stopped: None,
        pushed_at: previous.and_then(|p| p.pushed_at.clone()),
        images_dir: previous.and_then(|p| p.images_dir.clone()),
        images: previous.map(|p| p.images.clone()).unwrap_or_default(),
    }
}

/// Write Google's text to `path`, keeping local edits as a conflict copy first.
fn apply_remote(db: &Connection, path: &Path, previous: Option<&SyncRecord>, markdown: &str, now: DateTime<Local>, images: &Known) -> Result<Outcome> {
    let local = std::fs::read_to_string(path).ok();
    let mut outcome = Outcome::Updated;
    if let Some(local) = &local {
        if local == markdown {
            return Ok(Outcome::Unchanged);
        }
        let edited = previous.is_none_or(|p| !p.matches_base(local)) && !local.trim().is_empty();
        if edited {
            outcome = Outcome::ConflictCopy(conflict_copy(db, path, local, now, images)?);
        }
    }
    markie_core::save::atomic_write(path, markdown.as_bytes())?;
    Ok(outcome)
}

/// Import one Doc that `file` describes. A Doc imported before is refreshed
/// in its own file. `two_way` turns two-way sync on for it (it stays on if it was).
pub fn import_doc(src: &dyn DocsSource, db: &Connection, folder: &Path, file: &DriveFile, now: DateTime<Local>, two_way: bool) -> Result<Imported> {
    let mut doc = src.document(&file.id)?;
    let title = doc.get("title").and_then(Value::as_str).unwrap_or(&file.name).to_string();
    let (path, previous, fresh) = match store::by_doc(db, &file.id)? {
        Some((path, rec)) => (path, Some(rec), false),
        None => {
            std::fs::create_dir_all(folder)?;
            (reserve(db, folder, &file_stem(&title), "md")?, None, true)
        }
    };
    let prior = previous.as_ref().map(Saved::of).unwrap_or_default();
    let mut saved = images::localize(src, db, &mut doc, &path, &prior, true);
    let known = Known::of(&[&prior, &saved]);
    let converted = doc_to_markdown(&doc);
    let outcome = if fresh {
        markie_core::save::atomic_write(&path, converted.markdown.as_bytes())?;
        Outcome::New
    } else {
        apply_remote(db, &path, previous.as_ref(), &converted.markdown, now, &known)?
    };
    images::prune(&path, &known, &mut saved, &converted.markdown);
    let mut record = record_for(file, &doc, &converted.markdown, converted.tabs, now, previous.as_ref());
    saved.store(&mut record);
    record.two_way = two_way || record.two_way;
    store::put(db, &path, &record)?;
    Ok(Imported { path, title, doc_id: file.id.clone(), outcome })
}

/// Import what the Picker returned. `two_way`: "Keep these Docs in sync both ways".
#[allow(clippy::too_many_arguments)]
pub fn import_picked(
    src: &dyn DocsSource,
    db: &Connection,
    folder: &Path,
    ids: &[String],
    now: DateTime<Local>,
    two_way: bool,
    progress: &mut dyn FnMut(&Progress),
    cancel: &AtomicBool,
) -> Result<Report> {
    let mut report = Report::default();
    // (file, the picked folder it came from)
    let mut queue: Vec<(DriveFile, Option<String>)> = Vec::new();
    for id in ids {
        if cancel.load(Ordering::SeqCst) {
            return Err(GoogleError::Cancelled);
        }
        let file = match src.file(id) {
            Ok(f) => f,
            Err(e) => {
                report.errors.push((id.clone(), e.to_string()));
                continue;
            }
        };
        if file.is_folder() {
            match src.folder_docs(&file.id) {
                Ok(docs) if !docs.is_empty() => queue.extend(docs.into_iter().map(|d| (d, Some(file.name.clone())))),
                Ok(_) | Err(GoogleError::NoAccess(_)) => report.folders_without_access.push(file.name.clone()),
                Err(e) => report.errors.push((file.name.clone(), e.to_string())),
            }
        } else if file.is_doc() {
            if !queue.iter().any(|(q, _)| q.id == file.id) {
                queue.push((file, None));
            }
        } else {
            report.skipped.push((file.name.clone(), "not a Google Doc".into()));
        }
    }
    let total = queue.len();
    for (done, (file, from_folder)) in queue.into_iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(GoogleError::Cancelled);
        }
        progress(&Progress { done, total, current: file.name.clone() });
        match import_doc(src, db, folder, &file, now, two_way) {
            Ok(imported) => report.imported.push(imported),
            Err(GoogleError::NoAccess(_)) if from_folder.is_some() => {
                let name = from_folder.unwrap_or_default();
                if !report.folders_without_access.contains(&name) {
                    report.folders_without_access.push(name);
                }
            }
            Err(e) => report.errors.push((file.name.clone(), e.to_string())),
        }
    }
    progress(&Progress { done: total, total, current: String::new() });
    Ok(report)
}

/// "Refresh from Google" for one file.
pub fn refresh(src: &dyn DocsSource, db: &Connection, path: &Path, now: DateTime<Local>) -> Result<Outcome> {
    let mut record = store::get(db, path)?.ok_or_else(|| GoogleError::Store("this file is not synced with Google".into()))?;
    let result = (|| {
        let file = src.file(&record.doc_id)?;
        if file.trashed {
            return Err(GoogleError::NoAccess("trashed".into()));
        }
        if file.version.is_some() && file.version == record.version && path.exists() {
            return Ok((Outcome::Unchanged, None));
        }
        let mut doc = src.document(&record.doc_id)?;
        let prior = Saved::of(&record);
        let mut saved = images::localize(src, db, &mut doc, path, &prior, true);
        let known = Known::of(&[&prior, &saved]);
        let converted = doc_to_markdown(&doc);
        let outcome = apply_remote(db, path, Some(&record), &converted.markdown, now, &known)?;
        images::prune(path, &known, &mut saved, &converted.markdown);
        let mut fresh = record_for(&file, &doc, &converted.markdown, converted.tabs, now, Some(&record));
        saved.store(&mut fresh);
        Ok((outcome, Some(fresh)))
    })();
    match result {
        Ok((outcome, fresh)) => {
            match fresh {
                Some(fresh) => store::put(db, path, &fresh)?,
                None if record.error.is_some() => {
                    record.error = None;
                    store::put(db, path, &record)?;
                }
                None => {}
            }
            Ok(outcome)
        }
        Err(e) => {
            record.error = Some(match &e {
                GoogleError::NoAccess(m) if m == "trashed" => "This Doc is in the trash in Google.".into(),
                other => other.to_string(),
            });
            store::put(db, path, &record)?;
            Err(e)
        }
    }
}

/// "Refresh All from Google".
pub fn refresh_all(src: &dyn DocsSource, db: &Connection, now: DateTime<Local>, progress: &mut dyn FnMut(&Progress), cancel: &AtomicBool) -> Result<Vec<(PathBuf, Result<Outcome>)>> {
    let records = store::all(db)?;
    let total = records.len();
    let mut out = Vec::new();
    for (done, (path, rec)) in records.into_iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(GoogleError::Cancelled);
        }
        progress(&Progress { done, total, current: rec.title.clone() });
        let r = refresh(src, db, &path, now);
        out.push((path, r));
    }
    progress(&Progress { done: total, total, current: String::new() });
    Ok(out)
}

/// "Save as Word": Google's own `.docx` export beside the Markdown file.
/// The same Doc's earlier copy is replaced; any other file keeps its name.
pub fn save_as_word(src: &dyn DocsSource, db: &Connection, path: &Path) -> Result<PathBuf> {
    let mut record = store::get(db, path)?.ok_or_else(|| GoogleError::Store("this file is not synced with Google".into()))?;
    let bytes = src.export(&record.doc_id, crate::DOCX_MIME)?;
    let folder = path.parent().unwrap_or(Path::new("."));
    let target = match record.docx_path.as_ref().filter(|p| p.parent() == Some(folder) && p.exists()) {
        Some(previous) => previous.clone(),
        None => {
            let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| file_stem(&record.title));
            reserve(db, folder, &stem, "docx")?
        }
    };
    markie_core::save::atomic_write(&target, &bytes)?;
    record.docx_path = Some(target.clone());
    store::put(db, path, &record)?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_become_safe_file_names() {
        assert_eq!(file_stem("Q3 plan: draft/final"), "Q3 plan- draft-final");
        assert_eq!(file_stem("  ..hidden  "), "hidden");
        assert_eq!(file_stem("\u{7}"), "-");
        assert_eq!(file_stem("   "), "Untitled");
        assert_eq!(file_stem(&"a".repeat(300)).chars().count(), 120);
    }
}
