# Quarterly report

A one-page example of the elements Markie draws. Open it in Rich (Command-1), then in Source (Command-2).

## Results

| Region | Revenue | Change |
| :--- | ---: | ---: |
| Europe | 120 | **+8%** |
| Americas | 95 | -2% |

## To do

- [x] Draft the report
- [ ] Get review
- [ ] Send to the board

> **Note:** Figures are provisional until the audit closes.

> **Warning:** The Americas total excludes November.

## Code

```ts
const growth = (now: number, before: number) => (now - before) / before;
```

## Centred line and highlight

<p style="text-align: center;">Signed off by the team</p>

A <mark>flagged</mark> phrase and some <u>underlined</u> text.

## Math and a footnote

Growth is $g = (n - b) / b$.[^1]

[^1]: Math and footnotes show as typed text in the editor. They render in an export, a PDF, a print and a shared web page.
