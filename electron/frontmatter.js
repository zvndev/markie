// Reads exactly one thing from a document: the markie:{project,block}
// declaration in leading YAML front matter. Hand-rolled because packaged
// main-process code has no YAML dependency, and deliberately narrow: this is
// not a YAML parser, it is a reader for the one shape Markie documents (and
// the MCP write path) produce. Anything it cannot read safely reads as
// absent, never as an error.
//
// The boundary must agree with src/lib/front-matter.ts, which decides what a
// front matter block is for the editor. A parity test in frontmatter.test.ts
// compares the two literals so an edit to one trips over the other.
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/;

function unquote(raw) {
  const t = String(raw ?? "").trim();
  const m = /^"(.*)"$|^'(.*)'$/.exec(t);
  const v = m ? (m[1] !== undefined ? m[1] : m[2]) : t;
  return v || null;
}

// markie: { project: X, block: Y }
function fromInline(rest) {
  const inner = rest.replace(/^\{/, "").replace(/\}\s*$/, "");
  const out = { project: null, block: null };
  for (const part of inner.split(",")) {
    const m = /^\s*(project|block)\s*:\s*(.+?)\s*$/.exec(part);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

function extractMarkieMeta(text) {
  const src = String(text || "");
  const fm = FRONT_MATTER_RE.exec(src);
  if (!fm) return { project: null, block: null };
  const lines = fm[1].split(/\r?\n/);
  let inMarkie = false;
  const out = { project: null, block: null };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (!inMarkie) {
      if (indent !== 0) continue; // nested under some other key
      const m = /^markie\s*:\s*(.*)$/.exec(trimmed);
      if (m) {
        if (m[1].trim().startsWith("{")) return fromInline(m[1].trim());
        inMarkie = true;
      }
    } else {
      if (indent === 0) break; // left the markie block
      const m = /^(project|block)\s*:\s*(.*)$/.exec(trimmed);
      if (m) out[m[1]] = unquote(m[2]);
    }
  }
  return out;
}

module.exports = { extractMarkieMeta, FRONT_MATTER_RE };
