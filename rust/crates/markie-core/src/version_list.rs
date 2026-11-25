//! The shape of the History page's version list, as pure functions: which
//! section a version falls in, which autosaves fold into one row, and what
//! to call who wrote it. A port of Electron's `src/lib/version-history.ts`.

use chrono::{DateTime, Datelike, TimeZone};

use crate::history::Version;

const MINUTE: i64 = 60_000;

/// Autosaves this close to the newest one in a run fold under it.
pub const COLLAPSE_WINDOW_MS: i64 = 30 * MINUTE;

#[derive(Clone, Debug, PartialEq)]
pub struct VersionRow {
    /// The newest version in the run: the row the panel shows.
    pub lead: Version,
    /// Older versions folded under it, newest first. Empty for a single row.
    pub minor: Vec<Version>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VersionGroup {
    pub key: String,
    pub label: String,
    pub rows: Vec<VersionRow>,
}

/// When a version was written: its recorded time, else its stamp's, else
/// the epoch (`versionMs` over `history.list`'s `iso`).
pub fn version_ms(v: &Version) -> i64 {
    v.meta
        .iso
        .as_deref()
        .and_then(|iso| DateTime::parse_from_rfc3339(iso).ok())
        .map(|d| d.timestamp_millis())
        .or(v.ms)
        .unwrap_or(0)
}

fn at<Tz: TimeZone>(ms: i64, now: &DateTime<Tz>) -> DateTime<Tz> {
    now.timezone().timestamp_millis_opt(ms).single().unwrap_or_else(|| now.clone())
}

/// Calendar days, not 24-hour blocks: 11pm last night is "Yesterday" at 8am.
fn days_ago<Tz: TimeZone>(ms: i64, now: &DateTime<Tz>) -> i64 {
    (now.date_naive() - at(ms, now).date_naive()).num_days()
}

/// Today, Yesterday, This week (the five days before that), then the month
/// by name, with the year once it is not this year (`sectionFor`).
pub fn section_for<Tz: TimeZone>(ms: i64, now: &DateTime<Tz>) -> (String, String)
where
    Tz::Offset: std::fmt::Display,
{
    let days = days_ago(ms, now);
    if days <= 0 {
        return ("today".into(), "Today".into());
    }
    if days == 1 {
        return ("yesterday".into(), "Yesterday".into());
    }
    if days < 7 {
        return ("week".into(), "This week".into());
    }
    let d = at(ms, now);
    let month = d.format("%B").to_string();
    let label = if d.year() == now.year() { month } else { format!("{month} {}", d.year()) };
    (format!("m-{}-{}", d.year(), d.month0()), label)
}

/// Who wrote a version, as one key: two agents are two authors.
pub fn author_key(author: &str, agent: Option<&str>) -> String {
    if author == "agent" { format!("agent:{}", agent.unwrap_or("")) } else { author.to_string() }
}

fn key_of(v: &Version) -> String {
    author_key(&v.meta.author, v.meta.agent.as_deref())
}

/// `groupVersions`: newest-first versions in sections, with runs of unnamed
/// versions by one author within `window_ms` of the run's newest folded into
/// one expandable row. A named version always gets its own row.
pub fn group_versions<Tz: TimeZone>(entries: &[Version], now: &DateTime<Tz>, window_ms: i64) -> Vec<VersionGroup>
where
    Tz::Offset: std::fmt::Display,
{
    let mut groups: Vec<VersionGroup> = Vec::new();
    let mut open_row = false;
    for entry in entries {
        let ms = version_ms(entry);
        let (key, label) = section_for(ms, now);
        if groups.last().is_none_or(|g| g.key != key) {
            groups.push(VersionGroup { key, label, rows: Vec::new() });
            open_row = false;
        }
        let group = groups.last_mut().expect("a group was just pushed");
        let folds = open_row
            && group.rows.last().is_some_and(|row| {
                entry.meta.name.is_none()
                    && row.lead.meta.name.is_none()
                    && key_of(entry) == key_of(&row.lead)
                    && version_ms(&row.lead) - ms <= window_ms
            });
        if folds {
            group.rows.last_mut().expect("folds needs a row").minor.push(entry.clone());
        } else {
            group.rows.push(VersionRow { lead: entry.clone(), minor: Vec::new() });
            open_row = true;
        }
    }
    groups
}

/// "October 30, 2:30 PM", with the year once it is not this year.
pub fn format_version_time<Tz: TimeZone>(ms: i64, now: &DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let d = at(ms, now);
    let date = if d.year() == now.year() { d.format("%B %-d").to_string() } else { d.format("%B %-d, %Y").to_string() };
    format!("{date}, {}", d.format("%-I:%M %p"))
}

/// "Today, 2:30 PM" for the header, like the row but anchored to the day.
pub fn format_version_heading<Tz: TimeZone>(ms: i64, now: &DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let time = at(ms, now).format("%-I:%M %p").to_string();
    match days_ago(ms, now) {
        d if d <= 0 => format!("Today, {time}"),
        1 => format!("Yesterday, {time}"),
        _ => format_version_time(ms, now),
    }
}

/// `agentDisplayName`: what MCP clients call themselves, as a person would.
pub fn agent_display_name(raw: Option<&str>) -> String {
    let name = raw.unwrap_or("").trim();
    if name.is_empty() || name == "an agent" {
        return "An agent".into();
    }
    match name.to_lowercase().as_str() {
        "claude-code" => "Claude Code",
        "claude-ai" | "claude desktop" => "Claude",
        "codex-mcp-client" | "codex" => "Codex",
        "cursor-vscode" | "cursor" => "Cursor",
        "windsurf" => "Windsurf",
        "visual studio code" => "VS Code",
        "zed" => "Zed",
        "gemini-cli-mcp-client" => "Gemini CLI",
        "opencode" => "OpenCode",
        "t3code" | "t3-code" => "T3 Code",
        _ => return name.to_string(),
    }
    .into()
}

/// `authorLabel`.
pub fn author_label(author: &str, agent: Option<&str>) -> String {
    match author {
        "user" => "You".into(),
        "agent" => agent_display_name(agent),
        "external" => "External edit".into(),
        _ => "Unknown".into(),
    }
}

/// The dot colour beside an author (`authorColor`): you are always blue,
/// outside edits grey, and each agent gets its own hue from its name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthorTone {
    Blue,
    Muted,
    Purple,
    Orange,
    Green,
    Yellow,
    /// `#2dd4bf`.
    Teal,
    /// `#f472b6`.
    Pink,
}

