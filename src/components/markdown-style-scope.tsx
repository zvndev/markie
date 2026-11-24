// A container whose documents are drawn in one Markdown style, whatever the
// app around it is using: a preset's card in Settings, the style editor's
// preview, a pinned document on the web. The app's own stylesheet leaves
// `[data-md-style]` containers alone (markdown-style.ts MARKDOWN_STYLE_APP_SCOPE),
// so the two never mix.
//
// The stylesheet is written from a cleaned style by table lookup, so nothing
// a style holds reaches it as text.
import { useId, useMemo, type CSSProperties, type ReactNode } from "react";
import { markdownStyleContainerScope, markdownStyleCss, markdownStyleFontCss, markdownStyleFontTokens } from "@/lib/markdown-style";

export function MarkdownStyleScope({
  style,
  fonts = "all",
  className,
  containerStyle,
  children,
  ...rest
}: {
  /** Any value; it is cleaned before it is drawn. Null draws Spacious. */
  style: unknown;
  /**
   * Which of the style's typefaces the container sets for itself. "all" for a
   * preview, which shows the style's own faces. "none" where the faces are
   * painted with the theme (a pinned page), and "code" where only the text
   * faces are.
   */
  fonts?: "all" | "code" | "none";
  className?: string;
  containerStyle?: CSSProperties;
  children: ReactNode;
} & Record<`data-${string}`, string | undefined> & { "aria-hidden"?: "true" }) {
  const key = `s${useId().replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  const css = useMemo(() => {
    const scope = markdownStyleContainerScope(key);
    const rules = markdownStyleCss(style, scope);
    const faces = fonts === "none" ? "" : markdownStyleFontCss(fonts === "code" ? { choices: { codeFont: markdownStyleFontTokens(style).codeFont } } : style, scope);
    return [faces, rules].filter(Boolean).join("\n");
  }, [style, fonts, key]);
  return (
    <div {...rest} data-md-style={key} className={className} style={containerStyle}>
      {css ? <style data-markie-markdown-style-scope="">{css}</style> : null}
      {children}
    </div>
  );
}
