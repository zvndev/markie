export { DARKMOWN_MAX_COMPUTED_GROWTH, DARKMOWN_OUTPUT_LIMIT, DARKMOWN_SOURCE_LIMIT, validateDarkmownPreviewSource } from "../../../mcp/darkmown-limits.mjs";

export interface CompiledDarkmownDocument {
  /** Unsanitized compiler output. It must not be inserted into Markie's DOM. */
  bodyHtml: string;
  title: string;
  warnings: readonly string[];
  requiresRuntime: boolean;
  hasCode: boolean;
}
