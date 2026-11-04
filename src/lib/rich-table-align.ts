// A table's column alignment survives an edit.
//
// GFM writes a column's alignment in the delimiter row: `:---` left, `:---:`
// centre, `---:` right. markdown-it reads it onto every cell of the column as
// `style="text-align: …"`, and TipTap's table cells already keep that as their
// `align` attribute (it is in the schema of every released build, desktop
// 0.9.4 included, so rooms have carried it all along). What lost it was the
// way out: tiptap-markdown's table serializer writes `---` for every column
// whatever the cells say, so the first edit inside an aligned table wrote it
// back left-aligned. Block preservation hid that for tables nobody touched.
//
// This is the same serializer with the delimiter row taken from the header
// cells. A table without alignment is written exactly as before.
// formatMarkdownTables pads the row afterwards and keeps the colons.
import { getHTMLFromFragment } from "@tiptap/core";
import { Table } from "@tiptap/extension-table";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";

/** The delimiter cell GFM uses for a column aligned `align`. */
export function delimiterFor(align: unknown): string {
  if (align === "left") return ":---";
  if (align === "center") return ":---:";
  if (align === "right") return "---:";
  return "---";
}

interface TableSerializerState {
  write(text: string): void;
  ensureNewLine(): void;
  closeBlock(node: PMNode): void;
  renderInline(node: PMNode): void;
  inTable?: boolean;
}

const hasAtom = (block: PMNode) => {
  let found = false;
  block.forEach((child) => {
    if (!child.isText) found = true;
  });
  return found;
};

const hasSpan = (cell: PMNode) => cell.attrs.colspan > 1 || cell.attrs.rowspan > 1;

// The rule tiptap-markdown applies: a header row of single-paragraph header
// cells, and body rows of single-paragraph ordinary cells, none spanning.
// Anything else has no markdown form and is written as HTML.
function isMarkdownTable(node: PMNode): boolean {
  let ok = true;
  node.forEach((row, _offset, index) => {
    row.forEach((cell) => {
      const header = cell.type.name === "tableHeader";
      if ((index === 0) !== header || hasSpan(cell) || cell.childCount > 1) ok = false;
    });
  });
  return ok;
}

/** TipTap's table, with alignment kept in the delimiter row. */
export const AlignedTable = Table.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: TableSerializerState, node: PMNode, parent: PMNode) {
          if (!isMarkdownTable(node)) {
            writeTableHTML(state, node, parent);
            return;
          }
          state.inTable = true;
          node.forEach((row, _offset, i) => {
            state.write("| ");
            row.forEach((cell, _o, j) => {
              if (j) state.write(" | ");
              const content = cell.firstChild;
              // An atom (a formula, a picture) has no text of its own, and a
              // cell holding only one is not empty.
              if (content && (content.textContent.trim() || hasAtom(content))) state.renderInline(content);
            });
            state.write(" |");
            state.ensureNewLine();
            if (!i) {
              const cells: string[] = [];
              row.forEach((cell) => cells.push(delimiterFor(cell.attrs.align)));
              state.write(`| ${cells.join(" | ")} |`);
              state.ensureNewLine();
            }
          });
          state.closeBlock(node);
          state.inTable = false;
        },
        parse: {
          // markdown-it reads tables, alignment included.
        },
      },
    };
  },
});

// A table markdown cannot say (merged cells, a header column, several
// paragraphs in a cell) is written as HTML, exactly as tiptap-markdown's own
// fallback writes it (its HTML node, which the package does not export).
function writeTableHTML(state: TableSerializerState, node: PMNode, parent: PMNode) {
  const schema = node.type.schema;
  let html = getHTMLFromFragment(Fragment.from(node), schema);
  const topLevel = !parent || (parent as unknown) instanceof Fragment || parent.type.name === schema.topNodeType.name;
  if (topLevel) {
    const element = new window.DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body.firstElementChild;
    if (element) {
      element.innerHTML = element.innerHTML.trim() ? `\n${element.innerHTML}\n` : "\n";
      html = element.outerHTML;
    }
  }
  state.write(html);
  state.closeBlock(node);
}
