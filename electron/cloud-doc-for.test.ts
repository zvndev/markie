import { describe, expect, it } from "vitest";
import { cloudDocFor } from "./cloud-doc-for";

const oneCloudDoc = () => [{ cloud_doc_id: "doc-1" }];

describe("cloudDocFor", () => {
  it("names the reference relative to the document's folder", () => {
    expect(
      cloudDocFor({
        docDir: "/Users/k/report",
        requested: "/Users/k/report/shots/a.png",
        cloudDocsInDir: oneCloudDoc,
      })
    ).toEqual({ cloudId: "doc-1", ref: "shots/a.png" });
  });

  it("treats a child folder literally named '..hidden' as a child, not a walk upward", () => {
    // rel.startsWith("..") alone would refuse this: "..hidden" starts with
    // ".." as a string without being the ".." path segment.
    expect(
      cloudDocFor({
        docDir: "/Users/k/report",
        requested: "/Users/k/report/..hidden/a.png",
        cloudDocsInDir: oneCloudDoc,
      })
    ).toEqual({ cloudId: "doc-1", ref: "..hidden/a.png" });
  });

  it("refuses a path that actually walks out of the folder", () => {
    // A sibling of the folder: rel is "../a.png".
    expect(
      cloudDocFor({
        docDir: "/Users/k/report",
        requested: "/Users/k/a.png",
        cloudDocsInDir: oneCloudDoc,
      })
    ).toBeNull();
    // The folder's own parent: rel is exactly "..", which the `startsWith`
    // half of the check alone would miss.
    expect(
      cloudDocFor({
        docDir: "/Users/k/report",
        requested: "/Users/k",
        cloudDocsInDir: oneCloudDoc,
      })
    ).toBeNull();
  });

  it("answers null for a folder with no cloud document", () => {
    expect(
      cloudDocFor({
        docDir: "/Users/k/report",
        requested: "/Users/k/report/a.png",
        cloudDocsInDir: () => [],
      })
    ).toBeNull();
  });

  it("picks the first of several cloud documents sharing the folder", () => {
    expect(
      cloudDocFor({
        docDir: "/Users/k/report",
        requested: "/Users/k/report/a.png",
        cloudDocsInDir: () => [{ cloud_doc_id: "doc-first" }, { cloud_doc_id: "doc-second" }],
      })
    ).toEqual({ cloudId: "doc-first", ref: "a.png" });
  });
});
