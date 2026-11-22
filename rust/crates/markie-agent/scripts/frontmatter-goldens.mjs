// Electron's SKILL.md description, as electron/mdindex.js skillDescription
// reads it, for each case. Run from the worktree root:
//   node rust/crates/markie-agent/scripts/frontmatter-goldens.mjs
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { parseFrontmatter } = require("../../../../electron/skill-frontmatter.js");

const cases = [
  "---\nname: a\ndescription: Plain words\n---\nbody",
  "---\ndescription: \"Quoted: with colon\"\n---\n",
  "---\ndescription: 'Single ''quoted'''\n---\n",
  "---\ndescription: \"Escapes \\\"in\\\" \\\\ here\\n next\"\n---\n",
  "---\ndescription: >\n  Folded over\n  two lines.\n---\n",
  "---\ndescription: >-\n  Folded strip\n  chomp.\n---\n",
  "---\ndescription: |\n  Literal\n  block\n---\n",
  "---\ndescription: |-\n  Literal\n\n  gap\n---\n",
  "---\ndescription: >2\n    Indented\n    explicit\n---\n",
  "---\ndescription: >\n  Para one\n\n  para two\n---\n",
  "---\ndescription: Words # a comment\n---\n",
  "---\ndescription: [a, b]\n---\n",
  "---\ndescription: &anchor value\n---\n",
  "---\ndescription: \"unterminated\n---\n",
  "---\ndescription:\n---\n",
  "---\ndescription:   \n---\n",
  "---\nname: x\n---\nno description",
  "no front matter\ndescription: nope\n",
  "---\r\ndescription: CRLF line\r\n---\r\nbody",
  "---  \ndescription: trailing spaces on fence\n---  \n",
  "---\ndescription: unclosed front matter\n",
  "---\nmeta:\n  description: nested only\n---\n",
  "---\ndescription: first\ndescription: second\n---\n",
  "---\nDescription: capital key\n---\n",
  "---\ndescription : space before colon\n---\n",
  "---\n  description: indented key\n---\n",
  "---\ndescription: a: b: c\n---\n",
  "---\ndescription: '  padded  '\n---\n",
  "---\ndescription: \"\"\n---\n",
  "---\ndescription: >\n\n  leading blank\n---\n",
  "---\ndescription: ~\n---\n",
  "---\ndescription: null\n---\n",
  "---\ndescription: 42\n---\n",
  "---\ndescription: |+\n  keep\n\n---\n",
  "---\ndescription: x\n---\n---\ndescription: y\n---\n",
  "﻿---\ndescription: bom\n---\n",
  "---\ndescription: tab\there\n---\n",
  "---\ndescription: >\n  folded\n   more indented\n  back\n---\n",
];

const out = cases.map((text) => {
  const value = parseFrontmatter(text).fields.description;
  return { text, description: typeof value === "string" && value.trim() ? value.trim() : null };
});
writeFileSync(new URL("../tests/goldens/frontmatter.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`${out.length} cases`);
