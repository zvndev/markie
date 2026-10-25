// The app's API client against the mock server, over real HTTP: the same
// requests a device makes, end to end, without a device.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiClient } from "../src/lib/api";
import { fetchTransport } from "../src/lib/http";
import { parseMarkieLink, resolveForSession } from "../src/lib/deep-links";

let child: ChildProcess;
let origin = "";

beforeAll(async () => {
  child = spawn(process.execPath, [fileURLToPath(new URL("../dev/mock-server.mjs", import.meta.url)), "--port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
  origin = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (chunk) => {
      out += chunk;
      const match = /on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (match) resolve(match[1]);
    });
    child.on("exit", (code) => reject(new Error(`mock server exited ${code}`)));
  });
});

afterAll(() => { child?.kill(); });

describe("against the mock server", () => {
  it("signs in by code, lists recent documents, and opens each format", async () => {
    const transport = fetchTransport();
    const anonymous = createApiClient({ origin, transport });
    await anonymous.sendCode("kirby@example.com");
    await expect(anonymous.verifyCode("kirby@example.com", "000000")).rejects.toMatchObject({ status: 400 });
    const { token, user } = await anonymous.verifyCode("kirby@example.com", "123456");
    expect(user.email).toBe("kirby@example.com");

    const api = createApiClient({ origin, transport, getToken: () => token });
    expect(await api.me()).toMatchObject({ email: "kirby@example.com" });

    const recent = await api.recent({ limit: 4 });
    expect(recent).toHaveLength(4);
    expect(recent[0]).toMatchObject({ id: "agent-brief", format: "markdown", origin: { kind: "agent", agent: "Claude Code" }, privateLink: `${origin}/d/agent-brief` });
    const next = await api.recent({ limit: 4, before: recent[3].updatedAt });
    expect(next.length).toBeGreaterThan(0);
    expect(next.some((doc) => recent.some((seen) => seen.id === doc.id))).toBe(false);
    expect([...recent, ...next].some((doc) => doc.shared && doc.sharedBy === "ana@example.com")).toBe(true);

    expect(await api.doc("agent-brief")).toMatchObject({ format: "markdown", origin: { kind: "agent", agent: "Claude Code" } });
    const wd = await api.doc("counter-wd");
    expect(wd.format).toBe("darkmown");
    expect(wd.content).toContain(":button");
    expect((await api.doc("deploy-notes")).format).toBe("text");
    expect([...await api.docLinks("agent-brief")]).toEqual([["Counter.wd", "counter-wd"]]);

    await expect(api.doc("no-such-doc")).rejects.toMatchObject({ status: 404, serverMessage: "not found" });
    await expect(api.doc("someone-elses-doc")).rejects.toMatchObject({ status: 403 });

    const shared = await api.publicDoc("pub_launch_brief_demo_token");
    expect(shared).toMatchObject({ name: "Launch brief.md", format: "markdown" });

    // A picture synced beside the document, read with the session, and the
    // same picture through the document's public share, read without one.
    const report = await api.doc("reading-report");
    expect(report.content).toContain("](charts/opened-per-day.png)");
    const chart = await api.asset({ kind: "doc", id: "reading-report" }, "charts/opened-per-day.png");
    expect(chart?.type).toBe("image/png");
    expect(Array.from(new Uint8Array(await chart!.arrayBuffer()).slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect((await api.asset({ kind: "public", token: "pub_reading_report_demo_token" }, "charts/opened-per-day.png"))?.size).toBe(chart!.size);
    expect(await api.asset({ kind: "doc", id: "reading-report" }, "charts/missing.png")).toBeNull();

    // A 95 MB picture: the app asks for the first 20 MB, sees the whole is
    // bigger, and shows "not available". The mock answers a range like the
    // real server does, so the transfer is the slice and not the file.
    expect(await api.asset({ kind: "doc", id: "edge-cases" }, "charts/huge.png")).toBeNull();
    const url = `${origin}/api/docs/edge-cases/assets/file?ref=charts%2Fhuge.png`;
    const sliced = await fetch(url, { headers: { authorization: `Bearer ${token}`, range: "bytes=0-19999999" } });
    expect(sliced.status).toBe(206);
    expect(sliced.headers.get("content-range")).toBe("bytes 0-19999999/95000000");
    expect((await sliced.arrayBuffer()).byteLength).toBe(20_000_000);
    const tail = await fetch(url, { headers: { authorization: `Bearer ${token}`, range: "bytes=-10" } });
    expect(tail.headers.get("content-range")).toBe("bytes 94999990-94999999/95000000");
    expect((await fetch(url, { headers: { authorization: `Bearer ${token}`, range: "bytes=95000000-" } })).status).toBe(416);

    await api.signOut();
    await expect(api.recent()).rejects.toMatchObject({ status: 401 });
  });

  it("routes a scheme deep link to a document on the signed-in server", () => {
    const target = parseMarkieLink("markie-mobile://d/counter-wd");
    expect(target && resolveForSession(target, origin)).toEqual({ ok: true, target: { kind: "doc", id: "counter-wd", origin } });
  });
});
