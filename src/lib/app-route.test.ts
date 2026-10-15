import { describe, expect, it } from "vitest";
import { appRoute } from "./app-route";

describe("one Markie app shell", () => {
  it("keeps the established app shell on desktop, web and old workspace URLs", () => {
    expect(appRoute("", false, false)).toBe("classic");
    expect(appRoute("", true, false)).toBe("classic");
    expect(appRoute("?workspace=1", true, false)).toBe("classic");
  });
  it("keeps the classic editor reachable and the workbench development-only", () => {
    expect(appRoute("?classic=1", false, true)).toBe("classic");
    expect(appRoute("?documents=1", false, false)).toBe("classic");
    expect(appRoute("?documents=1", true, true)).toBe("workbench");
  });
});
