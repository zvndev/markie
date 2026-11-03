import type { DocxDiagnostic, DocxDocument, DocxPageLayout, DocxRunStyle } from "./docx-types";

/** A shared editor projection, not a DOCX package or a conversion. Each codec owns its source. */
export interface NativeRichDocument extends Omit<DocxDocument, "format"> { readonly format: "rtf" | "odt" }
export type RichDocument = DocxDocument | NativeRichDocument;
export interface RichRunInput { readonly text: string; readonly style?: Readonly<DocxRunStyle> }
export interface RichParagraphInput {
  readonly runs: readonly RichRunInput[];
  readonly alignment?: string;
  readonly spacingBeforePoints?: number;
  readonly spacingAfterPoints?: number;
  readonly lineSpacingMultiple?: number;
  /** Display-only list markers; a codec that sets them must open read-only. */
  readonly listKind?: "bullet" | "numbered";
  readonly listLevel?: number;
  readonly listNumber?: number;
}
/** Document order of top-level paragraphs and tables, by input paragraph index.
 * Every paragraph appears exactly once, either alone or inside one table cell. */
export type RichBlockInput =
  | { readonly kind: "paragraph"; readonly index: number }
  | { readonly kind: "table"; readonly rows: readonly (readonly (readonly number[])[])[] };
export interface RichSnapshotOptions {
  /** Tables are display-only in the shared model: a snapshot with any table must be read-only. */
  readonly blocks?: readonly RichBlockInput[];
  readonly pageLayout?: Readonly<DocxPageLayout>;
  readonly diagnostics?: readonly DocxDiagnostic[];
  readonly metadata?: Readonly<Record<string, string>>;
  readonly canEdit?: boolean;
  readonly revision?: number;
  readonly modified?: boolean;
  readonly originalText?: string;
}
