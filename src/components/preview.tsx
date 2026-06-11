"use client";

import { forwardRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";

interface PreviewProps {
  content: string;
}

export const Preview = forwardRef<HTMLElement, PreviewProps>(
  function Preview({ content }, ref) {
    if (!content.trim()) {
      return (
        <div className="h-full flex items-center justify-center text-muted">
          <div className="text-center">
            <div className="text-4xl mb-3 opacity-30">◇</div>
            <p className="text-sm">Start typing or open a file</p>
          </div>
        </div>
      );
    }

    return (
      <div className="h-full overflow-y-auto px-10 py-8">
        <article ref={ref} className="markdown-body max-w-3xl mx-auto">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeHighlight, rehypeKatex]}
          >
            {content}
          </ReactMarkdown>
        </article>
      </div>
    );
  }
);
