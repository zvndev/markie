//! What a live rich room can hold, so the desktop file keeps following the
//! room (live-room-carry.ts). A report written the ordinary way must never
//! be refused: Markie RS once refused every tight list whose item opened
//! with bold, italic, a link or struck text, and told the user their file
//! had HTML, comments or footnotes it did not have.

use markie_rich::document::{room_refusals, RefusalKind, RoomRefusal};
use markie_rich::model::{Inline, Node};
use markie_rich::Document;

/// A trimmed, made-up product update in the shape of a real one: emoji
/// headings, an italic lead that starts with `~`, bold-led bullets loose and
/// tight, em dashes, `->`, parentheses, rules, a numbered list with bold
/// leads, nested lists, tasks, a table, code and a quote.
const REPORT: &str = "# 🍷 Northwind Update — May 2026

*~120 changes just shipped. Here's what's new, by what it does for people.*

The headline: **offline sync is live end-to-end** — edit anywhere, and it lands when you reconnect.

---

## 🚀 New Features

- **Offline sync (flagship).** Edits queue up and replay in order — notes, tags, attachments.

- **Shared folders (team & guests).** Invite someone to a folder and they see every document in it.

---

## 🧹 Internal / Chores

- **Admin rebuild** — refreshed the org, flags and costs pages with a shared layout.
- Database migrations (orders metadata, demo flag), `.gitignore` housekeeping, and data backfills (sales, names).
- *Beta:* a calendar view -> documents with dates.
- [Docs site](https://example.com/docs) refreshed.
- ~~Old importer~~ replaced.
- __Owner__ is Dee, ***very*** important.
- **[Release notes](https://example.com/notes)** at the start.

## 📌 Highlights

1. **Offline sync** — by far the biggest investment (~90 commits); live on web **and** mobile.
2. **Search** — results as you type, about 3x quicker.
3. *Small fixes* across the board.

- **Platform**
  - **Storage** — moved to the new bucket.
  - Search reindex (about 2 hours).
    1. **Step one** first.
    2. Step two.

- [x] **Ship sync** to everyone
- [ ] *Write* the migration guide

| Area | Change | Owner |
|:-----|:------:|------:|
| **Sync** | Offline queue ✅ | Ana |
| Search | `prefix` match | Ben |

```bash
npm run release -- --dry-run
```

> **Note:** the old API keeps working until December.
> - **One** quoted bullet

*Questions? Reply to this thread.*
";

#[test]
fn an_ordinary_report_is_held_by_the_room_byte_for_byte() {
    assert_eq!(room_refusals(REPORT), vec![], "nothing in an ordinary report is refused");
    let doc = Document::parse(REPORT);
    assert!(doc.blocks.iter().all(|b| !b.is_opaque()));
    assert_eq!(doc.to_markdown(), REPORT);
}

#[test]
fn a_tight_item_that_opens_with_a_mark_is_a_paragraph_like_any_other() {
    for (md, first) in [
        ("- **Lead.** rest\n", Some("Lead.")),
        ("- *Lead* rest\n", Some("Lead")),
        ("- ~~Lead~~ rest\n", Some("Lead")),
        ("- [Lead](https://example.com) rest\n", Some("Lead")),
        ("1. **Lead** rest\n2. next\n", Some("Lead")),
        ("- [x] **Lead** rest\n", Some("Lead")),
        ("- plain first\n", None),
    ] {
        let doc = Document::parse(md);
        assert!(room_refusals(md).is_empty(), "{md:?} is refused");
        let nodes = doc.nodes();
        let items = match &nodes[0] {
            Node::BulletList { items, .. } | Node::OrderedList { items, .. } => items.clone(),
            Node::TaskList { items } => items.iter().map(|i| i.content.clone()).collect(),
            other => panic!("{md:?}: {other:?}"),
        };
        let Node::Paragraph { content, .. } = &items[0][0] else { panic!("{md:?}: {:?}", items[0]) };
        let Inline::Text { text, marks } = &content[0] else { panic!("{md:?}: {content:?}") };
        if let Some(lead) = first {
            assert_eq!(text, lead, "{md:?}");
            assert!(marks.bold || marks.italic || marks.strike || marks.link.is_some(), "{md:?}: {marks:?}");
            // The rest of the item follows in the same paragraph.
            assert!(content.len() >= 2, "{md:?}: {content:?}");
        }
        assert_eq!(doc.to_markdown(), md);
    }
}

#[test]
fn refusals_name_what_and_where() {
    let md = "---\ntitle: x\n---\n# Title\n\nText with a note.[^1]\n\n<!-- a comment -->\n\n<div>raw</div>\n\n[ref]: https://example.com\n\n# Logo ![l](l.png)\n\n| a |\n|---|\n| ![p](p.png) |\n\n[^1]: The note.\n";
    let got = room_refusals(md);
    let want = [
        (8, RefusalKind::HtmlComment),
        (10, RefusalKind::Html),
        (12, RefusalKind::LinkDefinition),
        (14, RefusalKind::PictureInHeading),
        (18, RefusalKind::PictureInTable),
        (20, RefusalKind::Footnote),
    ];
    assert_eq!(got, want.iter().map(|&(line, what)| RoomRefusal { line, what }).collect::<Vec<_>>());
}

#[test]
fn html_inside_a_list_is_found_on_its_own_line() {
    let md = "- one\n- two\n\n  <div>x</div>\n- three\n";
    assert_eq!(room_refusals(md), vec![RoomRefusal { line: 4, what: RefusalKind::Html }]);
}
