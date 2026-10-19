export interface DocxDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: "info" | "warning";
  readonly part?: string;
}

export interface DocxRunStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: string;
  readonly color?: string;
  readonly fontFamily?: string;
  readonly fontSizePoints?: number;
}

export type DocxRunFormat = { readonly [K in keyof DocxRunStyle]?: DocxRunStyle[K] | null };

export interface DocxRun {
  /** Opaque identity preserved across edits in this session; reopen starts a new session. */
  readonly id: string;
  readonly text: string;
  readonly style: Readonly<DocxRunStyle>;
  /** Supported display properties resolved from defaults/named styles. Never serialized as direct formatting. */
  readonly resolvedStyle?: Readonly<DocxRunStyle>;
  readonly canEdit: boolean;
  readonly hyperlinkId?: string;
  readonly target?: string;
  readonly pageBreaks: readonly { readonly id: string; readonly offset: number }[];
}

export interface DocxParagraph {
  readonly id: string;
  readonly text: string;
  readonly styleId?: string;
  readonly alignment?: string;
  readonly spacingBeforePoints?: number;
  readonly spacingAfterPoints?: number;
  readonly lineSpacingMultiple?: number;
  readonly listKind?: "bullet" | "numbered";
  readonly listLevel?: number;
  readonly listNumber?: number;
  readonly runs: readonly DocxRun[];
  readonly originalText?: string;
  readonly originalRuns?: readonly DocxRun[];
  readonly revisionIds: readonly string[];
}

export interface DocxPageLayout {
  readonly widthPoints: number;
  readonly heightPoints: number;
  readonly orientation: "portrait" | "landscape";
  readonly marginTopPoints: number;
  readonly marginRightPoints: number;
  readonly marginBottomPoints: number;
  readonly marginLeftPoints: number;
}

export interface DocxTableCell { readonly paragraphs: readonly DocxParagraph[] }
export interface DocxTableRow { readonly cells: readonly DocxTableCell[] }
export interface DocxTable {
  readonly id: string;
  readonly rows: readonly DocxTableRow[];
}
export interface DocxComment {
  readonly id: string;
  readonly paragraphId: string;
  readonly text: string;
  readonly author: string;
  readonly date?: string;
}
export interface DocxNamedStyle { readonly id: string; readonly name: string }

export interface DocxDocument {
  readonly format: "docx";
  readonly text: string;
  readonly originalText?: string;
  readonly revisions: readonly DocxRevision[];
  readonly paragraphs: readonly DocxParagraph[];
  readonly tables: readonly DocxTable[];
  readonly blocks: readonly ({ readonly kind: "paragraph"; readonly paragraphId: string } | { readonly kind: "table"; readonly tableId: string })[];
  readonly pageLayout: Readonly<DocxPageLayout>;
  readonly comments: readonly DocxComment[];
  readonly styles: readonly DocxNamedStyle[];
  readonly images: readonly DocxMediaInfo[];
  readonly hyperlinks: readonly DocxHyperlink[];
  readonly pageBreaks: readonly DocxPageBreak[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly diagnostics: readonly DocxDiagnostic[];
  readonly canEdit: boolean;
  readonly revision: number;
  readonly modified: boolean;
}

export interface DocxTextEdit { readonly runId: string; readonly text: string }

export interface DocxParagraphFormat {
  readonly styleId?: string | null;
  readonly alignment?: "left" | "center" | "right" | "both" | null;
  readonly spacingBeforePoints?: number | null;
  readonly spacingAfterPoints?: number | null;
  readonly lineSpacingMultiple?: number | null;
}

export interface DocxPageLayoutChange {
  readonly paper?: "letter" | "a4" | "legal";
  readonly orientation?: "portrait" | "landscape";
  readonly marginTopPoints?: number;
  readonly marginRightPoints?: number;
  readonly marginBottomPoints?: number;
  readonly marginLeftPoints?: number;
}

export type DocxOperation =
  | { readonly type: "format-run"; readonly runId: string; readonly style: DocxRunFormat }
  | { readonly type: "format-range"; readonly paragraphId: string; readonly start: number; readonly end: number; readonly style: DocxRunFormat }
  | { readonly type: "replace-paragraph"; readonly paragraphId: string; readonly text: string }
  | { readonly type: "insert-paragraph"; readonly afterParagraphId?: string | null; readonly text: string }
  | { readonly type: "delete-paragraph"; readonly paragraphId: string }
  | { readonly type: "format-paragraph"; readonly paragraphId: string; readonly format: DocxParagraphFormat }
  | { readonly type: "set-page-layout"; readonly layout: DocxPageLayoutChange }
  | { readonly type: "insert-table"; readonly afterParagraphId?: string | null; readonly rows: number; readonly columns: number; readonly cells?: readonly (readonly string[])[] }
  | { readonly type: "delete-table"; readonly tableId: string }
  | { readonly type: "set-list"; readonly paragraphId: string; readonly kind: "bullet" | "numbered" | null }
  | ({ readonly type: "insert-image" } & DocxImageInput)
  | { readonly type: "delete-image"; readonly imageId: string }
  | { readonly type: "set-hyperlink"; readonly paragraphId: string; readonly start: number; readonly end: number; readonly target: string }
  | { readonly type: "update-hyperlink"; readonly hyperlinkId: string; readonly target: string }
  | { readonly type: "remove-hyperlink"; readonly hyperlinkId: string }
  | { readonly type: "insert-page-break"; readonly paragraphId: string; readonly offset: number }
  | { readonly type: "remove-page-break"; readonly pageBreakId: string }
  | DocxRevisionOperation
  | DocxReviewOperation;
export interface DocxHyperlink { readonly id: string; readonly paragraphId: string; readonly text: string; readonly target: string; readonly runIds: readonly string[] }
export interface DocxPageBreak { readonly id: string; readonly paragraphId: string; readonly runId: string; readonly offset: number }
export interface DocxRevision {
  readonly id: string;
  readonly paragraphId: string;
  readonly type: "insertion" | "deletion";
  readonly author: string;
  readonly date: string;
  readonly text: string;
}
export type DocxRevisionOperation =
  | { readonly type: "track-paragraph-text"; readonly paragraphId: string; readonly text: string; readonly author: string }
  | { readonly type: "accept-revision"; readonly revisionId: string }
  | { readonly type: "reject-revision"; readonly revisionId: string }
  | { readonly type: "accept-all-revisions" }
  | { readonly type: "reject-all-revisions" };
export type DocxReviewOperation =
  | { readonly type: "add-comment"; readonly paragraphId: string; readonly text: string; readonly author: string }
  | { readonly type: "delete-comment"; readonly commentId: string };

export class DocxError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "DocxError";
  }
}
import type { DocxImageInput, DocxMediaInfo } from "./docx-media";
export type { DocxImageInput, DocxMediaInfo } from "./docx-media";

