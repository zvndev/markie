import { describe, expect, it } from "vitest";
import {
  addDotenvEntry,
  duplicateDotenvKeys,
  formatDotenvValue,
  isEnvFileName,
  isValidDotenvKey,
  parseDotenv,
  removeDotenvLine,
  serializeDotenv,
  updateDotenvEntry,
  type DotenvDocument,
  type DotenvEntryLine,
} from "./dotenv";

const roundTrip = (text: string) => serializeDotenv(parseDotenv(text));
const entries = (document: DotenvDocument) => document.lines.filter((line): line is DotenvEntryLine => line.kind === "entry");
const entry = (document: DotenvDocument, key: string) => entries(document).find((line) => line.key === key)!;

const FIXTURES: Record<string, string> = {
  empty: "",
  "lone LF": "\n",
  "lone CRLF": "\r\n",
  "no trailing newline": "A=1",
  "trailing newline": "A=1\n",
  "several trailing newlines": "A=1\n\n\n",
  crlf: "A=1\r\nB=2\r\n",
  "crlf without final break": "A=1\r\nB=2",
  "classic mac cr": "A=1\rB=2\r",
  "mixed endings": "A=1\r\nB=2\nC=3\rD=4",
  comments: "# heading\n  # indented comment\n#\nA=1 # trailing comment\n",
  "blank lines with whitespace": "A=1\n   \n\t\nB=2\n",
  export: "export A=1\nexport\tB='two'\n  export   C=\"three\"\n",
  "equals inside values": "URL=postgres://u:p@h/db?a=b&c=d\nB64=YWJj==\nQ=\"x=y\"\n",
  "trailing spaces": "A=value   \nB='quoted'   \nC=\"d\"\t \n",
  "spaces around equals": "A = 1\nB\t=\t2\nC =\n",
  "empty values": "A=\nB=''\nC=\"\"\nD= \n",
  "hash in quotes": "A=\"pa#ss # word\"\nB='#not a comment'\nC=abc#frag\nD= #only comment\n",
  "escapes in double quotes": "A=\"line\\nbreak \\\"q\\\" back\\\\slash \\$HOME\"\n",
  "multi-line double quoted": "KEY=\"-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----\"\nNEXT=1\n",
  "multi-line single quoted crlf": "KEY='one\r\ntwo'\r\nNEXT=2\r\n",
  "backticks": "A=`it's \"both\"`\n",
  unicode: "GREETING=héllo wörld 🌍\nEMOJI=\"✓\"\n",
  "dotted and underscored keys": "_A=1\nspring.datasource.url=jdbc:x\nA1_B.C=2\n",
  duplicates: "A=1\nB=2\nA=3\n",
  "malformed: no equals": "JUSTAWORD\nexport ONLYEXPORT\nA=1\n",
  "malformed: invalid keys": "1ABC=x\nMY-KEY=y\nHAS SPACE=z\n=novalue\n",
  "malformed: unclosed quote": "A=\"never closed\nB=2\n",
  "malformed: text after closing quote": "A=\"x\" junk\nB='y'z\n",
  "malformed: unclosed at end of file": "A=1\nB='open",
  "leading byte order mark character": "\uFEFFA=1\n",
  "only comments": "# a\n# b",
  "tab separated value": "A=\tvalue\twith\ttabs\n",
};

describe("dotenv round-trip", () => {
  for (const [name, text] of Object.entries(FIXTURES)) {
    it(`returns ${name} byte-identical`, () => {
      expect(roundTrip(text)).toBe(text);
    });
  }

  it("is byte-identical for generated files mixing every line form and line ending", () => {
    const forms = ["A=1", "export B=two", "C=\"q # x\"", "D='s'", "E=", "# c", "", "  ", "bad line", "1X=y", "F=x # note", "G = spaced  ",
      "H=\"multi\nline\"", "I=\"unclosed", "J=a=b=c", "K=`tick`", "L=\"x\" trailing junk"];
    const endings = ["\n", "\r\n", "\r"];
    let seed = 7;
    const random = (limit: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % limit; };
    for (let file = 0; file < 300; file++) {
      let text = "";
      const count = random(12);
      for (let line = 0; line < count; line++) text += forms[random(forms.length)] + (line === count - 1 && random(2) ? "" : endings[random(endings.length)]);
      expect(roundTrip(text)).toBe(text);
    }
  });
});

