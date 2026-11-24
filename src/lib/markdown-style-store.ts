// The account's Markdown styles, where the app keeps them: inside the theme
// store (theme.ts), so they sync with the account by the path themes already
// use (theme-sync.ts). markdown-style.ts holds the pure transitions; this is
// the part that reads storage, saves, and paints.
import { loadThemeStore, saveThemeStore } from "./theme";
import {
  activeMarkdownStyle,
  applyMarkdownStyle,
  chooseMarkdownStyle,
  markdownStyleStoreOf,
  type MarkdownStyleStore,
} from "./markdown-style";

export const MARKDOWN_STYLE_STORE_EVENT = "markie:markdown-style-store-changed";

export function loadMarkdownStyleStore(): MarkdownStyleStore {
  return markdownStyleStoreOf(loadThemeStore());
}

/** Save the style store into the theme store and paint the style it names. Returns it cleaned. */
export function commitMarkdownStyleStore(next: MarkdownStyleStore): MarkdownStyleStore {
  const clean = markdownStyleStoreOf({ markdownStyle: next });
  saveThemeStore({ ...loadThemeStore(), markdownStyle: clean });
  applyMarkdownStyle(activeMarkdownStyle(clean));
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MARKDOWN_STYLE_STORE_EVENT, { detail: { store: clean } }));
  return clean;
}

/** Switch to a preset or a saved profile by id. */
export function applyMarkdownStyleChoice(id: string): MarkdownStyleStore {
  return commitMarkdownStyleStore(chooseMarkdownStyle(loadMarkdownStyleStore(), id));
}
