// An email address or a dotted name, with the places a reader would break it
// marked: before the @ and after each dot. A narrow column then wraps
// "sam.okonkwo@northwind.example.com" at those points, not "...example.co / m".
// The text itself is unchanged, so copying it or reading it aloud is too.
import type { ReactNode } from "react";

export function Breakable({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let start = 0;
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "@") {
      parts.push(text.slice(start, i), <wbr key={i} />);
      start = i;
    } else if (text[i] === "." && i + 1 < text.length) {
      parts.push(text.slice(start, i + 1), <wbr key={i} />);
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return <>{parts}</>;
}
