import { describe, expect, it } from "vitest";
import { appRoute } from "./app-route";

describe("shared document workspace routing", () => {
  it("opens the usable workspace on web while preserving native file launches", () => {
    expect(appRoute("", false, false)).toBe("documents");
    expect(appRoute("", true, false)).toBe("classic");
    expect(appRoute("?workspace=1", true, false)).toBe("documents");
  });
  it("keeps the classic editor reachable and the workbench development-only", () => {
    expect(appRoute("?classic=1", false, true)).toBe("classic");
    expect(appRoute("?documents=1", false, false)).toBe("documents");
    expect(appRoute("?documents=1", true, true)).toBe("workbench");
  });
});
