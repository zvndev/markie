# Current Task — F-010

## Description
Markdown and rich editor content use theme-aware colors so light mode does not hide strong text, inline code, code blocks, tables, selections, or task controls.

## Acceptance Criteria
- Open a document containing headings, bold text, links, inline code, code blocks, tables, task lists, blockquotes, math, and comments in light and dark mode.
- Fix hardcoded content colors and highlight styles that make content invisible or visually broken in light mode.
- Add or update theme/content tests where pure style-token behavior is testable.
- Run the focused content-style verification plus `./init.sh`.

## Scope
This wakeup may touch markdown/rich editor content styles, the default sample needed to exercise content styles, and focused content visual audit/test coverage only. Broader shell, side-panel, overlay, and layout polish stay in later ledger items.
