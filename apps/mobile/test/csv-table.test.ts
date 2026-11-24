// @vitest-environment jsdom
// A CSV or TSV on the phone's reading screens is the shared table, read-only,
// and never the wall of commas a <pre> made of it.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LocalDocScreen } from "../src/screens/local-doc";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function open(name: string, content: string) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(LocalDocScreen, {
    docKey: `local:${name}`, name, format: "text", content, note: "On this phone.", tone: "light",
    back: { label: "Files", onBack: () => {} }, onEdit: null, cloud: null, onSignIn: null,
  })));
  return host;
}

describe("a CSV on the reading screen", () => {
  it("is drawn as a read-only table that fills the screen", () => {
    const screen = open("prices.csv", "item,price\nTea,3.50\nCoffee,4.25\n");
    const grid = screen.querySelector("[role=grid]")!;
    expect(grid.getAttribute("aria-readonly")).toBe("true");
    expect(Array.from(grid.querySelectorAll("[role=columnheader]")).map((h) => h.textContent)).toEqual(["item", "price"]);
    expect(Array.from(grid.querySelectorAll("[role=gridcell]")).map((c) => c.textContent)).toEqual(["Tea", "3.50", "Coffee", "4.25"]);
    expect(screen.querySelector(".csv-table--compact")).not.toBeNull();
    expect(screen.querySelector(".m-text-doc")).toBeNull();
    expect(screen.querySelector(".m-screen-body.is-fill")).not.toBeNull();
    // No way to edit from here: no row or column buttons.
    expect(Array.from(screen.querySelectorAll("button")).some((b) => /Row|Column/.test(b.textContent ?? ""))).toBe(false);
  });

  it("reads a .tsv by its tabs", () => {
    const screen = open("data.tsv", "name\tnote\nTea\thot, black\n");
    expect(Array.from(screen.querySelectorAll("[role=gridcell]")).map((c) => c.textContent)).toEqual(["Tea", "hot, black"]);
  });

  it("leaves other text files as text", () => {
    const screen = open("notes.txt", "a,b\n1,2\n");
    expect(screen.querySelector("[role=grid]")).toBeNull();
    expect(screen.querySelector(".m-text-doc")?.textContent).toBe("a,b\n1,2\n");
  });
});
