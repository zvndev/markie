//! What the History page shows, without drawing it: which rows the list
//! has, which version each row compares with, and where ↑, ↓ and the
//! Older and Newer arrows go. The rules are Electron's
//! `version-history-view.tsx`; the view is `history_page.rs`.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, TimeZone};

use markie_core::history::Version;
use markie_core::version_list::{COLLAPSE_WINDOW_MS, VersionGroup, group_versions};

/// A row of the list: the text on screen, or a stored version by stamp.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum VersionId {
    Current,
    Stamp(String),
}

pub(super) struct HistoryModel {
    /// Every stored version, newest first.
    pub entries: Vec<Version>,
    /// Version texts read so far, by stamp (None: unreadable).
    pub contents: HashMap<String, Option<String>>,
    /// The buffer in its on-disk form.
    pub current: String,
    /// Unsaved edits: the current version is not on disk yet.
    pub dirty: bool,
    pub selected: VersionId,
    /// Leads whose folded minor versions are showing.
    pub expanded: HashSet<String>,
    /// "Which versions": named versions only.
    pub named_only: bool,
}

impl HistoryModel {
    pub fn new(entries: Vec<Version>, current: String, dirty: bool) -> Self {
        Self {
            entries,
            contents: HashMap::new(),
            current,
            dirty,
            selected: VersionId::Current,
            expanded: HashSet::new(),
            named_only: false,
        }
    }

    /// The newest stored version holds exactly the current text (an agent's
    /// write recorded as it landed, or a version named from here): it is the
    /// current version, not a row of its own.
    pub fn top_is_current(&self) -> bool {
        !self.dirty
            && self
                .entries
                .first()
                .is_some_and(|top| self.contents.get(&top.stamp).and_then(|c| c.as_deref()) == Some(self.current.as_str()))
    }

    /// The stored versions the list shows as rows of their own.
    pub fn stored(&self) -> &[Version] {
        if self.top_is_current() { &self.entries[1..] } else { &self.entries }
    }

    /// The stored copy of the current version, whose name and author it takes.
    pub fn current_entry(&self) -> Option<&Version> {
        self.top_is_current().then(|| &self.entries[0])
    }

    pub fn entry(&self, stamp: &str) -> Option<&Version> {
        self.entries.iter().find(|e| e.stamp == stamp)
    }

    /// The list's sections. Today is always there (it holds the current
    /// row) unless only named versions show.
    pub fn groups<Tz: TimeZone>(&self, now: &DateTime<Tz>) -> Vec<VersionGroup>
    where
        Tz::Offset: std::fmt::Display,
    {
        let list: Vec<Version> = self.stored().iter().filter(|e| !self.named_only || e.meta.name.is_some()).cloned().collect();
        let mut groups = group_versions(&list, now, COLLAPSE_WINDOW_MS);
        if !self.named_only && groups.first().is_none_or(|g| g.key != "today") {
            groups.insert(0, VersionGroup { key: "today".into(), label: "Today".into(), rows: Vec::new() });
        }
        groups
    }

    /// The version before `id`, or before the end of its folded run: what
    /// "Highlight changes" compares it with. The current version compares
    /// with the newest stored one that is not itself.
    pub fn base_for(&self, id: &VersionId, run: &[Version]) -> Option<String> {
        let stamp = match id {
            VersionId::Current => return self.stored().first().map(|e| e.stamp.clone()),
            VersionId::Stamp(s) => s,
        };
        let last = run.last().map_or(stamp.as_str(), |r| r.stamp.as_str());
        let i = self.entries.iter().position(|e| e.stamp == last)?;
        self.entries.get(i + 1).map(|e| e.stamp.clone())
    }

