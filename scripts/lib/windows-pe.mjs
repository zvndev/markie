import { closeSync, fstatSync, openSync, readSync } from "node:fs";

// Microsoft PE/COFF specification: e_lfanew at 0x3c points to PE\0\0,
// followed by the COFF machine and optional-header magic. MZ alone also
// describes DOS programs, and does not prove Windows or x64 compatibility.
// https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
export function readPeImage(filePath) {
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    const dos = Buffer.alloc(64);
    if (readSync(fd, dos, 0, dos.length, 0) !== dos.length || dos.readUInt16LE(0) !== 0x5a4d) {
      throw new Error("missing DOS MZ header");
    }
    const offset = dos.readUInt32LE(0x3c);
    if (offset < dos.length || offset > size - 26) throw new Error("PE header offset is outside the image");
    const header = Buffer.alloc(26);
    if (readSync(fd, header, 0, header.length, offset) !== header.length || header.readUInt32LE(0) !== 0x00004550) {
      throw new Error("missing PE signature");
    }
    const machine = header.readUInt16LE(4);
    const sections = header.readUInt16LE(6);
    const optionalHeaderSize = header.readUInt16LE(20);
    const characteristics = header.readUInt16LE(22);
    const optionalMagic = header.readUInt16LE(24);
    if (sections < 1 || sections > 96) throw new Error("invalid PE section count");
    if (!(characteristics & 0x0002)) throw new Error("PE image is not executable");
    if (optionalHeaderSize < 2 || offset + 24 + optionalHeaderSize + sections * 40 > size) {
      throw new Error("truncated PE optional header or section table");
    }
    return { machine, optionalMagic, sections, size };
  } finally {
    closeSync(fd);
  }
}

export function assertWindowsX64Image(filePath) {
  let image;
  try {
    image = readPeImage(filePath);
  } catch (error) {
    throw new Error(`${filePath}: invalid Windows PE image (${error.message})`);
  }
  if (image.machine !== 0x8664 || image.optionalMagic !== 0x20b) {
    throw new Error(`${filePath}: expected Windows x64 PE32+ image; machine=0x${image.machine.toString(16)}, magic=0x${image.optionalMagic.toString(16)}`);
  }
  return image;
}
