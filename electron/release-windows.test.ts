import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  expectedWindowsArtifacts,
  extractAuthenticodeDer,
  normalizeDistinguishedName,
} from "../scripts/release.mjs";

// A minimal but real PE: MZ header, e_lfanew, PE signature, COFF header, and an
// optional header long enough to hold the data directory. Building it by hand
// is the point — a fixture copied from a signed binary would prove the parser
// works on one file, not that it reads the format.
function pe({
  magic = 0x10b,
  certificateAddress = 0,
  certificateSize = 0,
  payload = Buffer.alloc(0),
} = {}) {
  const peOffset = 0x80;
  const optionalHeader = peOffset + 24;
  const dataDirectory = optionalHeader + (magic === 0x20b ? 112 : 96);
  const headerEnd = dataDirectory + 16 * 8;
  const size = Math.max(headerEnd, certificateAddress + certificateSize);
  const buffer = Buffer.alloc(size);
  buffer.writeUInt16LE(0x5a4d, 0);
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.writeUInt32LE(0x00004550, peOffset);
  buffer.writeUInt16LE(magic, optionalHeader);
  buffer.writeUInt32LE(certificateAddress, dataDirectory + 4 * 8);
  buffer.writeUInt32LE(certificateSize, dataDirectory + 4 * 8 + 4);
  if (certificateSize > 0) payload.copy(buffer, certificateAddress);
  return buffer;
}

function winCertificate(der: Buffer, { certificateType = 0x0002 } = {}) {
  const blob = Buffer.alloc(8 + der.length);
  blob.writeUInt32LE(8 + der.length, 0);
  blob.writeUInt16LE(0x0200, 4);
  blob.writeUInt16LE(certificateType, 6);
  der.copy(blob, 8);
  return blob;
}

describe("expectedWindowsArtifacts", () => {
  it("names both artifacts the Windows feed has to cover", () => {
    expect(expectedWindowsArtifacts("0.4.2")).toEqual([
      "Markie-0.4.2-x64.exe",
      "Markie-0.4.2-x64.zip",
    ]);
  });
});

describe("normalizeDistinguishedName", () => {
  it("treats openssl's spacing as the same name Windows prints without it", () => {
    // openssl 1.1 and 3.x both print `CN = X, C = US`. Reading that as a
    // different name than Windows' `CN=X, C=US` is what would make a correctly
    // signed installer fail its own signature check.
    expect(normalizeDistinguishedName("CN = ZVN DEV LLC, O = ZVN DEV LLC, C = US")).toBe(
      normalizeDistinguishedName("CN=ZVN DEV LLC, O=ZVN DEV LLC, C=US")
    );
  });

  it("treats openssl's ST= and Windows' S= as the same component", () => {
    expect(normalizeDistinguishedName("CN=ZVN DEV LLC, ST=Rhode Island, C=US")).toBe(
      normalizeDistinguishedName("CN=ZVN DEV LLC, S=Rhode Island, C=US")
    );
  });

  it("does not care what order the components arrive in", () => {
    expect(normalizeDistinguishedName("C=US, CN=ZVN DEV LLC")).toBe(
      normalizeDistinguishedName("CN=ZVN DEV LLC, C=US")
    );
  });

  it("strips the subject= prefix openssl prints", () => {
    expect(normalizeDistinguishedName("subject=CN=ZVN DEV LLC")).toBe(
      normalizeDistinguishedName("CN=ZVN DEV LLC")
    );
  });

  it("still tells two different companies apart", () => {
    expect(normalizeDistinguishedName("CN=ZVN DEV LLC, C=US")).not.toBe(
      normalizeDistinguishedName("CN=Someone Else, C=US")
    );
  });
});

describe("extractAuthenticodeDer", () => {
  it("reads the PKCS#7 blob out of a signed PE", () => {
    const der = Buffer.from("30820abc", "hex");
    const certificate = winCertificate(der);
    const binary = pe({ certificateAddress: 0x400, certificateSize: certificate.length, payload: certificate });
    expect(extractAuthenticodeDer(binary)).toEqual(der);
  });

  it("reads PE32+ too, where the data directory sits at a different offset", () => {
    const der = Buffer.from("3082beef", "hex");
    const certificate = winCertificate(der);
    const binary = pe({
      magic: 0x20b,
      certificateAddress: 0x400,
      certificateSize: certificate.length,
      payload: certificate,
    });
    expect(extractAuthenticodeDer(binary)).toEqual(der);
  });

  it("refuses an unsigned binary rather than returning an empty signature", () => {
    // The failure that matters: an unsigned installer must not read as signed
    // with nothing in it, because the caller would then compare no subjects
    // against the expected one and find no mismatch.
    expect(() => extractAuthenticodeDer(pe())).toThrow(/not signed/);
  });

  it("rejects a certificate table that points past the end of the file", () => {
    const binary = pe({ certificateAddress: 0x400, certificateSize: 16 });
    binary.writeUInt32LE(0xffffff, binary.readUInt32LE(0x3c) + 24 + 96 + 4 * 8 + 4);
    expect(() => extractAuthenticodeDer(binary)).toThrow(/past the end/);
  });

  it("rejects a certificate that is not PKCS#7", () => {
    const certificate = winCertificate(Buffer.from("3082dead", "hex"), { certificateType: 0x0001 });
    const binary = pe({ certificateAddress: 0x400, certificateSize: certificate.length, payload: certificate });
    expect(() => extractAuthenticodeDer(binary)).toThrow(/unexpected certificate type/);
  });

  it("rejects something that is not a PE at all", () => {
    expect(() => extractAuthenticodeDer(Buffer.alloc(4096))).toThrow(/not a PE binary/);
  });
});

describe("the signer check end to end", () => {
  it("reads back the subject of a certificate it was given", () => {
    // openssl produces the DER, openssl reads it back: this proves the PE
    // parsing and the subject comparison agree on a real PKCS#7 structure
    // rather than on a hand-written stand-in for one.
    const dir = mkdtempSync(path.join(tmpdir(), "markie-sign-"));
    const key = path.join(dir, "key.pem");
    const cert = path.join(dir, "cert.pem");
    const p7 = path.join(dir, "sig.p7b");
    const subject = "/CN=ZVN DEV LLC/O=ZVN DEV LLC/C=US";
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert, "-days", "1", "-subj", subject,
    ], { stdio: "ignore" });
    writeFileSync(path.join(dir, "content"), "markie");
    execFileSync("openssl", [
      "crl2pkcs7", "-nocrl", "-certfile", cert, "-outform", "DER", "-out", p7,
    ], { stdio: "ignore" });

    const der = readFileSync(p7);
    const certificate = winCertificate(der);
    const binary = pe({ certificateAddress: 0x1000, certificateSize: certificate.length, payload: certificate });
    const extracted = extractAuthenticodeDer(binary);
    expect(extracted).toEqual(der);

    const printed = execFileSync("openssl", ["pkcs7", "-inform", "DER", "-print_certs", "-noout"], {
      input: extracted,
      encoding: "utf8",
    });
    const subjects = printed
      .split(/\r?\n/)
      .filter((line) => line.startsWith("subject="))
      .map((line) => line.slice("subject=".length).trim());
    expect(subjects.map(normalizeDistinguishedName)).toContain(
      normalizeDistinguishedName("CN=ZVN DEV LLC, O=ZVN DEV LLC, C=US")
    );
  });
});
