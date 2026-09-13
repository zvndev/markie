import { describe, expect, it } from "vitest";
import { cloudDocFor } from "./cloud-doc-for";

const cloudRow = () => ({ cloud_doc_id: "doc-1" });
const docPath = "/Users/k/report/notes.md";

describe("cloudDocFor", () => {
  it("names the reference relative to the document's own folder", () => {
    expect(
      cloudDocFor({ docPath, requested: "/Users/k/report/shots/a.png", get: cloudRow })
    ).toEqual({ cloudId: "doc-1", ref: "shots/a.png" });
  });

  it("asks about the one document it was given, not the folder", () => {
    // Two synced documents can share a folder and reference the same missing
    // picture. The row that answers is the document on screen, never
    // whichever of its neighbours was opened last.
    const asked: string[] = [];
    const get = (p: string) => {
      asked.push(p);
      return cloudRow();
    };
    expect(cloudDocFor({ docPath, requested: "/Users/k/report/a.png", get })).toEqual({
      cloudId: "doc-1",
      ref: "a.png",
    });
    expect(asked).toEqual([docPath]);
  });

  it("treats a child folder literally named '..hidden' as a child, not a walk upward", () => {
    // rel.startsWith("..") alone would read this as a walk out: "..hidden"
    // starts with ".." as a string without being the ".." path segment.
    expect(
      cloudDocFor({ docPath, requested: "/Users/k/report/..hidden/a.png", get: cloudRow })
    ).toEqual({ cloudId: "doc-1", ref: "..hidden/a.png" });
  });

  it("keeps an absolute reference for a picture outside the document's folder", () => {
    // A document may embed an allowed absolute path, and the uploader stored
    // that absolute string verbatim as the ref. The reading device has to ask
    // for the same string or the server has nothing under that name.
    expect(cloudDocFor({ docPath, requested: "/Users/k/a.png", get: cloudRow })).toEqual({
      cloudId: "doc-1",
      ref: "/Users/k/a.png",
    });
    expect(cloudDocFor({ docPath, requested: "/elsewhere/logo.png", get: cloudRow })).toEqual({
      cloudId: "doc-1",
      ref: "/elsewhere/logo.png",
    });
  });

  it("normalises the document path before it looks anything up", () => {
    // registry.get canonicalises what it is handed, so a spelling with a "."
    // segment still finds the row, and the folder computed from the raw
    // string would then name the reference wrongly.
    const asked: string[] = [];
    const get = (p: string) => {
      asked.push(p);
      return cloudRow();
    };
    expect(
      cloudDocFor({ docPath: "/Users/k/report/./notes.md", requested: "/Users/k/report/shots/a.png", get })
    ).toEqual({ cloudId: "doc-1", ref: "shots/a.png" });
    expect(asked).toEqual([docPath]);
    expect(
      cloudDocFor({ docPath: "/Users/k/other/../report/notes.md", requested: "/Users/k/report/a.png", get: cloudRow })
    ).toEqual({ cloudId: "doc-1", ref: "a.png" });
  });

  it("answers null when the registry has no row for the document", () => {
    expect(cloudDocFor({ docPath, requested: "/Users/k/report/a.png", get: () => null })).toBeNull();
    expect(
      cloudDocFor({ docPath, requested: "/Users/k/report/a.png", get: () => undefined })
    ).toBeNull();
  });

  it("answers null for a document that is not in the cloud", () => {
    expect(
      cloudDocFor({ docPath, requested: "/Users/k/report/a.png", get: () => ({ cloud_doc_id: null }) })
    ).toBeNull();
  });
});
