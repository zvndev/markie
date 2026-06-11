import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";

// Same plugin chain the in-app preview historically used (react-markdown),
// as a pure function so exports don't depend on any mounted DOM.
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype)
  .use(rehypeHighlight)
  .use(rehypeKatex)
  .use(rehypeStringify);

export function renderMarkdownHTML(markdown: string): string {
  return String(processor.processSync(markdown));
}
