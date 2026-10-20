import { fireEvent, render, screen, within } from "@testing-library/react";
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

  it("shows the Markie Cloud account in the Servers list", async () => {
    await signIn();
    renderSettings({ initialSection: "advanced" });
    const cloud = await screen.findByRole("listitem", { name: "Markie Cloud" });
    expect(within(cloud).getByText("Signed in as ada@markie.app")).toBeInTheDocument();
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
      "Files",
      "Advanced",
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");

    await user.click(tabs[3]);
    expect(tabs[3]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("list", { name: "Markie servers" })).toBeInTheDocument();
  });

  it("offers early access under its early-access name and keeps the stored opt-in", async () => {
    const user = userEvent.setup();
    const bridge = installBridge();
    renderSettings({ initialSection: "advanced" });
    const toggle = await screen.findByRole("checkbox", { name: /Get new versions early/ });
    expect(
      screen.getByText(/New versions reach you first, and everyone else a few days later\./)
    ).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    // Same IPC and the same boolean as the old "Receive beta updates" switch,
    // so the setting already on disk keeps meaning what it meant.
    expect(bridge.updateChannelSet).toHaveBeenCalledWith(true);
    expect(toggle).toBeChecked();
  });

  it("opens straight into the section it was asked for", () => {
    renderSettings({ initialSection: "appearance" });
    expect(screen.getByRole("radiogroup", { name: "Style templates" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")[1]).toHaveAttribute("aria-selected", "true");
  });

  it("has no free-text server address any more", () => {
    renderSettings({ initialSection: "advanced" });
    expect(screen.queryByDisplayValue("https://api.test")).toBeNull();
    expect(screen.queryByText("Markie server URL")).toBeNull();
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
  const store = () => JSON.parse(localStorage.getItem("markie.themes.v1")!);
  // Pin the tone so the tests do not depend on the test runner's OS setting.
  beforeEach(() => localStorage.setItem("markie.colormode.v1", "dark"));

  it("lists every template and marks the active one", () => {
    renderSettings({ initialSection: "appearance" });
    const gallery = screen.getByRole("radiogroup", { name: "Style templates" });
    const cards = within(gallery).getAllByRole("radio");
    expect(cards.length).toBeGreaterThanOrEqual(8);
    expect(within(gallery).getByRole("radio", { name: "Markie" })).toHaveAttribute("aria-checked", "true");
    expect(within(gallery).getByRole("radio", { name: "Paper" })).toHaveAttribute("aria-checked", "false");
    expect(within(gallery).getByRole("radio", { name: "Paper" })).toHaveAccessibleDescription(
      /book serif/
    );
  });

  it("switches the template, paints it and persists it", async () => {
    const user = userEvent.setup();
    renderSettings({ initialSection: "appearance" });
    await user.click(screen.getByRole("radio", { name: "Paper" }));

    expect(screen.getByRole("radio", { name: "Paper" })).toHaveAttribute("aria-checked", "true");
    expect(store()).toMatchObject({ activeId: "paper-dark", templateId: "paper" });
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#1b1916");
    expect(pushCloudThemes).toHaveBeenCalled();
  });

  it("keeps the template when the color mode is changed from here", async () => {
    const user = userEvent.setup();
    const events: string[] = [];
    const onMode = (e: Event) => events.push((e as CustomEvent<{ mode: string }>).detail.mode);
    window.addEventListener("markie:color-mode-changed", onMode);
    renderSettings({ initialSection: "appearance" });
    await user.click(screen.getByRole("radio", { name: "Nord" }));
    await user.click(screen.getByRole("button", { name: "Light" }));
    window.removeEventListener("markie:color-mode-changed", onMode);

    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("markie.colormode.v1")).toBe("light");
    // Same event the toolbar listens for, so its picker follows.
    expect(events).toEqual(["light"]);
    expect(store().activeId).toBe("nord-light");
    expect(screen.getByRole("radio", { name: "Nord" })).toHaveAttribute("aria-checked", "true");
  });

  it("forks the variant being looked at into a custom preset that remembers its base", async () => {
    const user = userEvent.setup();
    renderSettings({ initialSection: "appearance" });
    expect(document.querySelector('input[type="color"]')).toBeNull();
    await user.click(screen.getByRole("button", { name: /Customize colors/ }));
    const color = document.querySelector<HTMLInputElement>('input[type="color"]')!;
    fireEvent.change(color, { target: { value: "#123456" } });

    expect(await screen.findByText(/^Custom preset: Markie Dark Copy$/)).toBeInTheDocument();
    const saved = store();
    expect(saved.custom).toHaveLength(1);
    expect(saved.custom[0]).toMatchObject({ templateId: "markie", tone: "dark" });
    expect(saved.custom[0].tokens.background).toBe("#123456");
    expect(saved.activeId).toBe(saved.custom[0].id);
    expect(saved.overrides).toEqual({ dark: saved.custom[0].id });
    expect(screen.getByRole("radio", { name: "Markie Dark Copy" })).toHaveAttribute("aria-checked", "true");
  });

  it("deletes a custom preset and falls back to the template", async () => {
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
    expect(screen.queryByRole("radio", { name: "Sunset" })).toBeNull();
    expect(store()).toEqual({
      activeId: "markie-dark",
      custom: [],
      templateId: "markie",
      overrides: {},
    });
  });

  it("has no delete for a built-in preset", () => {
    renderSettings({ initialSection: "appearance" });
    expect(screen.queryByRole("button", { name: "Delete preset" })).toBeNull();
  });

  it("shows the live typography values", () => {
    renderSettings({ initialSection: "appearance" });
    expect(screen.getByLabelText("Text size")).toHaveValue("16");
    expect(screen.getByText("16 px")).toBeInTheDocument();
    expect(screen.getByText("768 px")).toBeInTheDocument();
    expect(screen.getByText("1.75")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Body font: System" })).toBeInTheDocument();
  });

  it("applies typography app-wide and resets it to the template", async () => {
    const user = userEvent.setup();
    renderSettings({ initialSection: "appearance" });
    const reset = screen.getByRole("button", { name: "Reset to template" });
    expect(reset).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Line height"), { target: { value: "2" } });
    expect(document.documentElement.style.getPropertyValue("--doc-line-height")).toBe("2");
    expect(store().typography).toEqual({ lineHeight: 2 });

    await user.click(screen.getByRole("button", { name: "Body font: System" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Charter" }));
    expect(document.documentElement.style.getPropertyValue("--theme-font-family")).toContain("Charter");
    expect(store().typography).toEqual({ lineHeight: 2, bodyFont: "charter" });

    expect(reset).toBeEnabled();
    await user.click(reset);
    expect(store().typography).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--doc-line-height")).toBe("1.75");
  });

  it("closes a font menu on Escape without closing Settings", async () => {
    const user = userEvent.setup();
    const { onClose } = renderSettings({ initialSection: "appearance" });
    await user.click(screen.getByRole("button", { name: "Heading font: Same as body" }));
    expect(screen.getByRole("menu", { name: "Heading font" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Settings — files", () => {
  const status = (markdownDefault: boolean) => ({
    supported: true,
    formats: [
      { id: "markdown", label: "Markdown", extensions: [".md"], isDefault: markdownDefault },
      { id: "json", label: "JSON", extensions: [".json"], isDefault: false },
      { id: "yaml", label: "YAML", extensions: [".yaml", ".yml"], isDefault: false },
    ],
    pending: [{ id: "docx", label: "Word", extensions: [".docx"], reason: "Some Word features still open read-only." }],
  });

  it("offers every fully supported type and explains what is not offered yet", async () => {
    installBridge({ defaultAppsStatus: vi.fn(async () => status(true)) });
    render(<Settings onClose={() => {}} initialSection="files" />);
    expect(await screen.findByRole("button", { name: "Open JSON files in Markie" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Markdown files in Markie" })).not.toBeInTheDocument();
    expect(screen.getByText(/Some Word features still open read-only/)).toBeInTheDocument();
  });

  it("claims one type, or every remaining type at once, and refreshes", async () => {
    const setDefaultApps = vi.fn(async () => ({ ok: true }));
    const defaultAppsStatus = vi.fn(async () => status(false));
    installBridge({ defaultAppsStatus, setDefaultApps });
    const user = userEvent.setup();
    render(<Settings onClose={() => {}} initialSection="files" />);

    await user.click(await screen.findByRole("button", { name: "Open JSON files in Markie" }));
    expect(setDefaultApps).toHaveBeenLastCalledWith(["json"]);
    expect(await screen.findByText("JSON now open in Markie.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Use Markie for all" }));
    expect(setDefaultApps).toHaveBeenLastCalledWith(["markdown", "json", "yaml"]);
    expect(defaultAppsStatus).toHaveBeenCalledTimes(3);
  });

  it("shows why the switch is unavailable in a dev build", async () => {
    installBridge({ defaultAppsStatus: vi.fn(async () => ({ ...status(false), supported: false, error: "Run the installed Markie app (not the dev build) to set it as the default." })) });
    render(<Settings onClose={() => {}} initialSection="files" />);
    expect(await screen.findByText(/not the dev build/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open JSON files in Markie" })).toBeDisabled();
  });
});

describe("Settings — servers", () => {
  const SELF = {
    origin: "https://docs.example.com",
    name: "Team docs",
    isDefault: false,
    signIn: { email: true, google: false },
    version: "1.0.0",
  };
  const CLOUD = {
    origin: "https://api-production-602f.up.railway.app",
    name: "Markie Cloud",
    isDefault: true,
    signIn: { email: true, google: true },
    version: null,
  };

  it("adds a server only after showing its name and address and the user confirming", async () => {
    const user = userEvent.setup();
    const serversList = vi.fn().mockResolvedValueOnce([CLOUD]).mockResolvedValue([CLOUD, SELF]);
    const serversProbe = vi.fn(async () => ({
      ok: true as const,
      probeId: "probe-1",
      origin: SELF.origin,
      host: "docs.example.com",
      name: SELF.name,
      version: "1.0.0",
      signIn: SELF.signIn,
      alreadyAdded: false,
    }));
    const serversAdd = vi.fn(async () => ({ ok: true as const, server: SELF }));
    installBridge({ serversList, serversProbe, serversAdd } as never);
    renderSettings({ initialSection: "advanced" });

    await user.click(await screen.findByRole("button", { name: "Add a server…" }));
    await user.type(screen.getByLabelText("Server address"), "docs.example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const confirm = await screen.findByRole("group", { name: "Confirm server" });
    expect(within(confirm).getByText("Team docs")).toBeInTheDocument();
    expect(within(confirm).getByText("https://docs.example.com")).toBeInTheDocument();
    expect(serversProbe).toHaveBeenCalledWith("docs.example.com");
    // Checking is not adding.
    expect(serversAdd).not.toHaveBeenCalled();

    await user.click(within(confirm).getByRole("button", { name: "Add server" }));
    expect(serversAdd).toHaveBeenCalledWith("probe-1");
    expect(await screen.findByRole("listitem", { name: "Team docs" })).toBeInTheDocument();
  });

  it("says why a check failed and adds nothing", async () => {
    const user = userEvent.setup();
    const serversAdd = vi.fn();
    installBridge({
      serversList: vi.fn(async () => [CLOUD]),
      serversProbe: vi.fn(async () => ({ ok: false as const, error: "The address has to start with https://." })),
      serversAdd,
    } as never);
    renderSettings({ initialSection: "advanced" });

    await user.click(await screen.findByRole("button", { name: "Add a server…" }));
    await user.type(screen.getByLabelText("Server address"), "http://docs.example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("https://");
    expect(serversAdd).not.toHaveBeenCalled();
  });

  it("offers no way to remove Markie Cloud", async () => {
    installBridge({ serversList: vi.fn(async () => [CLOUD, SELF]) } as never);
    renderSettings({ initialSection: "advanced" });
    const cloud = await screen.findByRole("listitem", { name: "Markie Cloud" });
    expect(within(cloud).queryByRole("button", { name: /Remove/ })).toBeNull();
    const self = await screen.findByRole("listitem", { name: "Team docs" });
    expect(within(self).getByRole("button", { name: "Remove Team docs" })).toBeInTheDocument();
  });

  it("removes a server after asking, and forgets its sign-in", async () => {
    const user = userEvent.setup();
    localStorage.setItem("markie.token.v1@https://docs.example.com", "tok-self");
    const serversRemove = vi.fn(async () => ({ ok: true }));
    const serversList = vi.fn().mockResolvedValueOnce([CLOUD, SELF]).mockResolvedValue([CLOUD]);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ user: null }) })));
    installBridge({ serversList, serversRemove } as never);
    renderSettings({ initialSection: "advanced" });

    const self = await screen.findByRole("listitem", { name: "Team docs" });
    await user.click(within(self).getByRole("button", { name: "Remove Team docs" }));
    await user.click(within(screen.getByRole("group", { name: "Confirm removal" })).getByRole("button", { name: "Remove" }));

    expect(serversRemove).toHaveBeenCalledWith("https://docs.example.com");
    await vi.waitFor(() => expect(screen.queryByRole("listitem", { name: "Team docs" })).toBeNull());
    expect(localStorage.getItem("markie.token.v1@https://docs.example.com")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("signs in to an added server with email and password, offering Google only when it does", async () => {
    const user = userEvent.setup();
    installBridge({ serversList: vi.fn(async () => [CLOUD, SELF]) } as never);
    const fetch = vi.fn(async (url: unknown) =>
      String(url).endsWith("/api/me")
        ? { ok: true, status: 200, headers: new Headers(), json: async () => ({ user: { id: "u-self", email: "bo@example.com", name: "Bo" } }) }
        : { ok: true, status: 200, headers: new Headers({ "set-auth-token": "tok-self" }), json: async () => ({ token: "tok-self" }) }
    );
    vi.stubGlobal("fetch", fetch);
    renderSettings({ initialSection: "advanced" });

    const self = await screen.findByRole("listitem", { name: "Team docs" });
    await user.click(within(self).getByRole("button", { name: "Sign in" }));
    const form = within(self).getByRole("form", { name: "Sign in to Team docs" });
    expect(within(form).queryByRole("button", { name: "Continue with Google" })).toBeNull();
    await user.type(within(form).getByLabelText("Email"), "bo@example.com");
    await user.type(within(form).getByLabelText("Password"), "pw-123456");
    await user.click(within(form).getByRole("button", { name: "Sign in" }));

    expect(await within(self).findByText("Signed in as bo@example.com")).toBeInTheDocument();
    expect(String(fetch.mock.calls[0][0])).toBe("https://docs.example.com/api/auth/sign-in/email");
    expect(localStorage.getItem("markie.token.v1@https://docs.example.com")).toBe("tok-self");
    vi.unstubAllGlobals();
  });
});