pub fn author_tone(author: &str, agent: Option<&str>) -> AuthorTone {
    if author == "user" {
        return AuthorTone::Blue;
    }
    if author != "agent" {
        return AuthorTone::Muted;
    }
    const HUES: [AuthorTone; 6] =
        [AuthorTone::Purple, AuthorTone::Orange, AuthorTone::Green, AuthorTone::Yellow, AuthorTone::Teal, AuthorTone::Pink];
    let mut h: u32 = 0;
    for ch in agent_display_name(agent).chars() {
        h = h.wrapping_mul(31).wrapping_add(ch as u32);
    }
    HUES[(h % HUES.len() as u32) as usize]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::VersionMeta;
    use chrono::FixedOffset;

    fn now() -> DateTime<FixedOffset> {
        // A Wednesday afternoon, two hours behind UTC.
        DateTime::parse_from_rfc3339("2026-11-25T15:00:00-02:00").unwrap()
    }

    fn v(stamp: &str, iso: &str, author: &str, name: Option<&str>) -> Version {
        Version {
            stamp: stamp.into(),
            ms: None,
            bytes: 0,
            meta: VersionMeta { author: author.into(), iso: Some(iso.into()), agent: None, name: name.map(Into::into) },
        }
    }

    #[test]
    fn sections_follow_the_calendar() {
        let ms = |iso: &str| DateTime::parse_from_rfc3339(iso).unwrap().timestamp_millis();
        let n = now();
        assert_eq!(section_for(ms("2026-11-25T00:10:00-02:00"), &n).1, "Today");
        assert_eq!(section_for(ms("2026-11-24T23:50:00-02:00"), &n).1, "Yesterday");
        assert_eq!(section_for(ms("2026-11-19T12:00:00-02:00"), &n).1, "This week");
        assert_eq!(section_for(ms("2026-11-18T12:00:00-02:00"), &n), ("m-2026-10".into(), "November".into()));
        assert_eq!(section_for(ms("2025-10-30T12:00:00-02:00"), &n).1, "October 2025");
    }

    #[test]
    fn runs_of_autosaves_by_one_author_fold_and_names_stand_alone() {
        let list = vec![
            v("a", "2026-11-25T14:50:00-02:00", "user", None),
            v("b", "2026-11-25T14:40:00-02:00", "user", None),
            v("c", "2026-11-25T14:30:00-02:00", "user", Some("Draft one")),
            v("d", "2026-11-25T14:20:00-02:00", "user", None),
            v("e", "2026-11-25T14:15:00-02:00", "agent", None),
            v("f", "2026-11-25T12:00:00-02:00", "agent", None),
            v("g", "2026-11-24T12:00:00-02:00", "user", None),
        ];
        let groups = group_versions(&list, &now(), COLLAPSE_WINDOW_MS);
        assert_eq!(groups.iter().map(|g| g.label.as_str()).collect::<Vec<_>>(), ["Today", "Yesterday"]);
        let rows: Vec<(&str, usize)> = groups[0].rows.iter().map(|r| (r.lead.stamp.as_str(), r.minor.len())).collect();
        // a+b fold; c is named; d alone (named lead before it); e and f are
        // the same agent but more than 30 minutes apart.
        assert_eq!(rows, [("a", 1), ("c", 0), ("d", 0), ("e", 0), ("f", 0)]);
        assert_eq!(groups[1].rows.len(), 1, "a new section starts a new row");
    }

    #[test]
    fn times_read_like_electrons() {
        let ms = DateTime::parse_from_rfc3339("2026-10-30T14:30:00-02:00").unwrap().timestamp_millis();
        assert_eq!(format_version_time(ms, &now()), "October 30, 2:30 PM");
        let old = DateTime::parse_from_rfc3339("2025-10-30T09:05:00-02:00").unwrap().timestamp_millis();
        assert_eq!(format_version_time(old, &now()), "October 30, 2025, 9:05 AM");
        let today = DateTime::parse_from_rfc3339("2026-11-25T09:05:00-02:00").unwrap().timestamp_millis();
        assert_eq!(format_version_heading(today, &now()), "Today, 9:05 AM");
        let yesterday = DateTime::parse_from_rfc3339("2026-11-24T21:00:00-02:00").unwrap().timestamp_millis();
        assert_eq!(format_version_heading(yesterday, &now()), "Yesterday, 9:00 PM");
        assert_eq!(format_version_heading(ms, &now()), "October 30, 2:30 PM");
    }

    #[test]
    fn authors_are_named_and_coloured_as_electron_does() {
        assert_eq!(author_label("user", None), "You");
        assert_eq!(author_label("agent", Some("claude-code")), "Claude Code");
        assert_eq!(author_label("agent", Some("  ")), "An agent");
        assert_eq!(author_label("external", None), "External edit");
        assert_eq!(author_label("", None), "Unknown");
        assert_eq!(author_tone("user", None), AuthorTone::Blue);
        assert_eq!(author_tone("external", None), AuthorTone::Muted);
        // "Claude Code" hashes the way authorColor's loop does.
        let mut h: u32 = 0;
        for ch in "Claude Code".chars() {
            h = h.wrapping_mul(31).wrapping_add(ch as u32);
        }
        assert_eq!(author_tone("agent", Some("claude-code")) as usize, [2usize, 3, 4, 5, 6, 7][(h % 6) as usize]);
    }

    #[test]
    fn a_version_with_no_recorded_time_uses_its_stamp() {
        let mut x = v("s", "not a date", "user", None);
        x.ms = Some(1234);
        assert_eq!(version_ms(&x), 1234);
        x.ms = None;
        assert_eq!(version_ms(&x), 0);
    }
}
