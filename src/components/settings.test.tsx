import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installBridge } from "@/test/mock-bridge";

const me = vi.fn();
const signInEmail = vi.fn();
const signUpEmail = vi.fn();
const sendOTP = vi.fn();
const verifyOTP = vi.fn();
const signOut = vi.fn();
const googleSignInURL = vi.fn();
const setServerURL = vi.fn();
const setSyncEnabled = vi.fn();

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    me: () => me(),
    signInEmail: (...a: unknown[]) => signInEmail(...a),
    signUpEmail: (...a: unknown[]) => signUpEmail(...a),
    sendOTP: (...a: unknown[]) => sendOTP(...a),
    verifyOTP: (...a: unknown[]) => verifyOTP(...a),
    signOut: () => signOut(),
    googleSignInURL: () => googleSignInURL(),
  },
  getServerURL: () => "https://api.test",
  setServerURL: (...a: unknown[]) => setServerURL(...a),
  getSyncEnabled: () => true,
  setSyncEnabled: (...a: unknown[]) => setSyncEnabled(...a),
}));

const pushCloudThemes = vi.fn();
vi.mock("@/lib/theme-sync", () => ({ pushCloudThemes: () => pushCloudThemes() }));

import { Settings } from "./settings";
import { authStore } from "@/lib/auth-store";

const ok = { ok: true, status: 200 };

function renderSettings(props: Partial<React.ComponentProps<typeof Settings>> = {}) {
  const onClose = vi.fn();
  const view = render(<Settings onClose={onClose} {...props} />);
  return { ...view, onClose };
}

beforeEach(async () => {
  localStorage.clear();
  installBridge();
  me.mockResolvedValue(null);
  // The auth store is a module singleton; reset it to signed-out so no test
  // inherits the previous test's session.
  await authStore.refresh();
  signInEmail.mockResolvedValue(ok);
  signUpEmail.mockResolvedValue(ok);
  sendOTP.mockResolvedValue(ok);
  verifyOTP.mockResolvedValue(ok);
  signOut.mockResolvedValue(undefined);
  googleSignInURL.mockReturnValue("https://accounts.google/auth?state=n");
});

describe("Settings — account", () => {
  const signIn = async () => {
    me.mockResolvedValue({ id: "u1", name: "Ada Lovelace", email: "ada@markie.app" });
    await authStore.refresh();
  };

  it("offers the sign-in form when signed out", async () => {
    renderSettings();
    expect(await screen.findByText("Sign in to Markie")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Settings" })).toHaveAttribute(
      "aria-modal",
      "true"
    );
    // The extracted form leads with the smoothest desktop path.
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
  });

  it("shows the account and signs out", async () => {
    const user = userEvent.setup();
    await signIn();
    renderSettings();

    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    me.mockResolvedValue(null);
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalled();
    expect(await screen.findByText("Sign in to Markie")).toBeInTheDocument();
  });

  it("toggles cloud sync", async () => {
    const user = userEvent.setup();
    await signIn();
    renderSettings();

    const toggle = await screen.findByRole("checkbox");
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(setSyncEnabled).toHaveBeenCalledWith(false);
    expect(toggle).not.toBeChecked();
  });

  it("re-probes the session when the server URL changes", async () => {
    const user = userEvent.setup();
    renderSettings({ initialSection: "advanced" });
    const field = await screen.findByDisplayValue("https://api.test");

    me.mockClear();
    await user.clear(field);
    await user.type(field, "https://other.test");
    await user.tab(); // blur commits the URL and re-probes the session
    expect(setServerURL).toHaveBeenCalledWith("https://other.test");
    await vi.waitFor(() => expect(me).toHaveBeenCalled());
  });
});