describe("dotenv parsing", () => {
  it("reads unquoted, quoted, exported and empty values", () => {
    const document = parseDotenv([
      "PLAIN=hello world  ", "export EXPORTED=1", "SINGLE='a \\n b'", "DOUBLE=\"a\\nb\\t\\\"c\\\"\\\\\"", "EMPTY=", "EQUALS=a=b",
      "COMMENTED=value # note", "FRAGMENT=http://x/#top", "HASH=\"#1\"", "SPACED = padded",
    ].join("\n"));
    expect(entry(document, "PLAIN").value).toBe("hello world");
    expect(entry(document, "EXPORTED")).toMatchObject({ value: "1", exported: true });
    expect(entry(document, "SINGLE")).toMatchObject({ value: "a \\n b", quote: "'" });
    expect(entry(document, "DOUBLE")).toMatchObject({ value: "a\nb\t\"c\"\\", quote: "\"" });
    expect(entry(document, "EMPTY").value).toBe("");
    expect(entry(document, "EQUALS").value).toBe("a=b");
    expect(entry(document, "COMMENTED").value).toBe("value");
    expect(entry(document, "FRAGMENT").value).toBe("http://x/#top");
    expect(entry(document, "HASH").value).toBe("#1");
    expect(entry(document, "SPACED").value).toBe("padded");
  });

  it("classifies comments, blanks and malformed lines and keeps their text", () => {
    const document = parseDotenv("# note\n\nNOT VALID\n9KEY=x\nA=\"open\n");
    expect(document.lines.map((line) => line.kind)).toEqual(["comment", "blank", "malformed", "malformed", "malformed"]);
    expect(document.lines.map((line) => line.raw)).toEqual(["# note", "", "NOT VALID", "9KEY=x", "A=\"open"]);
    expect(document.lines[2]).toMatchObject({ reason: expect.stringContaining("no = sign") });
    expect(document.lines[3]).toMatchObject({ reason: expect.stringContaining("not a valid name") });
    expect(document.lines[4]).toMatchObject({ reason: expect.stringContaining("never closed") });
  });

  it("joins a multi-line quoted value into one entry that keeps its inner line breaks", () => {
    const document = parseDotenv("PEM=\"-----BEGIN-----\r\nabc\r\n-----END-----\"\r\nNEXT=1\r\n");
    expect(document.lines).toHaveLength(2);
    expect(entry(document, "PEM").value).toBe("-----BEGIN-----\r\nabc\r\n-----END-----");
    expect(entry(document, "NEXT").value).toBe("1");
  });

  it("uses the file's first line ending for added lines", () => {
    expect(parseDotenv("A=1\r\nB=2\n").newline).toBe("\r\n");
    expect(parseDotenv("A=1\rB=2").newline).toBe("\r");
    expect(parseDotenv("A=1").newline).toBe("\n");
  });

  it("validates keys", () => {
    for (const key of ["A", "_a", "a.b", "A_1.x"]) expect(isValidDotenvKey(key)).toBe(true);
    for (const key of ["", "1A", "A-B", "A B", ".A", "A=B", "ÄKEY"]) expect(isValidDotenvKey(key)).toBe(false);
  });

  it("reports duplicate keys", () => {
    expect([...duplicateDotenvKeys(parseDotenv("A=1\nB=2\nA=3\nC=4\nC=5\n"))].sort()).toEqual(["A", "C"]);
    expect(duplicateDotenvKeys(parseDotenv("A=1\nB=2\n")).size).toBe(0);
  });
});

