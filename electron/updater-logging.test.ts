import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { guardedLogger, LEVELS } = require("./updater-logging.js");

describe("the updater's logger", () => {
  it("passes messages through to the console it wraps", () => {
    const info = vi.fn();
    guardedLogger({ info }).info("checking for update", 1);
    expect(info).toHaveBeenCalledWith("checking for update", 1);
  });

  // The actual incident: console.debug threw EPIPE because stdout was a closed
  // pipe, which became an uncaught exception in the main process, which put a
  // blocking dialog on screen during quitAndInstall.
  it("swallows a write that throws instead of letting it escape", () => {
    const logger = guardedLogger({
      debug: () => {
        throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      },
    });
    expect(() => logger.debug("staging update")).not.toThrow();
  });

  it("keeps working after a failed write", () => {
    let fail = true;
    const sink = {
      info: vi.fn(() => {
        if (fail) throw new Error("write EPIPE");
      }),
    };
    const logger = guardedLogger(sink);
    expect(() => logger.info("first")).not.toThrow();
    fail = false;
    logger.info("second");
    expect(sink.info).toHaveBeenCalledTimes(2);
  });

  it("guards every level it exposes", () => {
    const sink: Record<string, () => void> = {};
    for (const level of LEVELS) {
      sink[level] = () => {
        throw new Error("write EPIPE");
      };
    }
    const logger = guardedLogger(sink);
    for (const level of LEVELS) {
      expect(() => logger[level]("x")).not.toThrow();
    }
  });

  // electron-updater checks `if (this._logger.debug != null)` before calling
  // it. Stubbing a level the sink does not have would change what it logs.
  it("does not invent levels the console does not have", () => {
    const logger = guardedLogger({ info: () => {} });
    expect(logger.debug).toBeUndefined();
    expect(logger.info).toBeTypeOf("function");
  });

  it("survives being handed nothing to log to", () => {
    expect(() => guardedLogger(undefined)).not.toThrow();
    expect(() => guardedLogger(null)).not.toThrow();
  });
});
