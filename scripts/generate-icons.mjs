import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceIcns = path.join(root, "public", "icon.icns");
const iconDir = path.join(root, "build", "icons");
const icoPath = path.join(root, "build", "icon.ico");
const pngSizes = [16, 32, 48, 64, 128, 256, 512, 1024];
const icoSizes = [16, 32, 48, 256];

function runSips(input, output) {
  const result = spawnSync("sips", ["-s", "format", "png", input, "--out", output], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`sips failed: ${result.stderr || result.stdout || "unknown error"}`);
  }
}

function icoByte(size) {
  return size >= 256 ? 0 : size;
}

function writePngIco(entries, output) {
  const headerSize = 6;
  const directorySize = entries.length * 16;
  let offset = headerSize + directorySize;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(directorySize);
  entries.forEach(({ size, data }, index) => {
    const base = index * 16;
    directory.writeUInt8(icoByte(size), base);
    directory.writeUInt8(icoByte(size), base + 1);
    directory.writeUInt8(0, base + 2);
    directory.writeUInt8(0, base + 3);
    directory.writeUInt16LE(1, base + 4);
    directory.writeUInt16LE(32, base + 6);
    directory.writeUInt32LE(data.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += data.length;
  });

  writeFileSync(output, Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]));
}

const tempDir = mkdtempSync(path.join(tmpdir(), "markie-icons-"));

try {
  mkdirSync(iconDir, { recursive: true });
  const basePng = path.join(tempDir, "icon.png");
  runSips(sourceIcns, basePng);

  for (const size of pngSizes) {
    const output = path.join(iconDir, `${size}x${size}.png`);
    await sharp(basePng).resize(size, size).png().toFile(output);
  }

  const icoEntries = icoSizes.map((size) => ({
    size,
    data: readFileSync(path.join(iconDir, `${size}x${size}.png`)),
  }));
  writePngIco(icoEntries, icoPath);

  console.log(`generated ${icoPath}`);
  console.log(`generated ${pngSizes.length} PNG icons in ${iconDir}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