describe("dotenv edits", () => {
  const source = "# Database\r\nexport DB_URL=postgres://a  # primary\r\n\r\nTOKEN='abc'\r\nbroken line\r\nLAST=\"x\"";

  it("changes only the touched line and keeps every other byte", () => {
    const document = parseDotenv(source);
    const edited = serializeDotenv(updateDotenvEntry(document, entry(document, "TOKEN").id, { value: "new" }));
    expect(edited).toBe(source.replace("TOKEN='abc'", "TOKEN='new'"));
  });

  it("keeps export, spacing and the inline comment when a value changes", () => {
    const document = parseDotenv(source);
    const edited = serializeDotenv(updateDotenvEntry(document, entry(document, "DB_URL").id, { value: "postgres://b" }));
    expect(edited).toBe(source.replace("export DB_URL=postgres://a  # primary", "export DB_URL=postgres://b  # primary"));
  });

  it("renames a key in place", () => {
    const document = parseDotenv(source);
    const edited = serializeDotenv(updateDotenvEntry(document, entry(document, "LAST").id, { key: "FINAL" }));
    expect(edited).toBe(source.replace("LAST=\"x\"", "FINAL=\"x\""));
  });

  it("double-quotes and escapes values that need quoting, and they read back unchanged", () => {
    const tricky = ["has space", "a#b", "say \"hi\"", "it's", "back\\slash", "line\nbreak", "cr\rhere", " lead", "trail ", "`tick`", "\t", "plain", "", "x=y"];
    for (const previous of ["", "'", "\"", "`"] as const) {
      for (const value of tricky) {
        const document = parseDotenv(`K=${previous}v${previous} # keep\n`);
        const edited = serializeDotenv(updateDotenvEntry(document, document.lines[0].id, { value }));
        const reread = parseDotenv(edited);
        expect(reread.lines).toHaveLength(1);
        expect(entry(reread, "K").value).toBe(value);
        expect(edited.endsWith(" # keep\n")).toBe(true);
      }
    }
    expect(formatDotenvValue("has space")).toBe("\"has space\"");
    expect(formatDotenvValue("say \"hi\"\n")).toBe("\"say \\\"hi\\\"\\n\"");
    expect(formatDotenvValue("plain")).toBe("plain");
    expect(formatDotenvValue("plain", "'")).toBe("'plain'");
  });

  it("keeps a bare value apart from a comment that directly followed an empty value", () => {
    const document = parseDotenv("A= # note\n");
    const edited = serializeDotenv(updateDotenvEntry(document, document.lines[0].id, { value: "abc" }));
    expect(edited).toBe("A= abc # note\n");
    expect(entry(parseDotenv(edited), "A").value).toBe("abc");
  });

  it("adds entries with the file's line ending and keeps a missing final break missing", () => {
    const withoutBreak = addDotenvEntry(parseDotenv("A=1\r\nB=2"), "NEW", "two words");
    expect(serializeDotenv(withoutBreak)).toBe("A=1\r\nB=2\r\nNEW=\"two words\"");
    const withBreak = addDotenvEntry(parseDotenv("A=1\n"), "NEW", "v");
    expect(serializeDotenv(withBreak)).toBe("A=1\nNEW=v\n");
    // A new file follows the POSIX convention of a final line break.
    expect(serializeDotenv(addDotenvEntry(parseDotenv(""), "FIRST", "1"))).toBe("FIRST=1\n");
  });

  it("gives added rows fresh ids that later edits can target", () => {
    let document = addDotenvEntry(parseDotenv("A=1\n"));
    const added = document.lines.at(-1)!;
    expect(added.id).not.toBe(document.lines[0].id);
    document = updateDotenvEntry(document, added.id, { key: "B" });
    document = updateDotenvEntry(document, added.id, { value: "2" });
    expect(serializeDotenv(document)).toBe("A=1\nB=2\n");
  });

  it("removes a line without touching the others", () => {
    const document = parseDotenv(source);
    expect(serializeDotenv(removeDotenvLine(document, entry(document, "TOKEN").id))).toBe(source.replace("TOKEN='abc'\r\n", ""));
    expect(serializeDotenv(removeDotenvLine(document, entry(document, "LAST").id))).toBe(source.replace("\r\nLAST=\"x\"", ""));
    expect(removeDotenvLine(document, 999)).toBe(document);
  });

  it("does not edit comments or malformed lines through the entry API", () => {
    const document = parseDotenv("# c\nbad\n");
    const edited = updateDotenvEntry(updateDotenvEntry(document, 0, { value: "x" }), 1, { key: "Y" });
    expect(serializeDotenv(edited)).toBe("# c\nbad\n");
  });
});

describe("env file names", () => {
  it("recognizes dotenv names", () => {
    for (const name of [".env", ".ENV", "prod.env", "Untitled.env", ".env.local", ".env.production.local", "dir/.env.test"]) expect(isEnvFileName(name)).toBe(true);
    for (const name of ["env", "notes.txt", ".envrc", "environment.json", ".env.", "prod.env.txt"]) expect(isEnvFileName(name)).toBe(false);
  });
});
