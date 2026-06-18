// Aligns GFM table pipes so raw markdown stays readable in Edit mode.

const DELIM_CELL = /^:?-+:?$/;

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const ch of trimmed) {
    if (escaped) {
      current += "\\" + ch;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (escaped) current += "\\";
  cells.push(current.trim());
  return cells;
}

function isDelimiterRow(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => DELIM_CELL.test(c));
}

function looksLikeTableRow(line: string): boolean {
  return line.trim().startsWith("|");
}

function formatBlock(lines: string[]): string[] {
  const rows = lines.map(splitRow);
  const delimCells = rows[1];
  const colCount = Math.max(...rows.map((r) => r.length));

  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let w = 3; // GFM minimum delimiter width
    for (let r = 0; r < rows.length; r++) {
      if (r === 1) continue;
      w = Math.max(w, (rows[r][c] ?? "").length);
    }
    // alignment colons need room
    const d = delimCells[c] ?? "---";
    if (d.startsWith(":") && d.endsWith(":")) w = Math.max(w, 3);
    widths.push(w);
  }

  return rows.map((cells, r) => {
    const padded = [];
    for (let c = 0; c < colCount; c++) {
      const w = widths[c];
      if (r === 1) {
        const d = delimCells[c] ?? "---";
        const left = d.startsWith(":");
        const right = d.endsWith(":");
        if (left && right) padded.push(":" + "-".repeat(Math.max(1, w - 2)) + ":");
        else if (left) padded.push(":" + "-".repeat(Math.max(2, w - 1)));
        else if (right) padded.push("-".repeat(Math.max(2, w - 1)) + ":");
        else padded.push("-".repeat(w));
      } else {
        padded.push((cells[c] ?? "").padEnd(w));
      }
    }
    return "| " + padded.join(" | ") + " |";
  });
}

export function formatMarkdownTables(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inFence = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (
      !inFence &&
      looksLikeTableRow(line) &&
      i + 1 < lines.length &&
      looksLikeTableRow(lines[i + 1]) &&
      isDelimiterRow(lines[i + 1])
    ) {
      const block = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && looksLikeTableRow(lines[j]) && !isDelimiterRow(lines[j])) {
        block.push(lines[j]);
        j++;
      }
      out.push(...formatBlock(block));
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}