describe("Settings — sections", () => {
  it("exposes the sections as tabs and switches between them", async () => {
    const user = userEvent.setup();
    renderSettings();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Account",
      "Appearance",
      "Advanced",
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");

    await user.click(tabs[2]);
    expect(tabs[2]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByDisplayValue("https://api.test")).toBeInTheDocument();
  });

  it("opens straight into the section it was asked for", () => {
    renderSettings({ initialSection: "appearance" });
    expect(screen.getByText("Theme")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")[1]).toHaveAttribute("aria-selected", "true");
  });

  it("saves a new server URL on blur", async () => {
    const user = userEvent.setup();
    renderSettings({ initialSection: "advanced" });
    const field = screen.getByDisplayValue("https://api.test");
    await user.clear(field);
    await user.type(field, "https://self.hosted");
    await user.tab();
    expect(setServerURL).toHaveBeenCalledWith("https://self.hosted");
  });

  it("closes on Escape, the × button, and the scrim", async () => {
    const user = userEvent.setup();
    const { container, onClose } = renderSettings();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    await user.click(container.firstElementChild as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe("Settings — appearance", () => {
  it("lists the built-in presets and marks the active one", () => {
    renderSettings({ initialSection: "appearance" });
    const dark = screen.getByRole("button", { name: "Markie Dark" });
    const light = screen.getByRole("button", { name: "Markie Light" });
    expect(dark.classList.contains("bg-accent")).toBe(true);
    expect(light.classList.contains("bg-accent")).toBe(false);
    expect(
      screen.getByText("Editing a built-in theme saves it as a copy.")
    ).toBeInTheDocument();
  });

  it("switches the active preset and persists it", async () => {
    const user = userEvent.setup();
    renderSettings({ initialSection: "appearance" });
    await user.click(screen.getByRole("button", { name: "Markie Light" }));

    expect(
      screen.getByRole("button", { name: "Markie Light" }).classList.contains("bg-accent")
    ).toBe(true);
    expect(JSON.parse(localStorage.getItem("markie.themes.v1")!).activeId).toBe(
      "markie-light"
    );
    expect(pushCloudThemes).toHaveBeenCalled();
  });

  it("forks a built-in theme into a custom preset when it is edited", async () => {
    renderSettings({ initialSection: "appearance" });
    const { fireEvent } = await import("@testing-library/react");
    const color = document.querySelector<HTMLInputElement>('input[type="color"]')!;
    fireEvent.change(color, { target: { value: "#123456" } });

    expect(await screen.findByText(/^Custom preset: Markie Dark Copy$/)).toBeInTheDocument();
    const store = JSON.parse(localStorage.getItem("markie.themes.v1")!);
    expect(store.custom).toHaveLength(1);
    expect(store.custom[0].tokens.background).toBe("#123456");
    expect(store.activeId).toBe(store.custom[0].id);
  });

  it("deletes a custom preset and falls back to Markie Dark", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      "markie.themes.v1",
      JSON.stringify({
        activeId: "custom-1",
        custom: [
          {
            id: "custom-1",
            name: "Sunset",
            tokens: {
              background: "#101010",
              surface: "#202020",
              foreground: "#eeeeee",
              muted: "#888888",
              border: "#333333",
              accent: "#ff8800",
              link: "#66aaff",
              fontSize: 16,
              contentWidth: 768,
            },
          },
        ],
      })
    );
    renderSettings({ initialSection: "appearance" });
    expect(screen.getByText("Custom preset: Sunset")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete preset" }));
    expect(screen.queryByRole("button", { name: "Sunset" })).toBeNull();
    expect(JSON.parse(localStorage.getItem("markie.themes.v1")!)).toEqual({
      activeId: "markie-dark",
      custom: [],
    });
  });

  it("has no delete for a built-in preset", () => {
    renderSettings({ initialSection: "appearance" });
    expect(screen.queryByRole("button", { name: "Delete preset" })).toBeNull();
  });

  it("shows the live font size and content width", () => {
    renderSettings({ initialSection: "appearance" });
    expect(screen.getByText(/Font size — \d+px/)).toBeInTheDocument();
    expect(screen.getByText(/Content width — \d+px/)).toBeInTheDocument();
  });
});
