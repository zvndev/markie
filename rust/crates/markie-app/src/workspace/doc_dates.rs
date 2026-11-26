//! When a document was opened, created or changed, as the document pages
//! (Recent and Cloud, grid and list) say it. One formatter, by calendar
//! day, so a card under the "Today" heading always reads today and one under
//! "This week" never does:
//!
//! - "Today 2:14 PM", "Yesterday 9:03 PM";
//! - a weekday with its time within the last week: "Mon 9:12 AM";
//! - "Nov 12" earlier this year, "Nov 12, 2025" before that.
//!
//! The section headings count days with [`days_ago`], the same function.

use chrono::{DateTime, Datelike as _, Local, TimeZone};

/// Whole calendar days from `then` to `now`, on `now`'s calendar. Never
/// negative: a time ahead of the clock (a clock that moved back, a file
/// stamped in the future) is today.
pub fn days_ago<Tz: TimeZone>(then: &DateTime<Tz>, now: &DateTime<Tz>) -> i64 {
    let then = then.with_timezone(&now.timezone());
    (now.date_naive() - then.date_naive()).num_days().max(0)
}

/// The label for `then`, seen at `now`.
pub fn stamp<Tz: TimeZone>(then: &DateTime<Tz>, now: &DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let then = then.with_timezone(&now.timezone());
    let time = then.format("%-I:%M %p");
    match days_ago(&then, now) {
        0 => format!("Today {time}"),
        1 => format!("Yesterday {time}"),
        d if d < 7 => format!("{} {time}", then.format("%a")),
        _ if then.year() == now.year() => then.format("%b %-d").to_string(),
        _ => then.format("%b %-d, %Y").to_string(),
    }
}

/// A time in ms since 1970 on this Mac's clock. None for no time on record
/// (zero, negative or not a number).
pub fn local(ms: f64) -> Option<DateTime<Local>> {
    if !(ms.is_finite() && ms > 0.) {
        return None;
    }
    Local.timestamp_millis_opt(ms as i64).single()
}

/// [`stamp`] for a time in ms; None when there is no time on record, so
/// nothing is shown rather than a guess.
pub fn stamp_ms(ms: f64, now: DateTime<Local>) -> Option<String> {
    local(ms).map(|then| stamp(&then, &now))
}

/// One labelled date under a card's name: "Opened" and "Today 2:14 PM".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DateRow {
    pub label: &'static str,
    pub value: String,
}

impl DateRow {
    /// The row for a time in ms, or None when there is no time on record.
    pub fn at(label: &'static str, ms: f64, now: DateTime<Local>) -> Option<Self> {
        stamp_ms(ms, now).map(|value| Self { label, value })
    }
}

#[cfg(test)]
mod tests {
    use super::{days_ago, stamp};
    use chrono::{DateTime, FixedOffset, TimeZone as _};

    /// A fixed zone, so the tests never depend on the Mac running them.
    fn zone() -> FixedOffset {
        FixedOffset::west_opt(5 * 3600).unwrap()
    }

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<FixedOffset> {
        zone().with_ymd_and_hms(y, mo, d, h, mi, 0).single().unwrap()
    }

    #[test]
    fn today_and_yesterday_carry_the_time() {
        let now = at(2026, 11, 26, 15, 0);
        assert_eq!(stamp(&at(2026, 11, 26, 14, 14), &now), "Today 2:14 PM");
        assert_eq!(stamp(&at(2026, 11, 26, 9, 5), &now), "Today 9:05 AM");
        assert_eq!(stamp(&at(2026, 11, 25, 21, 3), &now), "Yesterday 9:03 PM");
        assert_eq!(stamp(&at(2026, 11, 26, 0, 0), &now), "Today 12:00 AM");
        assert_eq!(stamp(&at(2026, 11, 25, 12, 30), &now), "Yesterday 12:30 PM");
    }

    #[test]
    fn midnight_is_the_line_between_today_and_yesterday() {
        // One minute apart, either side of midnight.
        let just_after = at(2026, 11, 26, 0, 1);
        assert_eq!(stamp(&at(2026, 11, 25, 23, 59), &just_after), "Yesterday 11:59 PM");
        assert_eq!(stamp(&at(2026, 11, 26, 0, 0), &just_after), "Today 12:00 AM");
        // Late last night is yesterday, though under an hour ago.
        assert_eq!(days_ago(&at(2026, 11, 25, 23, 30), &just_after), 1);
        // Early this morning is today, though over twenty hours ago.
        let late = at(2026, 11, 26, 23, 50);
        assert_eq!(stamp(&at(2026, 11, 26, 0, 10), &late), "Today 12:10 AM");
    }

    #[test]
    fn the_last_week_is_weekdays_and_then_dates() {
        let now = at(2026, 11, 26, 15, 0); // a Thursday
        assert_eq!(stamp(&at(2026, 11, 24, 9, 12), &now), "Tue 9:12 AM", "two days back");
        assert_eq!(stamp(&at(2026, 11, 20, 18, 45), &now), "Fri 6:45 PM", "six days back");
        assert_eq!(stamp(&at(2026, 11, 19, 18, 45), &now), "Nov 19", "seven days back is a date, not another Thursday");
        assert_eq!(stamp(&at(2026, 3, 4, 9, 0), &now), "Mar 4");
    }

    #[test]
    fn another_year_carries_the_year_and_new_year_is_a_day_like_any_other() {
        let new_year = at(2026, 1, 1, 9, 0);
        assert_eq!(stamp(&at(2025, 12, 31, 22, 15), &new_year), "Yesterday 10:15 PM");
        assert_eq!(stamp(&at(2025, 12, 29, 8, 0), &new_year), "Mon 8:00 AM", "the week runs across the year");
        assert_eq!(stamp(&at(2025, 12, 20, 8, 0), &new_year), "Dec 20, 2025");
        assert_eq!(stamp(&at(2025, 11, 12, 8, 0), &at(2026, 11, 26, 15, 0)), "Nov 12, 2025");
    }

    #[test]
    fn a_time_from_another_zone_is_read_on_this_calendar() {
        // 03:30 UTC on the 26th is 22:30 on the 25th five hours west.
        let utc = FixedOffset::east_opt(0).unwrap().with_ymd_and_hms(2026, 11, 26, 3, 30, 0).single().unwrap();
        let now = at(2026, 11, 26, 15, 0);
        assert_eq!(stamp(&utc.with_timezone(&zone()), &now), "Yesterday 10:30 PM");
        assert_eq!(days_ago(&utc.with_timezone(&zone()), &now), 1);
    }

    #[test]
    fn a_time_ahead_of_the_clock_is_today() {
        let now = at(2026, 11, 26, 15, 0);
        assert_eq!(days_ago(&at(2026, 11, 27, 9, 0), &now), 0);
        assert!(stamp(&at(2026, 11, 27, 9, 0), &now).starts_with("Today"));
    }

    #[test]
    fn no_time_on_record_shows_nothing() {
        let now = chrono::Local::now();
        assert_eq!(super::stamp_ms(0., now), None);
        assert_eq!(super::stamp_ms(f64::NAN, now), None);
        assert_eq!(super::DateRow::at("Created", -5., now), None);
        assert_eq!(super::DateRow::at("Created", now.timestamp_millis() as f64, now).unwrap().label, "Created");
    }
}
