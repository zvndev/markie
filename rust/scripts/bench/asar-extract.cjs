// Copy files out of an Electron app.asar without any dependency, so the
// benchmark runs the installed app's own code, not this checkout's.
//
//   node asar-extract.cjs <app.asar> <out-dir> <prefix>…
//
// Extracts every file whose path starts with one of the prefixes (for
// example `electron/`). Unpacked files are read from app.asar.unpacked.
const fs = require("node:fs");
const path = require("node:path");

const [asar, out, ...prefixes] = process.argv.slice(2);
const fd = fs.openSync(asar, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const json = Buffer.alloc(jsonLen);
fs.readSync(fd, json, 0, jsonLen, 16);
const header = JSON.parse(json.toString("utf8"));
const base = 8 + headerSize;

let count = 0;
function walk(node, rel) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walk(child, rel ? `${rel}/${name}` : name);
    return;
  }
  if (!prefixes.some((p) => rel.startsWith(p))) return;
  const dest = path.join(out, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (node.unpacked) {
    fs.copyFileSync(path.join(`${asar}.unpacked`, rel), dest);
  } else if (node.size !== undefined && node.offset !== undefined) {
    const buf = Buffer.alloc(node.size);
    fs.readSync(fd, buf, 0, node.size, base + Number(node.offset));
    fs.writeFileSync(dest, buf);
  } else {
    return;
  }
  count++;
}
walk(header, "");
console.log(`extracted ${count} files to ${out}`);