    /// Every row the list shows, in order, with its base: what the arrow
    /// keys and the Older and Newer buttons step through.
    pub fn visible<Tz: TimeZone>(&self, now: &DateTime<Tz>) -> Vec<(VersionId, Option<String>)>
    where
        Tz::Offset: std::fmt::Display,
    {
        let mut out = Vec::new();
        if !self.named_only {
            out.push((VersionId::Current, self.base_for(&VersionId::Current, &[])));
        }
        for group in self.groups(now) {
            for row in group.rows {
                let id = VersionId::Stamp(row.lead.stamp.clone());
                let open = self.expanded.contains(&row.lead.stamp);
                let base = self.base_for(&id, if open { &[] } else { &row.minor });
                out.push((id, base));
                if open {
                    for m in &row.minor {
                        let id = VersionId::Stamp(m.stamp.clone());
                        let base = self.base_for(&id, &[]);
                        out.push((id, base));
                    }
                }
            }
        }
        out
    }

    /// The selected row's base, as the list shows it now: a folded lead
    /// compares with the version before its whole run.
    pub fn selected_base<Tz: TimeZone>(&self, now: &DateTime<Tz>) -> Option<String>
    where
        Tz::Offset: std::fmt::Display,
    {
        self.visible(now)
            .into_iter()
            .find(|(id, _)| *id == self.selected)
            .map(|(_, base)| base)
            .unwrap_or_else(|| self.base_for(&self.selected, &[]))
    }

    /// Where a step lands: one row down is older, one row up newer. A
    /// selection the list does not show (only named versions, with the
    /// current one selected) steps to the first row, as Electron's does.
    fn step_target<Tz: TimeZone>(&self, older: bool, now: &DateTime<Tz>) -> Option<VersionId>
    where
        Tz::Offset: std::fmt::Display,
    {
        let rows = self.visible(now);
        if rows.is_empty() {
            return None;
        }
        let i = rows.iter().position(|(id, _)| *id == self.selected).map_or(-1, |i| i as isize);
        let next = (i + if older { 1 } else { -1 }).clamp(0, rows.len() as isize - 1) as usize;
        Some(rows[next].0.clone())
    }

    pub fn can_step<Tz: TimeZone>(&self, older: bool, now: &DateTime<Tz>) -> bool
    where
        Tz::Offset: std::fmt::Display,
    {
        self.step_target(older, now).is_some_and(|id| id != self.selected)
    }

    /// ↓ or Older (true), ↑ or Newer (false). Whether the selection moved.
    pub fn step<Tz: TimeZone>(&mut self, older: bool, now: &DateTime<Tz>) -> bool
    where
        Tz::Offset: std::fmt::Display,
    {
        match self.step_target(older, now) {
            Some(id) if id != self.selected => {
                self.selected = id;
                true
            }
            _ => false,
        }
    }

    /// Fold or unfold a lead's minor versions.
    pub fn toggle_expanded(&mut self, stamp: &str) {
        if !self.expanded.remove(stamp) {
            self.expanded.insert(stamp.to_string());
        }
    }

    /// The text of a row, if read: the buffer for the current version.
    pub fn content_of(&self, id: &VersionId) -> Option<Option<&str>> {
        match id {
            VersionId::Current => Some(Some(self.current.as_str())),
            VersionId::Stamp(s) => self.contents.get(s).map(|c| c.as_deref()),
        }
    }

    /// Stamps the page needs read now: the selection, its base, and the
    /// newest version (to tell whether it is the current text).
    pub fn needs<Tz: TimeZone>(&self, now: &DateTime<Tz>) -> Vec<String>
    where
        Tz::Offset: std::fmt::Display,
    {
        let mut out: Vec<String> = Vec::new();
        let mut want = |s: Option<String>| {
            if let Some(s) = s {
                if !self.contents.contains_key(&s) && !out.contains(&s) {
                    out.push(s);
                }
            }
        };
        want(self.entries.first().map(|e| e.stamp.clone()));
        if let VersionId::Stamp(s) = &self.selected {
            want(Some(s.clone()));
        }
        want(self.selected_base(now));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::{HistoryModel, VersionId};
    use chrono::{DateTime, FixedOffset};
    use markie_core::history::{Version, VersionMeta};

    fn now() -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339("2026-11-25T15:00:00+00:00").unwrap()
    }

