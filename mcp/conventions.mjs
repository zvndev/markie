// What every connected agent should know about Markie, surfaced through the MCP
// initialize handshake (clients hand `instructions` to the model) and applied by
// the write path. Client-agnostic on purpose: Claude Code, Codex, and any other
// MCP client read the same text, so nothing here may assume one of them.
// Self-contained: no imports from outside mcp/ (see the scan.mjs header).
import { GUIDE_URI, guideEssentials } from "./markdown-guide.mjs";

export const INSTRUCTIONS = `Markie is the user's local document workspace: a desktop app over the documents already on this computer. Markdown first, and also plain text, CSV, JSON, YAML, XML, Darkmown (.wd), Word (.docx and legacy .doc), RTF, OpenDocument (.odt) and HTML. These tools touch the user's real files.

When to reach for each tool:
- markie_find_documents: search the device-wide document index by name or path, newest first, with each file's format. Narrow it with formats (any of markdown, darkmown, text, csv, json, yaml, xml, html, docx, odt, rtf, doc). markie_find_md is its markdown-only form. Run one of them before writing anything new so you update the document that already exists instead of leaving a second copy beside it.
- markie_search_documents: find documents by what they say. It reads the text inside markdown, plain text, data files, Word, OpenDocument, RTF and HTML, and ranks the way Markie's own global search does, with an excerpt around each hit.
- markie_read_document: read any of those by absolute path. Text formats come back exactly as written. Word, OpenDocument, RTF and HTML come back as extracted plain text, labelled read-only. Legacy .doc cannot be read this way.
- markie_write_document: write markdown or another text format (.txt, .csv, .json, .yaml, .xml, .wd) inside the user's home folder. JSON must be valid. Write rich documents: tables, task lists, pictures, and a Darkmown .wd when the reader should click, tick, slide or calculate. Word, OpenDocument, RTF, .doc and HTML are never written: open one with markie_open_in_markie for the user to edit, or put your changes in a new markdown document.
- markie_read_md, markie_write_md: the markdown-only forms of read and write, kept for existing setups.
- markie_check_md: read a markdown document back and report what will not display: a picture that is not where it says it is, an embed of a kind Markie cannot draw, markup that renders nowhere, and every tag the editor and an export treat differently. Run it when the document has a picture, a clip or inline HTML.
- markie_open_in_markie: put a document of any of these types in front of the user. Use it after writing, when they asked to see the result.
- markie_cloud_sync: put a Markdown, text or Darkmown (.wd) file in the user's Markie Cloud and get its private link. It opens in the Markie app if it is installed, or in a browser after the user signs in. The running Markie app does the upload and may ask the user first. When the user wants a "hosted", "synced", "cloud" or "private Markie" copy, or a link to read something away from this computer: write the document (under ~/Documents/Markie/ when they did not say where), call markie_cloud_sync, and paste the markdownLink from the result into your reply. It is the privateLink as a ready-made markdown link. markie_cloud_status reports a file's Cloud state and links without uploading.
- markie_cloud_public_link: a link anyone can open without an account. Only pass create: true when the user asked for a public link in so many words; otherwise give them the private link. Markie confirms every public link with the user. markie_cloud_revoke_public_link turns one off.
- markie_list_skills: the user's agent instruction files (CLAUDE.md, AGENTS.md, skills, Cursor rules), grouped by tool.
- markie_guide: how to write for Markie, with an example of each: which format to pick, structure, every element Markie renders, every Darkmown directive that works and what it cannot do, how to hand the user a link, and which document types each tool reads and writes. Read it before writing a document longer than a few paragraphs. Also served as the ${GUIDE_URI} resource.

How to write for Markie, in short:
${guideEssentials()}

How Markie organizes, and what it needs from you:
Markie groups files into projects (a repo or a product) and blocks (one unit of work inside a project). Declare where a markdown document belongs as you write it, either with the optional project and block arguments to markie_write_document or markie_write_md, or by writing the front matter yourself. The exception is a document you will send to the user as a link (markie_cloud_sync or markie_create_document) or export: exports print front matter as text, and a link-first document gains nothing from local filing, so leave project and block out of it. The front matter looks like this:

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
