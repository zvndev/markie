export interface DocStats {
  words: number;
  chars: number;
  charsNoSpaces: number;
  lines: number;
  headings: number;
  codeBlocks: number;
  links: number;
  readingTimeMin: number;
}

export function computeStats(content: string): DocStats {
  const trimmed = content.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  return {
    words,
    chars: content.length,
    charsNoSpaces: content.replace(/\s/g, "").length,
    lines: content === "" ? 0 : content.split("\n").length,
    headings: (content.match(/^#{1,6}\s/gm) ?? []).length,
    codeBlocks: Math.floor((content.match(/^```/gm) ?? []).length / 2),
    links: (content.match(/\[[^\]]*\]\([^)]+\)/g) ?? []).length,
    readingTimeMin: words === 0 ? 0 : Math.max(1, Math.round(words / 200)),
  };
}
