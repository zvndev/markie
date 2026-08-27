import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearReconstructionCache } from "@/lib/rich-safety";
import { PREPARING_NOTE_BYTES, useRichSafety } from "@/lib/use-rich-safety";

const GATED = "See [the docs][ref].\n\nUnrelated paragraph.\n\n[ref]: https://example.com\n";
const CLEAN = "Wrapped\nprose.[^1]\n\n[^1]: the note\n";

beforeEach(() => {
  localStorage.clear();
  clearReconstructionCache();
});

describe("useRichSafety", () => {
  it("holds rich unarmed but unblocked while the verdict is unknown", async () => {
    const { result } = renderHook(() => useRichSafety());
    act(() => result.current.assess(CLEAN, "/n/a.md"));
    // Neither editable nor accused of anything: this state must not look like
    // an error, so no banner and no risks.
    expect(result.current.armed).toBe(false);
    expect(result.current.blocked).toBe(false);
    expect(result.current.risks).toBeNull();
    await waitFor(() => expect(result.current.armed).toBe(true));
    expect(result.current.blocked).toBe(false);
  });

  it("blocks and names the risks for a document the pipeline cannot rebuild", async () => {
    const { result } = renderHook(() => useRichSafety());
    act(() => result.current.assess(GATED, "/n/refs.md"));
    await waitFor(() => expect(result.current.blocked).toBe(true));
    expect(result.current.armed).toBe(false);
    expect(result.current.risks).toContain("reference-links");
  });

  it("answers from the remembered verdict with no unarmed gap at all", async () => {
    const first = renderHook(() => useRichSafety());
    act(() => first.result.current.assess(CLEAN, "/n/a.md"));
    await waitFor(() => expect(first.result.current.armed).toBe(true));

    const second = renderHook(() => useRichSafety());
    act(() => second.result.current.assess(CLEAN, "/n/a.md"));
    // No await: reopening a document must arm in the same tick.
    expect(second.result.current.armed).toBe(true);
  });

  it("an override arms a blocked document and is remembered per path", async () => {
    const { result } = renderHook(() => useRichSafety());
    act(() => result.current.assess(GATED, "/n/refs.md"));
    await waitFor(() => expect(result.current.blocked).toBe(true));
    act(() => result.current.override());
    expect(result.current.blocked).toBe(false);
    expect(result.current.armed).toBe(true);

    const reopened = renderHook(() => useRichSafety());
    act(() => reopened.result.current.assess(GATED, "/n/refs.md"));
    expect(reopened.result.current.blocked).toBe(false);
    // A different document does not inherit the consent.
    act(() => reopened.result.current.assess(GATED, "/n/other.md"));
    await waitFor(() => expect(reopened.result.current.blocked).toBe(true));
  });

  it("only offers to explain the wait for a document big enough to stall", async () => {
    const { result } = renderHook(() => useRichSafety());
    act(() => result.current.assess(CLEAN, "/n/a.md"));
    expect(result.current.preparing).toBe(false);
    await waitFor(() => expect(result.current.armed).toBe(true));

    const paragraph = "This paragraph was wrapped\nby hand at eighty columns.\n\n";
    const big = paragraph.repeat(Math.ceil(PREPARING_NOTE_BYTES / paragraph.length) + 1);
    expect(big.length).toBeGreaterThan(PREPARING_NOTE_BYTES);
    act(() => result.current.assess(big, "/n/big.md"));
    expect(result.current.preparing).toBe(true);
    await waitFor(() => expect(result.current.preparing).toBe(false), { timeout: 20_000 });
  }, 30_000);
});
