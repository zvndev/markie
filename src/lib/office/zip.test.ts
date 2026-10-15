import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readZip, writeZip, zipCrc32 } from "./zip";

const encoder = new TextEncoder();
function oneEntry(name = "word/document.xml", text = "hello") {
  return writeZip([{ name, data: encoder.encode(text) }]);
}
function deflated(text: string, descriptor = false): Uint8Array {
  const source = encoder.encode(text);
  const compressed = deflateRawSync(source);
  const stored = oneEntry("part.xml", text);
  const nameLength = encoder.encode("part.xml").length;
  const headerLength = 30 + nameLength;
  const centralStart = headerLength + source.length;
  const descriptorLength = descriptor ? 16 : 0;
  const bytes = new Uint8Array(stored.length - source.length + compressed.length + descriptorLength);
  bytes.set(stored.subarray(0, headerLength));
  bytes.set(compressed, headerLength);
  const newCentral = headerLength + compressed.length + descriptorLength;
  bytes.set(stored.subarray(centralStart), newCentral);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 8, true);
  view.setUint32(18, compressed.length, true);
  view.setUint16(newCentral + 10, 8, true);
  view.setUint32(newCentral + 20, compressed.length, true);
  view.setUint32(bytes.length - 6, newCentral, true);
  if (descriptor) {
    view.setUint16(6, 0x0808, true);
    view.setUint16(newCentral + 8, 0x0808, true);
    view.setUint32(14, 0, true);
    view.setUint32(18, 0, true);
    view.setUint32(22, 0, true);
    const start = headerLength + compressed.length;
    view.setUint32(start, 0x08074b50, true);
    view.setUint32(start + 4, zipCrc32(source), true);
    view.setUint32(start + 8, compressed.length, true);
    view.setUint32(start + 12, source.length, true);
  }
  return bytes;
}

describe("bounded original ZIP foundation", () => {
  it("implements the published CRC-32 check value", () => {
    expect(zipCrc32(encoder.encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes and reads Unicode part contents and independent owned buffers", async () => {
    const bytes = oneEntry("word/document.xml", "Hello 😀");
    const result = await readZip(bytes);
    expect(new TextDecoder().decode(result[0].data)).toBe("Hello 😀");
    result[0].data.fill(0);
    expect(new TextDecoder().decode((await readZip(bytes))[0].data)).toBe("Hello 😀");
  });

  it("never strips a leading filename BOM or aliases it to a different part", async () => {
    const bytes = writeZip([{ name: "\ufeffpart.xml", data: encoder.encode("x") }, { name: "part.xml", data: encoder.encode("y") }]);
    expect((await readZip(bytes)).map((part) => part.name)).toEqual(["\ufeffpart.xml", "part.xml"]);
  });

  it.each([false, true])("reads platform-DEFLATE entries (data descriptor=%s)", async (descriptor) => {
    const bytes = deflated("Generated fixture α".repeat(80), descriptor);
    expect(new TextDecoder().decode((await readZip(bytes))[0].data)).toBe("Generated fixture α".repeat(80));
  });

  it.each(["../word.xml", "/word.xml", "word\\x.xml", "word//x.xml", "word/./x.xml", "word/%2e%2e/x.xml", "word/a:b.xml", "a\u0000.xml"])("rejects unsafe paths %s", (name) => {
    expect(() => oneEntry(name)).toThrow();
  });

  it("rejects unsafe paths in input as well as output", async () => {
    const bytes = oneEntry("../x".replace("..", "ok"));
    for (let i = 0; i < bytes.length - 3; i++) {
      if (bytes[i] === 111 && bytes[i + 1] === 107 && bytes[i + 2] === 47 && bytes[i + 3] === 120) {
        bytes[i] = 46; bytes[i + 1] = 46;
      }
    }
    await expect(readZip(bytes)).rejects.toThrow(/Unsafe/);
  });

  it("rejects duplicate case-aliased paths", () => {
    expect(() => writeZip([{ name: "a.xml", data: new Uint8Array() }, { name: "A.xml", data: new Uint8Array() }])).toThrow(/Duplicate/);
  });

  it("checks CRC before exposing entries", async () => {
    const bytes = oneEntry();
    bytes[30 + encoder.encode("word/document.xml").length] ^= 1;
    await expect(readZip(bytes)).rejects.toThrow(/integrity/);
  });

  it("rejects encrypted flags, truncated headers, trailing junk and mismatches", async () => {
    const bytes = oneEntry();
    const encrypted = new Uint8Array(bytes);
    const view = new DataView(encrypted.buffer);
    const central = 30 + encoder.encode("word/document.xml").length + 5;
    view.setUint16(6, 0x0801, true);
    view.setUint16(central + 8, 0x0801, true);
    await expect(readZip(encrypted)).rejects.toThrow(/Encrypted/);
    await expect(readZip(bytes.slice(0, -8))).rejects.toThrow();
    await expect(readZip(new Uint8Array([...bytes, 0]))).rejects.toThrow(/trailing/);
    const mismatch = new Uint8Array(bytes);
    mismatch[30] ^= 1;
    await expect(readZip(mismatch)).rejects.toThrow(/disagree/);
  });

  it("preflights declared expansion, entry counts, invalid limits and actual inflated size", async () => {
    await expect(readZip(oneEntry(), { maxArchiveBytes: 2 })).rejects.toThrow(/size limit/);
    await expect(readZip(oneEntry(), { maxEntryBytes: 2 })).rejects.toThrow(/expansion/);
    await expect(readZip(deflated("a".repeat(1000)), { maxCompressionRatio: 2 })).rejects.toThrow(/expansion/);
    await expect(readZip(oneEntry(), { maxEntries: -1 })).rejects.toThrow(/positive/);
    const bomb = deflated("a".repeat(1000));
    const view = new DataView(bomb.buffer);
    const central = view.getUint32(bomb.length - 6, true);
    view.setUint32(22, 1, true);
    view.setUint32(central + 24, 1, true);
    await expect(readZip(bomb)).rejects.toThrow(/beyond/);
  });

  it("rejects overlapping or hidden local records before inflation", async () => {
    const bytes = writeZip([{ name: "a", data: encoder.encode("abc") }, { name: "b", data: encoder.encode("abc") }]);
    const view = new DataView(bytes.buffer);
    const central = view.getUint32(bytes.length - 6, true);
    view.setUint32(central + 47 + 42, 0, true);
    await expect(readZip(bytes)).rejects.toThrow();
  });
});
