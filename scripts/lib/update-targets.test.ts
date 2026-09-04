// psQuote is one line, and it cost a Windows release check a failing gate.
//
// JSON.stringify was used to put a path into a PowerShell command. PowerShell
// has no backslash escapes, so every separator came out doubled. .NET
// normalises that away for Get-Item and not for Get-AuthenticodeSignature, so
// the mistake showed up as one check failing rather than as everything failing,
// which is the kind of bug that gets diagnosed as "flaky Windows".
import { describe, expect, it } from "vitest";
import { psQuote } from "./update-targets.mjs";

describe("quoting a path for PowerShell", () => {
  it("leaves a Windows path's separators exactly as they are", () => {
    expect(psQuote("C:\\Users\\me\\Markie.exe")).toBe("'C:\\Users\\me\\Markie.exe'");
  });

  it("never doubles a backslash, whatever JSON would do", () => {
    const path = "C:\\a\\b";
    expect(psQuote(path)).not.toContain("\\\\");
    expect(JSON.stringify(path)).toContain("\\\\");
  });

  it("escapes a quote the one way PowerShell accepts, by doubling it", () => {
    expect(psQuote("C:\\it's here\\x.exe")).toBe("'C:\\it''s here\\x.exe'");
  });

  it("does not let a path close the string and run something after it", () => {
    // A single-quoted PowerShell string is literal all the way through, so the
    // only thing that could end it early is an unescaped quote.
    const hostile = "C:\\x'; Remove-Item C:\\ -Recurse; '";
    const quoted = psQuote(hostile);
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    expect(quoted.slice(1, -1).split("''").join("")).not.toContain("'");
  });

  it("handles a path with spaces without needing anything else", () => {
    expect(psQuote("C:\\Program Files\\Markie\\Markie.exe")).toBe(
      "'C:\\Program Files\\Markie\\Markie.exe'"
    );
  });
});
