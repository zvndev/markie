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
}
export interface RichSnapshotOptions {
  readonly pageLayout?: Readonly<DocxPageLayout>;
  readonly diagnostics?: readonly DocxDiagnostic[];
  readonly metadata?: Readonly<Record<string, string>>;
  readonly canEdit?: boolean;
  readonly revision?: number;
  readonly modified?: boolean;
  readonly originalText?: string;
}
