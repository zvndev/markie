// Front matter never enters the rich editor. TipTap has no node for it, so a
// parse turns it into a mangled heading; instead the shim holds it aside
// verbatim and re-attaches it on serialize. Byte-for-byte preservation is a
// hard requirement: agents declare `markie: {project, block}` here and the
// taxonomy reads it back.

export interface SplitDoc {
  frontMatter: string; // "" when the document has none; includes both fences
  body: string;
}

const FRONT_MATTER_RE = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/;

export function splitFrontMatter(md: string): SplitDoc {
  const m = FRONT_MATTER_RE.exec(md);
  if (!m) return { frontMatter: "", body: md };
  return { frontMatter: m[0], body: md.slice(m[0].length) };
}

export function joinFrontMatter(frontMatter: string, body: string): string {
  return frontMatter ? frontMatter + body : body;
}
