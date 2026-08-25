import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const { createIpcHandler, errorMessage } = load("./ipc-result.js");

type Handler = (...args: unknown[]) => unknown;

let registered: Map<string, Handler>;
let reported: Array<[string, unknown]>;

const ipcMain = {
  handle: (channel: string, fn: Handler) => registered.set(channel, fn),
};

function makeHandle() {
  return createIpcHandler({
    ipcMain,
    onError: (channel: string, err: unknown) => reported.push([channel, err]),
  });
}

beforeEach(() => {
  registered = new Map();
  reported = [];
});

describe("errorMessage", () => {
  it("strips the Error: prefix a user should never see", () => {
    expect(errorMessage(new Error("the disk is full"))).toBe("the disk is full");
  });

  it("passes a plain string through", () => {
    expect(errorMessage("nope")).toBe("nope");
  });

  it("has an answer for null, undefined, and an empty message", () => {
    expect(errorMessage(null)).toBe("Something went wrong.");
    expect(errorMessage(undefined)).toBe("Something went wrong.");
    expect(errorMessage(new Error(""))).toBe("Something went wrong.");
  });

  it("describes a thrown non-Error", () => {
    expect(errorMessage({ toString: () => "weird failure" })).toBe("weird failure");
  });
});

describe("createIpcHandler", () => {
  it("registers the channel on ipcMain", () => {
    makeHandle()("thing", () => 1);
    expect([...registered.keys()]).toEqual(["thing"]);
  });

  it("passes arguments through and returns the value unchanged", async () => {
    makeHandle()("thing", (_event: unknown, arg: unknown) => ({ got: arg }));
    await expect(registered.get("thing")!({}, "payload")).resolves.toEqual({
      got: "payload",
    });
  });

  it("awaits an async handler", async () => {
    makeHandle()("thing", async () => "later");
    await expect(registered.get("thing")!({})).resolves.toBe("later");
  });

  it("answers { error } instead of rejecting when the handler throws", async () => {
    makeHandle()("thing", () => {
      throw new Error("boom");
    });
    await expect(registered.get("thing")!({})).resolves.toEqual({ error: "boom" });
  });

  it("answers { error } when an async handler rejects", async () => {
    makeHandle()("thing", async () => {
      throw new Error("async boom");
    });
    await expect(registered.get("thing")!({})).resolves.toEqual({ error: "async boom" });
  });

  it("reports the failure with the channel name so it lands in the crash log", async () => {
    makeHandle()("doc-pull", () => {
      throw new Error("boom");
    });
    await registered.get("doc-pull")!({});
    expect(reported).toHaveLength(1);
    expect(reported[0][0]).toBe("doc-pull");
    expect(String((reported[0][1] as Error).message)).toBe("boom");
  });

  it("uses onFailure for channels whose callers truth-test the payload", async () => {
    makeHandle()(
      "open-file",
      () => {
        throw new Error("boom");
      },
      { onFailure: () => null }
    );
    await expect(registered.get("open-file")!({})).resolves.toBeNull();
  });

  it("hands onFailure the error so it can shape its own answer", async () => {
    makeHandle()(
      "export-pdf",
      () => {
        throw new Error("no room on disk");
      },
      { onFailure: (err: Error) => ({ success: false, error: err.message }) }
    );
    await expect(registered.get("export-pdf")!({})).resolves.toEqual({
      success: false,
      error: "no room on disk",
    });
  });

  it("still answers when the error reporter itself throws", async () => {
    const handle = createIpcHandler({
      ipcMain,
      onError: () => {
        throw new Error("the logger is the thing that broke");
      },
    });
    handle("thing", () => {
      throw new Error("boom");
    });
    await expect(registered.get("thing")!({})).resolves.toEqual({ error: "boom" });
  });

  it("works without an onError reporter at all", async () => {
    const handle = createIpcHandler({ ipcMain });
    handle("thing", () => {
      throw new Error("boom");
    });
    await expect(registered.get("thing")!({})).resolves.toEqual({ error: "boom" });
  });
});
