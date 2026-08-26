export declare const CACHED_SEGMENTS: string[];
export declare function isCachedAgentPath(path: string): boolean;
export declare function classifyAgentFile(
  path: string,
  name: string
): "claude" | "openai" | "gemini" | "cursor" | null;
