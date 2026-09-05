// What every connected agent should know about Markie, surfaced through the MCP
// initialize handshake (clients hand `instructions` to the model) and applied by
// the write path. Client-agnostic on purpose: Claude Code, Codex, and any other
// MCP client read the same text, so nothing here may assume one of them.
// Self-contained: no imports from outside mcp/ (see the scan.mjs header).
import { GUIDE_URI, guideEssentials } from "./markdown-guide.mjs";

export const INSTRUCTIONS = `Markie is the user's local markdown workspace: a desktop app over the .md files already on this computer. These tools touch the user's real files.

When to reach for each tool:
- markie_find_md: search the device-wide markdown index (name or path, newest first). Run it before writing anything new so you update the document that already exists instead of leaving a second copy beside it.
- markie_read_md, markie_write_md: read or write one file by absolute path. Writes are limited to markdown inside the user's home folder.
- markie_check_md: read a document back and report what will not display: a picture that is not where it says it is, an embed of a kind Markie cannot draw, markup that renders nowhere, and every tag the editor and an export treat differently. Run it after writing anything with a picture, a clip or inline HTML in it.
- markie_open_in_markie: render a file in front of the user. Use it after writing, when they asked to see the result.
- markie_list_skills: the user's agent instruction files (CLAUDE.md, AGENTS.md, skills, Cursor rules), grouped by tool.
- markie_guide: the whole of what Markie renders, with an example of each. Also served as the ${GUIDE_URI} resource.

What Markie renders, in short:
${guideEssentials()}

How Markie organizes, and what it needs from you:
Markie groups files into projects (a repo or a product) and blocks (one unit of work inside a project). Declare where a document belongs as you write it, either with the optional project and block arguments to markie_write_md or by writing the front matter yourself:

---
markie:
  project: bevrly
  block: checkout-redesign
---

- One block per unit of work: a feature, a bug hunt, a report series. Every document from that work reuses the same block name.
- Name a block after the work, never after a date. "checkout-redesign" says what the work is; "2026-08-26" says only when it was filed, and Markie strips leading date stamps out of the names it derives for exactly that reason.
- Reuse the project names the user already has. A document about a repository belongs to a project named after that repository's folder.
- Project, then block, then file is the whole tree. Do not invent deeper levels.

Files never move. Markie organizes by metadata, over files wherever they already live, so do not relocate, rename, or restructure anything on disk to tidy it up. Declare the project and block instead.`;

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/;

// A value needs YAML quoting only when a plain scalar would parse as something
// other than the string we meant. Hyphens INSIDE a word are ordinary characters
// and must stay unquoted: block names are usually hyphenated ("auth-flow"), and
// quoting every one of them would make the front matter we tell agents to write
// look nothing like the front matter we show them.
function needsQuotes(s) {
  if (s === "" || s !== s.trim()) return true;
  if (/^[-?](\s|$)/.test(s)) return true;      // sequence / complex-key indicator
  if (/^[?:,[\]{}#&*!|>'"%@`]/.test(s)) return true; // other leading indicators
  if (/:\s/.test(s) || /\s#/.test(s)) return true;   // mapping / comment inside
  return /[\n\r\t]/.test(s);
}

function yamlValue(v) {
  const s = String(v);
  // JSON.stringify emits a YAML double-quoted scalar (same escape alphabet).
  return needsQuotes(s) ? JSON.stringify(s) : s;
}

function markieLines({ project, block }) {
  const lines = ["markie:"];
  if (project) lines.push(`  project: ${yamlValue(project)}`);
  if (block) lines.push(`  block: ${yamlValue(block)}`);
  return lines.join("\n");
}

// Remove an existing top-level `markie:` mapping (the key line plus its indented
// children) from a front matter body, so re-declaring replaces rather than
// duplicates. Every other key survives byte-for-byte.
function stripMarkieBlock(body) {
  const lines = body.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    if (skipping) {
      if (line.trim() && indent === 0) skipping = false;
      else continue;
    }
    if (indent === 0 && /^markie\s*:/.test(line.trim())) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n+$/, "");
}

// Inject or merge a `markie: { project, block }` declaration into a document's
// leading front matter. No declaration means no change at all, so every write
// that predates this parameter still produces the exact bytes it always did.
export function applyMarkieFrontMatter(content, { project, block } = {}) {
  const src = String(content ?? "");
  if (!project && !block) return src;
  const decl = markieLines({ project, block });
  const m = FRONT_MATTER_RE.exec(src);
  if (!m) return `---\n${decl}\n---\n${src}`;
  const kept = stripMarkieBlock(m[1]);
  const body = src.slice(m[0].length);
  const fmBody = kept ? `${kept}\n${decl}` : decl;
  return `---\n${fmBody}\n---\n${body}`;
}
