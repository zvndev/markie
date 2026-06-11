// RFC 4180-style CSV codec plus CSV ↔ GFM table conversion.
// CSV files stay true CSV on disk; Markie renders them as tables.

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

export function serializeCSV(rows: string[][]): string {
  return (
    rows
      .map((row) =>
        row
          .map((cell) =>
            /[",\n\r]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell
          )
          .join(",")
      )
      .join("\n") + "\n"
  );
}

function cellToMarkdown(cell: string): string {
  return cell.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function markdownToCell(cell: string): string {
  return cell.replace(/\\\|/g, "|");
}

export function csvToMarkdownTable(csv: string): string {
  const rows = parseCSV(csv).filter((r) => !(r.length === 1 && r[0] === ""));
  if (rows.length === 0) return "";
  const colCount = Math.max(...rows.map((r) => r.length));
  const norm = (r: string[]) => {
    const cells = [...r];
    while (cells.length < colCount) cells.push("");
    return "| " + cells.map(cellToMarkdown).join(" | ") + " |";
  };
  const header = norm(rows[0]);
  const delim = "| " + Array(colCount).fill("---").join(" | ") + " |";
  const body = rows.slice(1).map(norm);
  return [header, delim, ...body].join("\n") + "\n";
}

export function markdownTableToCSV(markdown: string): string {
  const lines = markdown.split("\n");
  const rows: string[][] = [];
  let inTable = false;
  for (const line of lines) {
    const isRow = line.trim().startsWith("|");
    if (!inTable && isRow) inTable = true;
    if (inTable) {
      if (!isRow) break; // first table only
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
      cells.push(current.trim());
      // skip the delimiter row
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
      rows.push(cells.map(markdownToCell));
    }
  }
  return serializeCSV(rows);
}
