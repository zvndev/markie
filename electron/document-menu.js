const commands = require("./document-menu-commands.json");

const commandIds = new Set(commands.map((command) => command.id));
const renderers = new Set(["markdown", "word", "text", "none"]);
const MARKDOWN_MENU_IDS = [
  "markdown-view-rich", "markdown-view-source", "markdown-view-split",
  "markdown-print", "markdown-export-pdf-dark", "markdown-export-pdf-light", "markdown-export-html",
  "markdown-fork", "markdown-reveal", "markdown-format-tables", "markdown-statistics",
  "markdown-page-wider", "markdown-page-narrower",
];
const ZOOM_MENU_IDS = ["markdown-zoom-in", "markdown-zoom-out"];

function validMenuState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, "renderer") || !Object.hasOwn(value, "enabledCommands")
    || !renderers.has(value.renderer) || !Array.isArray(value.enabledCommands)
    || value.enabledCommands.length > commandIds.size
    || (value.renderer === "none" && value.enabledCommands.length !== 0)) return false;
  const seen = new Set();
  for (const command of value.enabledCommands) {
    if (typeof command !== "string" || !commandIds.has(command) || seen.has(command)) return false;
    seen.add(command);
  }
  return true;
}

function createDocumentMenuController({ getWindow, getMenu, sendCommand, canUseLegacy = () => true }) {
  let renderer = "none", enabled = new Set();
  const legacyFallbacks = new Map();
  const hasWindow = () => { const window = getWindow(); return !!window && !window.isDestroyed() && !window.webContents.isDestroyed(); };
  const canExecute = (command) => hasWindow() && renderer !== "none" && commandIds.has(command) && enabled.has(command)
    && (command !== "document-history" || renderer !== "markdown" || canUseLegacy("revert-to-snapshot"));
  const isMarkdown = () => renderer === "markdown";
  const canUseMenu = (id) => hasWindow() && ((isMarkdown() && canUseLegacy(id))
    || (ZOOM_MENU_IDS.includes(id) && renderer === "word" && enabled.has("view-zoom-reset")));
  const canUseFallback = (command) => { const fallback = legacyFallbacks.get(command); return !!fallback && isMarkdown() && canUseMenu(fallback.id); };
  const refresh = () => {
    const menu = getMenu();
    if (!menu) return;
    for (const command of commands) {
      const item = menu.getMenuItemById(command.id);
      if (item) item.enabled = canExecute(command.id) || canUseFallback(command.id);
    }
    for (const id of [...MARKDOWN_MENU_IDS, ...ZOOM_MENU_IDS]) {
      const item = menu.getMenuItemById(id);
      if (item) item.enabled = canUseMenu(id);
    }
  };
  const reset = () => { renderer = "none"; enabled = new Set(); refresh(); };
  const commandItem = (command) => ({
    id: command.id,
    label: command.label,
    ...(command.accelerator ? { accelerator: command.accelerator } : {}),
    enabled: false,
    click: () => {
      if (canExecute(command.id)) sendCommand(command.id);
      else if (canUseFallback(command.id)) legacyFallbacks.get(command.id).click();
    },
  });
  return {
    isMarkdown,
    refresh,
    reset,
    update(value) {
      if (!validMenuState(value)) { reset(); return { ok: false, error: "Invalid document menu capabilities." }; }
      renderer = value.renderer; enabled = new Set(value.enabledCommands); refresh();
      return { ok: true };
    },
    install(template) {
      const wrapLegacy = (items) => {
        for (const item of items) {
          if (MARKDOWN_MENU_IDS.includes(item.id) || ZOOM_MENU_IDS.includes(item.id)) {
            const click = item.click;
            item.enabled = false;
            if (click) item.click = (...args) => { if (canUseMenu(item.id)) click(...args); };
          }
          if (Array.isArray(item.submenu)) wrapLegacy(item.submenu);
        }
      };
      wrapLegacy(template);
      const file = template.find((item) => item.label === "File");
      const view = template.find((item) => item.label === "View");
      const merged = new Set();
      for (const [parent, legacyId, commandId] of [[view, "markdown-zoom-reset", "view-zoom-reset"], [file, "revert-to-snapshot", "document-history"]]) {
        const index = parent.submenu.findIndex((item) => item.id === legacyId);
        const command = commands.find((entry) => entry.id === commandId);
        if (index === -1 || !command) continue;
        const original = parent.submenu[index]; legacyFallbacks.set(commandId, { id: legacyId, click: original.click });
        parent.submenu[index] = { ...commandItem(command), ...(original.accelerator ? { accelerator: original.accelerator } : {}) };
        merged.add(commandId);
      }
      const fileCommands = commands.filter((command) => command.group === "File" && !merged.has(command.id)).map(commandItem);
      const lastFileSeparator = file.submenu.findLastIndex((item) => item.type === "separator");
      file.submenu.splice(lastFileSeparator === -1 ? file.submenu.length : lastFileSeparator, 0, { type: "separator" }, ...fileCommands);
      const groups = ["Format", "Insert", "Layout", "Review"].map((label) => ({ label, submenu: commands.filter((command) => command.group === label).map(commandItem) }));
      template.splice(template.indexOf(view), 0, ...groups);
      view.submenu.push({ type: "separator" }, ...commands.filter((command) => command.group === "View" && !merged.has(command.id)).map(commandItem));
      return template;
    },
  };
}

module.exports = { createDocumentMenuController, validMenuState, MARKDOWN_MENU_IDS, ZOOM_MENU_IDS };
