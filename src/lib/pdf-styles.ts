// Standalone CSS for PDF export — completely self-contained, no external deps
// Two themes: dark (matches app preview) and light (clean print-friendly)

const shared = `
  * { margin: 0; padding: 0; box-sizing: border-box; }

  @page {
    size: A4;
    margin: 2cm 2.2cm;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.75;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .markdown-body { max-width: 100%; }

  .markdown-body h1 {
    font-size: 2em;
    font-weight: 700;
    margin: 1.2em 0 0.5em;
    padding-bottom: 0.3em;
    letter-spacing: -0.025em;
    page-break-after: avoid;
  }

  .markdown-body h1:first-child { margin-top: 0; }

  .markdown-body h2 {
    font-size: 1.5em;
    font-weight: 650;
    margin: 1.3em 0 0.45em;
    padding-bottom: 0.25em;
    letter-spacing: -0.02em;
    page-break-after: avoid;
  }

  .markdown-body h3 {
    font-size: 1.25em;
    font-weight: 600;
    margin: 1.2em 0 0.4em;
    page-break-after: avoid;
  }

  .markdown-body h4 {
    font-size: 1.1em;
    font-weight: 600;
    margin: 1.1em 0 0.35em;
    page-break-after: avoid;
  }

  .markdown-body h5, .markdown-body h6 {
    font-size: 1em;
    font-weight: 600;
    margin: 1em 0 0.3em;
    page-break-after: avoid;
  }

  .markdown-body p { margin: 0.7em 0; }

  .markdown-body a { text-decoration: none; }

  .markdown-body strong { font-weight: 650; }
  .markdown-body em { font-style: italic; }

  .markdown-body blockquote {
    margin: 1em 0;
    padding: 0.5em 1em;
    border-left: 3px solid;
    border-radius: 0 6px 6px 0;
  }

  .markdown-body blockquote p { margin: 0.25em 0; }

  .markdown-body ul, .markdown-body ol {
    margin: 0.6em 0;
    padding-left: 1.8em;
  }

  .markdown-body li { margin: 0.25em 0; }
  .markdown-body ul li { list-style-type: disc; }
  .markdown-body ol li { list-style-type: decimal; }

  .markdown-body code {
    font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace;
    font-size: 0.88em;
    padding: 0.15em 0.35em;
    border-radius: 4px;
    border: 1px solid;
  }

  .markdown-body pre {
    margin: 1em 0;
    padding: 1em 1.2em;
    border-radius: 8px;
    border: 1px solid;
    overflow-x: auto;
    page-break-inside: avoid;
  }

  .markdown-body pre code {
    padding: 0;
    background: none !important;
    border: none;
    border-radius: 0;
    font-size: 0.85em;
    line-height: 1.55;
  }

  .markdown-body hr {
    margin: 1.8em 0;
    border: none;
    height: 1px;
  }

  .markdown-body img {
    max-width: 100%;
    border-radius: 8px;
    margin: 1em 0;
    page-break-inside: avoid;
  }

  .markdown-body table {
    width: 100%;
    margin: 1em 0;
    border-collapse: collapse;
    font-size: 0.9em;
    page-break-inside: avoid;
  }

  .markdown-body thead th {
    text-align: left;
    padding: 0.55em 0.8em;
    font-weight: 600;
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .markdown-body tbody td {
    padding: 0.5em 0.8em;
  }

  .markdown-body input[type="checkbox"] {
    appearance: none;
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border: 2px solid;
    border-radius: 3px;
    vertical-align: middle;
    margin-right: 5px;
    position: relative;
    top: -1px;
  }

  .markdown-body input[type="checkbox"]:checked::after {
    content: "✓";
    font-size: 10px;
    font-weight: 700;
    position: absolute;
    top: -1px;
    left: 1px;
  }

  .markdown-body .task-list-item {
    list-style: none;
    margin-left: -1.5em;
  }

  .markdown-body del { text-decoration: line-through; }
  .markdown-body sup { font-size: 0.75em; vertical-align: super; }
  .markdown-body sub { font-size: 0.75em; vertical-align: sub; }
`;

