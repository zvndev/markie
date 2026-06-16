import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// public.ts opens a sqlite handle at import — point it at a throwaway file first.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-pub-")), "t.db");
const { parseDmgName } = await import("./public.ts");

const SAMPLE_YML = `version: 0.2.3
files:
  - url: Markie-0.2.3-arm64-mac.zip
    sha512: abc==
    size: 200709891
  - url: Markie-0.2.3-arm64.dmg
    sha512: def==
    size: 209341444
path: Markie-0.2.3-arm64-mac.zip
sha512: abc==
releaseDate: '2026-06-15T00:00:00.000Z'
`;

test("parseDmgName pulls the .dmg filename from latest-mac.yml", () => {
  assert.equal(parseDmgName(SAMPLE_YML), "Markie-0.2.3-arm64.dmg");
});

test("parseDmgName works across version bumps", () => {
  assert.equal(
    parseDmgName("  - url: Markie-1.4.0-arm64.dmg\n"),
    "Markie-1.4.0-arm64.dmg"
  );
});

test("parseDmgName returns null when no dmg is present", () => {
  assert.equal(parseDmgName("files:\n  - url: Markie-0.2.3-arm64-mac.zip\n"), null);
});
