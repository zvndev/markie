import type { DocAppearance } from "./doc-appearance";
import type { ReactNode } from "react";

export type FormattingAction = "undo" | "redo" | "bold" | "italic" | "underline" | "strike" | "code" | "link" | "image" | "bullet" | "ordered" | "task" | "align-left" | "align-center" | "align-right" | "clear";
export interface FormattingState {
  bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; code?: boolean;
  bullet?: boolean; ordered?: boolean; task?: boolean;
  alignLeft?: boolean; alignCenter?: boolean; alignRight?: boolean;
  canUndo?: boolean; canRedo?: boolean;
}
export interface FormattingToolbarProps {
  state: FormattingState | null;
  canEdit: boolean;
  appearance: DocAppearance;
  onAppearance(next: DocAppearance): void;
  currentStyle: string;
  styles?: readonly { id: string; label: string }[];
  currentFont: string;
  fonts?: readonly { id: string; label: string }[];
  selecting: boolean;
  currentSize: number;
  onFont(font: string): void;
  onSize(size: number): void;
  onStyle(style: string): void;
  onAction(action: FormattingAction): void;
  onColor?(color: string | null): void;
  onHighlight?(color: string | null): void;
  supportedActions?: readonly FormattingAction[];
  showWidthControls?: boolean;
  showStyleControls?: boolean;
  startControls?: ReactNode;
  serializationHint?: string;
  onPrint?: () => void;
  onHistory?: () => void;
}