    fn v(stamp: &str, iso: &str, name: Option<&str>) -> Version {
        Version {
            stamp: stamp.into(),
            ms: None,
            bytes: 0,
            meta: VersionMeta { author: "user".into(), iso: Some(iso.into()), agent: None, name: name.map(Into::into) },
        }
    }

    /// Newest first: a and b fold (ten minutes apart, same author), c is
    /// named, d is yesterday.
    fn model() -> HistoryModel {
        let entries = vec![
            v("a", "2026-11-25T14:50:00+00:00", None),
            v("b", "2026-11-25T14:40:00+00:00", None),
            v("c", "2026-11-25T11:00:00+00:00", Some("Outline done")),
            v("d", "2026-11-24T09:00:00+00:00", None),
        ];
        let mut m = HistoryModel::new(entries, "now".into(), false);
        for (s, t) in [("a", "A"), ("b", "B"), ("c", "C"), ("d", "D")] {
            m.contents.insert(s.into(), Some(t.into()));
        }
        m
    }

    fn ids(m: &HistoryModel) -> Vec<String> {
        m.visible(&now())
            .into_iter()
            .map(|(id, base)| match id {
                VersionId::Current => format!("current<{}", base.unwrap_or_default()),
                VersionId::Stamp(s) => format!("{s}<{}", base.unwrap_or_default()),
            })
            .collect()
    }

    #[test]
    fn a_folded_run_compares_with_the_version_before_the_run() {
        let mut m = model();
        assert_eq!(ids(&m), ["current<a", "a<c", "c<d", "d<"]);
        m.toggle_expanded("a");
        assert_eq!(ids(&m), ["current<a", "a<b", "b<c", "c<d", "d<"]);
    }

    #[test]
    fn arrows_step_one_row_and_stop_at_the_ends() {
        let mut m = model();
        assert!(!m.can_step(false, &now()), "nothing newer than the current version");
        assert!(m.step(true, &now()));
        assert_eq!(m.selected, VersionId::Stamp("a".into()));
        assert_eq!(m.selected_base(&now()).as_deref(), Some("c"));
        while m.step(true, &now()) {}
        assert_eq!(m.selected, VersionId::Stamp("d".into()));
        assert!(!m.can_step(true, &now()));
        assert!(m.step(false, &now()));
        assert_eq!(m.selected, VersionId::Stamp("c".into()));
    }

    #[test]
    fn the_newest_version_that_is_the_current_text_is_not_a_row() {
        let mut m = model();
        m.current = "A".into();
        assert!(m.top_is_current());
        assert_eq!(m.current_entry().map(|e| e.stamp.as_str()), Some("a"));
        assert_eq!(ids(&m), ["current<b", "b<c", "c<d", "d<"]);
        // Unsaved edits: the stored copy is a version of its own again.
        m.dirty = true;
        assert!(!m.top_is_current());
    }

    #[test]
    fn named_only_lists_named_versions_and_steps_from_the_first() {
        let mut m = model();
        m.named_only = true;
        assert_eq!(ids(&m), ["c<d"]);
        assert!(m.step(true, &now()));
        assert_eq!(m.selected, VersionId::Stamp("c".into()));
    }

    #[test]
    fn the_page_reads_only_what_it_shows() {
        let mut m = HistoryModel::new(vec![v("a", "2026-11-25T14:50:00+00:00", None), v("b", "2026-11-20T14:40:00+00:00", None)], "x".into(), false);
        assert_eq!(m.needs(&now()), ["a"]);
        m.contents.insert("a".into(), Some("A".into()));
        m.selected = VersionId::Stamp("a".into());
        assert_eq!(m.needs(&now()), ["b"]);
    }
}
