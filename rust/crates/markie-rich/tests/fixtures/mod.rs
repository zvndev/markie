//! The fixtures of `src/lib/rich-roundtrip.test.tsx`, shared by the Rust
//! tests. Names match the TypeScript suite so results can be compared.

/// Must survive a raw parse then serialize (after table re-alignment).
pub const SAFE: &[(&str, &str)] = &[
    ("heading", "# Title\n\nBody text.\n"),
    ("nested list", "- one\n- two\n  - two.a\n"),
    ("fenced code", "```ts\nconst x = 1;\n```\n"),
    ("link and image", "[site](https://example.com)\n\n![alt](img.png)\n"),
    ("blockquote", "> quoted line\n"),
    ("simple table", "| a | b |\n| --- | --- |\n| 1 | 2 |\n"),
    ("hr", "above\n\n---\n\nbelow\n"),
    ("display math", "$$\n\\frac{a}{b} \\, dx\n$$\n"),
    ("inline math", "Euler: $e^{i\\pi}$ stays.\n"),
    ("table alignment", "| a | b |\n| :--- | ---: |\n| 1 | 2 |\n"),
    ("multi-line display math", "$$\na = b\n  + c\n$$\n"),
];

/// TipTap's raw serializer changes these.
pub const LOSSY: &[(&str, &str)] = &[
    ("footnote", "Text with a note.[^1]\n\n[^1]: the note\n"),
    ("raw html block", "<div class=\"warn\">\n<b>html</b>\n</div>\n"),
    ("html comment", "before\n\n<!-- keep me -->\n\nafter\n"),
    ("wrapped paragraph", "This paragraph is wrapped\nacross two lines.\n"),
    ("reference link", "See [the docs][ref].\n\n[ref]: https://example.com\n"),
    ("task list", "- [x] done\n- [ ] todo\n"),
];

/// Layer 1 (hold-aside) zero-edit cases.
pub const PRESERVED: &[(&str, &str)] = &[
    ("front matter", "---\nmarkie:\n  project: Markie\n  block: organized-workspace\n---\n# Doc\n\nBody.\n"),
    ("html comment", "before\n\n<!-- keep me -->\n\nafter\n"),
    ("raw html block", "intro\n\n<div class=\"warn\">\n<b>html</b>\n</div>\n\noutro\n"),
    ("footnote definition", "Note here.\n\n[^1]: the note\n"),
];

/// Layer 2 (block preservation) zero-edit cases.
pub const CORPUS_SHAPED: &[(&str, &str)] = &[
    ("hand-wrapped prose", "# Notes\n\nThis paragraph was wrapped\nby hand at eighty columns\nlike most real files.\n\nAnother wrapped\nparagraph follows.\n"),
    ("aligned table", "| left | right |\n| :--- | ---: |\n| 1 | 2 |\n"),
    ("loose list", "- one\n\n- two\n\n- three\n"),
    ("tight task list", "- [x] done\n- [ ] todo\n- [ ] later\n"),
    ("inline math", "Euler: $e^{i\\pi} + 1 = 0$ stays put.\n"),
    ("display math", "$$\n\\frac{a}{b} \\, dx\n$$\n"),
    ("footnote pair", "Text with a note.[^1]\n\n[^1]: the note\n"),
    ("ordered list with nested sub-lists", "## Priorities\n\n1. Web-first product truth\n   - Inspect the app first.\n   - Keep desktop work tied to runtime.\n\n2. Portfolio task import\n   - Use the guarded artifacts.\n   - Avoid direct writes.\n\n## After\n"),
    ("list item with an indented continuation paragraph", "1. Open the panel.\n\n2. Select the package from the list.\n\n    The manager picks a version for you.\n\n3. Press Install.\n"),
    ("mixed document", "---\ntitle: Mixed\nmarkie:\n  project: Markie\n---\n# Heading\n\n<!-- a comment that must survive -->\n\nProse wrapped\nby hand across lines.\n\n| a | b |\n| :--- | ---: |\n| 1 | 2 |\n\n<div class=\"note\">\n<b>raw</b>\n</div>\n\nClosing line.\n"),
];

/// Layer 3 gate: TipTap reconstructs these.
pub const CLEAN: &[(&str, &str)] = &[
    ("wrapped prose", "Wrapped\nby hand.\n\nMore wrapped\ntext here.\n"),
    ("front matter + body", "---\nkey: v\n---\n# T\n\nBody.\n"),
    ("comment + footnote def", "x[^1]\n\n<!-- c -->\n\n[^1]: n\n"),
    ("aligned table untouched", "| a | b |\n| :--- | ---: |\n| 1 | 2 |\n"),
    ("loose list", "- one\n\n- two\n"),
];

/// TipTap gates these (opens read-only).
pub const GATED: &[(&str, &str)] = &[(
    "reference link with distance",
    "See [the docs][ref].\n\nUnrelated paragraph.\n\n[ref]: https://example.com\n",
)];
