// A markdown document of a given size, shaped like something a person would
// actually have open: headings, prose with inline marks, lists, fenced code
// and the occasional table. A file of one repeated paragraph would let a
// parser cache its way to a flattering number.
//
// The same generator the performance baseline uses (scripts/perf-baseline.mjs
// carries its own copy so that artifact stays comparable with itself); a
// check that opens a large document should open the same kind of large
// document the baseline measured.
const FENCE = "```";
const WORDS = [
  "render", "buffer", "document", "cursor", "selection", "markdown", "parser",
  "throughput", "latency", "cache", "registry", "workspace", "snapshot",
  "conflict", "revision", "index", "outline", "paragraph", "heading", "table",
];

function sentence(seed, length) {
  const parts = [];
  for (let i = 0; i < length; i += 1) parts.push(WORDS[(seed * 7 + i * 13) % WORDS.length]);
  return `${parts.join(" ")}.`;
}

// One cycle of top-level blocks; each entry is one top-level block.
function blockCycle(n) {
  const blocks = [
    `## Section ${n}`,
    `${sentence(n, 9)} This paragraph carries **bold**, *italic* and \`inline code\`, plus a [link](https://example.com/${n}) so the inline parser has real work. ${sentence(n + 1, 8)}`,
    `${sentence(n + 2, 12)} ${sentence(n + 3, 10)}`,
    `- ${sentence(n + 4, 5)}\n- ${sentence(n + 5, 6)}\n- ${sentence(n + 6, 4)}`,
    `${FENCE}js\nconst step${n} = ${n};\nexport function run${n}(input) {\n  return input.map((v) => v * step${n});\n}\n${FENCE}`,
    `> ${sentence(n + 7, 11)}`,
  ];
  if (n % 5 === 0) {
    blocks.push(
      [
        "| Field | Value | Notes |",
        "| --- | --- | --- |",
        `| rows | ${n * 3} | counted at parse |`,
        `| bytes | ${n * 137} | approximate |`,
        `| owner | ${WORDS[n % WORDS.length]} | assigned |`,
      ].join("\n")
    );
  }
  return blocks;
}

/** @returns {{ text: string, blocks: number, bytes: number }} */
export function generateMarkdown(targetBytes, title) {
  const out = [`# ${title}`, "", `Generated for a Markie check. Target ${Math.round(targetBytes / 1024)} KB.`, ""];
  let blocks = 2; // the title and the intro paragraph
  let bytes = out.join("\n").length;
  let n = 1;
  while (bytes < targetBytes) {
    for (const block of blockCycle(n)) {
      out.push(block, "");
      blocks += 1;
      bytes += block.length + 2;
    }
    n += 1;
  }
  const text = `${out.join("\n")}\n`;
  return { text, blocks, bytes: Buffer.byteLength(text) };
}
