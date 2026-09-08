// The YAML front matter of a SKILL.md, read without a YAML parser.
//
// Markie may not add a runtime dependency, and the catalog has to read the
// front matter of every SKILL.md in a repository it just downloaded. That
// front matter is written by strangers, so the reader has two jobs: understand
// the shapes agent skills actually use, and never throw on anything else.
//
// The subset is: `key: value`, single and double quoted scalars, the block
// scalars `|`, `|-`, `>` and `>-` (Anthropic's descriptions use them), and one
// level of nested map, which is how `metadata` is written. Anything outside it
// (sequences, flow collections, anchors, tags) leaves the field out entirely
// rather than guessing, so a caller that requires `name` and `description` to
// be strings simply does not see the skill.
//
// electron/frontmatter.js is the sibling of this file and stays separate on
// purpose: that one answers one question about Markie's own documents, this one
// reads someone else's metadata block.
const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

// `key:` — the leading `-` of a sequence item and the `? ` of a complex key
// both fail this on purpose.
const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:(.*)$/;

function indentOf(line) {
  return line.length - line.trimStart().length;
}

// A quoted or plain scalar, or null when the value is not one this reader
// claims to understand.
function scalar(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (value.startsWith('"')) {
    if (value.length < 2 || !/[^\\]"$/.test(value)) return null;
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) return null;
    return value.slice(1, -1).replace(/''/g, "'");
  }
  // Flow collections, anchors, aliases, tags and merge keys are all outside
  // the subset. So is a bare `#`, which starts a comment rather than a value.
  if (/^[[{&*!#]/.test(value)) return null;
  // A trailing comment is only a comment when a space precedes the `#`; a
  // description may well contain one otherwise.
  return value.replace(/\s+#.*$/, "").trim() || null;
}

// `|`, `|-`, `>+`, `|2-`: the style, an optional explicit indentation
// indicator, and an optional chomping indicator, in either order.
const BLOCK_RE = /^([|>])([+-]?)(\d*)([+-]?)[ \t]*$/;

// Read the lines that belong to a block scalar, starting at `start`. Returns
// the value and the index of the first line that is not part of it.
function blockScalar(lines, start, header) {
  const style = header[1];
  const chomp = header[2] || header[4] || "";
  const explicit = header[3] ? Number.parseInt(header[3], 10) : 0;
  let indent = explicit;
  let i = start;
  const body = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      body.push("");
      i++;
      continue;
    }
    if (!indent) indent = indentOf(line);
    if (indentOf(line) < indent) break;
    body.push(line.slice(indent));
    i++;
  }
  while (body.length && body[body.length - 1] === "") body.pop();

  let value;
  if (style === "|") {
    value = body.join("\n");
  } else {
    // Folded: a single break between two non-empty lines becomes a space, a
    // blank line stays a break.
    value = body.reduce((acc, line, index) => {
      if (index === 0) return line;
      const previous = body[index - 1];
      if (line === "" || previous === "") return `${acc}\n${line}`;
      return `${acc} ${line}`;
    }, "");
  }
  if (chomp !== "-" && value !== "") value += "\n";
  return { value, next: i };
}

// One level of nested map: the indented `key: value` lines under a bare `key:`.
// Anything else indented under it is skipped, and a map with nothing readable
// in it is not a map at all.
function nestedMap(lines, start) {
  const out = {};
  let i = start;
  let found = false;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (indentOf(line) === 0) break;
    const match = KEY_RE.exec(line.trim());
    if (match) {
      const value = scalar(match[2]);
      if (value !== null) {
        out[match[1]] = value;
        found = true;
      }
    }
    i++;
  }
  return { map: found ? out : null, next: i };
}

/**
 * Read a SKILL.md's front matter.
 *
 * @param {string} markdown the whole file
 * @returns {{ fields: Record<string, string | Record<string, string>>, body: string }}
 *   the fields it could read, and the document below the front matter
 */
function parseFrontmatter(markdown) {
  const source = String(markdown ?? "");
  const fields = {};
  let match;
  try {
    match = FRONT_MATTER_RE.exec(source);
  } catch {
    match = null;
  }
  if (!match) return { fields, body: source };
  const body = source.slice(match[0].length);
  try {
    const lines = match[1].split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "" || line.trimStart().startsWith("#") || indentOf(line) !== 0) {
        i++;
        continue;
      }
      const entry = KEY_RE.exec(line);
      if (!entry) {
        i++;
        continue;
      }
      const [, key, rest] = entry;
      const header = BLOCK_RE.exec(rest.trim());
      if (header) {
        const block = blockScalar(lines, i + 1, header);
        fields[key] = block.value;
        i = block.next;
        continue;
      }
      if (rest.trim() === "") {
        const nested = nestedMap(lines, i + 1);
        if (nested.map) fields[key] = nested.map;
        i = nested.next;
        continue;
      }
      const value = scalar(rest);
      if (value !== null) fields[key] = value;
      i++;
    }
  } catch {
    // Someone else's metadata block is not allowed to break a catalog fetch.
    // Whatever was read before the trouble is still worth returning.
  }
  return { fields, body };
}

module.exports = { parseFrontmatter, FRONT_MATTER_RE };
