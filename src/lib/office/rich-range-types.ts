/** Session-local logical selection. Offsets are UTF-16 grapheme boundaries. */
export interface RichTextPosition { readonly paragraphId: string; readonly offset: number }
export interface RichTextRange { readonly anchor: RichTextPosition; readonly focus: RichTextPosition }
export interface RichRangeResult<T> { readonly document: T; readonly selection: RichTextRange }
