import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RichLossBanner } from "@/components/rich-guard";

describe("RichLossBanner", () => {
  it("names the constructs and offers both exits", async () => {
    const onEditSource = vi.fn();
    const onOverride = vi.fn();
    render(
      <RichLossBanner
        risks={["reference-links", "footnotes"]}
        onEditSource={onEditSource}
        onOverride={onOverride}
      />
    );
    expect(screen.getByRole("status").textContent).toMatch(/reference/i);
    await userEvent.click(screen.getByRole("button", { name: /edit in source/i }));
    expect(onEditSource).toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: /edit rich anyway/i })
    );
    expect(onOverride).toHaveBeenCalled();
  });

  it("still says something useful when no construct was named", () => {
    render(
      <RichLossBanner risks={[]} onEditSource={vi.fn()} onOverride={vi.fn()} />
    );
    expect(screen.getByRole("status").textContent).toMatch(/rich editing is off/i);
  });
});
