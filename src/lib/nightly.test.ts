import { describe, expect, it } from "vitest";
import { nightlyFeaturesEnabled, NIGHTLY_STORAGE_KEY } from "./nightly";

function storage(value: string | null): Storage {
  return { getItem: (k: string) => (k === NIGHTLY_STORAGE_KEY ? value : null) } as Storage;
}

describe("nightlyFeaturesEnabled", () => {
  it("is on in the private super-nightly build", () => {
    const api = { privateReleaseAuthOrigin: "https://api.markiedocs.com" };
    expect(nightlyFeaturesEnabled({ api, dev: false, storage: storage(null) })).toBe(true);
  });

  it("is off in a stable build, whatever localStorage says", () => {
    expect(nightlyFeaturesEnabled({ api: {}, dev: false, storage: storage("1") })).toBe(false);
  });

  it("can be turned on in development only", () => {
    expect(nightlyFeaturesEnabled({ api: null, dev: true, storage: storage("1") })).toBe(true);
    expect(nightlyFeaturesEnabled({ api: null, dev: true, storage: storage(null) })).toBe(false);
  });
});
