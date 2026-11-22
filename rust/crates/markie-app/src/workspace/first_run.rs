//! One-time, local-first onboarding from the original desktop workspace.

pub(super) const SEEN_KEY: &str = "welcome_seen_v1";

pub(super) fn should_show_welcome(opened_file: bool, seen: bool) -> bool {
    !opened_file && !seen
}

pub(super) const WELCOME_DOC: &str = r#"# Welcome to Markie

This is a real markdown file, and what you're looking at is Markie rendering it.
Nothing here is a screenshot.

## Three ways to see a document

| Press | You get |
| --- | --- |
| `⌘1` | **Rich**: formatted, the way it will look to a reader |
| `⌘2` | **Source**: the raw markdown, syntax highlighted |
| `⌘3` | **Split**: both, side by side, scrolling together |

Try `⌘2` right now and you'll see the markdown behind this page.

## Try it here

These are real checkboxes. Click one.

- [x] Open Markie
- [ ] Click this box
- [ ] Press `⌘K` and type something

Code keeps its highlighting, and tables stay aligned:

```typescript
const welcome = (reader: string) => `Nice to meet you, ${reader}.`;
```

Math renders too: $E = mc^2$

## `⌘K` is the whole app

One palette, everything in it. If you only remember one shortcut, remember that
one. `⌘/` lists the rest.

A few worth knowing now:

- `⌘L`: your **Library**, every document Markie knows about
- `⌘F`: find, with replace on `⌥⌘F`
- `⌘N`: a new file
- `⇧⌘E`: export a PDF that looks like this

## Your files stay yours

Markie reads and writes ordinary `.md` files in ordinary folders. There is no
import step and no lock-in: delete Markie tomorrow and every document you wrote
is still sitting there, still readable in any editor.

You do not need an account. Markie works completely without one.

> Sync and sharing do need an account, because another device or another person
> has to be able to reach the document. Markie will ask you then, and not before.

---

That's the tour. Open something of your own with `⌘O`, or press `⌘N` and start
writing.
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_handed_over_file_does_not_consume_the_welcome_document() {
        use markie_core::registry::Registry;
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("rs-registry.db");
        {
            let registry = Registry::open(&path).unwrap();
            let seen = registry.setting(SEEN_KEY).unwrap().is_some();
            assert!(!should_show_welcome(true, seen));
            assert!(should_show_welcome(false, seen));
            registry.set_setting(SEEN_KEY, "1").unwrap();
        }
        let reopened = Registry::open(&path).unwrap();
        assert!(!should_show_welcome(false, reopened.setting(SEEN_KEY).unwrap().is_some()));
    }
}
