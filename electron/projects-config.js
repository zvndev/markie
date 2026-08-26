// The user's organization document. Created once with a template that teaches
// the format; after that it is the user's file: Markie only ever rewrites the
// region below the overview marker, and only when the user asks it to from the
// Projects view. Rewriting it in the background would fight both the editor
// and the disk watcher.
const nodeFs = require("fs");
const nodePath = require("path");

const OVERVIEW_MARKER = "<!-- markie:overview -->";

const DEFAULT_PROJECTS_MD = `---
markie_rules:
  version: 1
  clustering:
    gap_hours: 24
    min_files: 1
    max_blocks_per_project: 30
  dumping_grounds:
    - "~/Downloads/**"
    - "~/.*/**"
  containers: []
  not_containers: []
  rules: []
  ignore: []
---
# Projects

This document controls how Markie organizes your markdown into projects and
blocks. Nothing here moves a file: your files stay exactly where they are, and
this is the view over them.

Edit the rules in the front matter above like any other document; Markie
re-reads them when you save. A rule looks like this:

\`\`\`yaml
rules:
  - match: "~/Desktop/Coding/**"
    project: "{repo}"
  - match: "~/Documents/Notes/**"
    project: Notes
    block: "{folder}"
\`\`\`

\`{repo}\` becomes the containing git repository's name, and \`{folder}\`
becomes the file's parent folder. Rules are tried in order and the first match
wins. Anything matching an \`ignore\` glob stays out of the Projects views
entirely (Browse still shows it).

\`dumping_grounds\` is the same idea for the places nobody writes their work:
an inbox like \`~/Downloads\`, and the hidden folders under your home that
belong to applications and agents. Delete a line to bring one back.

\`containers\` are folders that HOLD projects rather than being one, so the
folder inside them becomes the project instead. Markie finds most of them by
itself (any folder with several git repositories under it), and these two lists
are how you add one it missed or take back one it should not have taken.

Markie decides where a file belongs in this order: a file you moved by hand,
then a \`markie: {project, block}\` declaration in the file's own front matter,
then the rules above, then the folder and editing history it can see.

${OVERVIEW_MARKER}
(The Projects view can write a listing of your projects here.)
`;

function ensureProjectsConfig({ dir, fs = nodeFs, path = nodePath } = {}) {
  const target = path.join(dir, "Projects.md");
  try {
    const existing = fs.readFileSync(target, "utf-8");
    return { path: target, content: existing, created: false };
  } catch {
    // Absent or unreadable: fall through and write the template.
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, DEFAULT_PROJECTS_MD, "utf-8");
  return { path: target, content: DEFAULT_PROJECTS_MD, created: true };
}

// Replace everything below the marker, keeping every byte above it. The user
// owns the rules and the prose; Markie owns only the listing.
function writeOverviewSection(content, listing) {
  const src = String(content ?? "");
  const idx = src.indexOf(OVERVIEW_MARKER);
  const body = `${OVERVIEW_MARKER}\n${String(listing ?? "")}`;
  if (idx === -1) {
    const sep = src.endsWith("\n") ? "\n" : "\n\n";
    return src + sep + body;
  }
  return src.slice(0, idx) + body;
}

module.exports = {
  ensureProjectsConfig,
  writeOverviewSection,
  DEFAULT_PROJECTS_MD,
  OVERVIEW_MARKER,
};