const darkTheme = `
  body { background: #09090b; color: #fafafa; }
  .markdown-body { color: #fafafa; }
  .markdown-body h1 { border-bottom: 1px solid #27272a; }
  .markdown-body h2 { border-bottom: 1px solid #27272a; }
  .markdown-body h5, .markdown-body h6 { color: #a1a1aa; }
  .markdown-body a { color: #60a5fa; }
  .markdown-body strong { color: #fff; }
  .markdown-body blockquote { border-left-color: #c084fc; background: #18181b; color: #a1a1aa; }
  .markdown-body li::marker { color: #a1a1aa; }
  .markdown-body code { background: #18181b; border-color: #27272a; color: #fb923c; }
  .markdown-body pre { background: #18181b; border-color: #27272a; }
  .markdown-body pre code { color: #fafafa; }
  .markdown-body hr { background: #27272a; }
  .markdown-body thead th { background: #18181b; border-bottom: 2px solid #27272a; color: #a1a1aa; }
  .markdown-body tbody td { border-bottom: 1px solid #27272a; }
  .markdown-body del { color: #a1a1aa; }
  .markdown-body input[type="checkbox"] { border-color: #3f3f46; }
  .markdown-body input[type="checkbox"]:checked { background: #60a5fa; border-color: #60a5fa; }
  .markdown-body input[type="checkbox"]:checked::after { color: #000; }

  /* highlight.js dark */
  .hljs { color: #c9d1d9; }
  .hljs-keyword { color: #ff7b72; }
  .hljs-string { color: #a5d6ff; }
  .hljs-title { color: #d2a8ff; }
  .hljs-built_in { color: #ffa657; }
  .hljs-comment { color: #8b949e; }
  .hljs-number { color: #79c0ff; }
  .hljs-attr { color: #79c0ff; }
  .hljs-subst { color: #c9d1d9; }
  .hljs-literal { color: #79c0ff; }
  .hljs-type { color: #ffa657; }
  .hljs-params { color: #c9d1d9; }
  .hljs-variable { color: #ffa657; }
  .hljs-function { color: #d2a8ff; }
`;

const lightTheme = `
  body { background: #fff; color: #1a1a2e; }
  .markdown-body { color: #1a1a2e; }
  .markdown-body h1 { border-bottom: 1px solid #e4e4e7; color: #09090b; }
  .markdown-body h2 { border-bottom: 1px solid #e4e4e7; color: #18181b; }
  .markdown-body h3, .markdown-body h4 { color: #27272a; }
  .markdown-body h5, .markdown-body h6 { color: #71717a; }
  .markdown-body a { color: #2563eb; }
  .markdown-body strong { color: #09090b; }
  .markdown-body blockquote { border-left-color: #8b5cf6; background: #f5f3ff; color: #52525b; }
  .markdown-body li::marker { color: #71717a; }
  .markdown-body code { background: #f4f4f5; border-color: #e4e4e7; color: #c2410c; }
  .markdown-body pre { background: #fafafa; border-color: #e4e4e7; }
  .markdown-body pre code { color: #1a1a2e; }
  .markdown-body hr { background: #e4e4e7; }
  .markdown-body thead th { background: #f4f4f5; border-bottom: 2px solid #e4e4e7; color: #71717a; }
  .markdown-body tbody td { border-bottom: 1px solid #e4e4e7; }
  .markdown-body del { color: #a1a1aa; }
  .markdown-body input[type="checkbox"] { border-color: #d4d4d8; }
  .markdown-body input[type="checkbox"]:checked { background: #2563eb; border-color: #2563eb; }
  .markdown-body input[type="checkbox"]:checked::after { color: #fff; }

  /* highlight.js light */
  .hljs { color: #24292e; }
  .hljs-keyword { color: #d73a49; }
  .hljs-string { color: #032f62; }
  .hljs-title { color: #6f42c1; }
  .hljs-built_in { color: #e36209; }
  .hljs-comment { color: #6a737d; }
  .hljs-number { color: #005cc5; }
  .hljs-attr { color: #005cc5; }
  .hljs-subst { color: #24292e; }
  .hljs-literal { color: #005cc5; }
  .hljs-type { color: #e36209; }
  .hljs-params { color: #24292e; }
  .hljs-variable { color: #e36209; }
  .hljs-function { color: #6f42c1; }
`;

export type PDFTheme = "dark" | "light";

export function getPDFStyles(theme: PDFTheme): string {
  return `<style>${shared}\n${theme === "dark" ? darkTheme : lightTheme}</style>`;
}

export function buildPDFHTML(markdownHTML: string, theme: PDFTheme): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${getPDFStyles(theme)}
</head>
<body>
<article class="markdown-body">${markdownHTML}</article>
</body>
</html>`;
}
