// A container whose documents are drawn in one Markdown style, whatever the
// app around it is using: a preset's card in Settings, the style editor's
// preview, a pinned document on the web. The app's own stylesheet leaves
// `[data-md-style]` containers alone (markdown-style.ts MARKDOWN_STYLE_APP_SCOPE),
// so the two never mix.
//
// The stylesheet is written from a cleaned style by table lookup, so nothing
// a style holds reaches it as text.
import { useId, useMemo, type CSSProperties, type ReactNode } from "react";
import { markdownStyleContainerScope, markdownStyleCss } from "@/lib/markdown-style";

export function MarkdownStyleScope({
  style,
  className,
  containerStyle,
  children,
  ...rest
}: {
  /** Any value; it is cleaned before it is drawn. Null draws Spacious. */
  style: unknown;
  className?: string;
  containerStyle?: CSSProperties;
  children: ReactNode;
} & Record<`data-${string}`, string | undefined> & { "aria-hidden"?: "true" }) {
  const key = `s${useId().replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  const css = useMemo(() => markdownStyleCss(style, markdownStyleContainerScope(key)), [style, key]);
  return (
    <div {...rest} data-md-style={key} className={className} style={containerStyle}>
      {css ? <style data-markie-markdown-style-scope="">{css}</style> : null}
      {children}
    </div>
  );
}
