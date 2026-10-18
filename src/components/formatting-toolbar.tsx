import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { controlTitle } from "@/lib/toolbar-shortcuts";
import { DOC_FONTS, stepWidth, stepZoom, widthLabel, zoomLabel } from "@/lib/doc-appearance";
import type { FormattingAction, FormattingToolbarProps } from "@/lib/format-controls";

// The same small palette is shared by the document renderers.
const TEXT_COLOURS = [
  { label: "Default", value: null },
  { label: "Grey", value: "#6b7280" },
  { label: "Red", value: "#dc2626" },
  { label: "Orange", value: "#ea580c" },
  { label: "Green", value: "#16a34a" },
  { label: "Blue", value: "#2563eb" },
  { label: "Purple", value: "#7c3aed" },
];

const HIGHLIGHTS = [
  { label: "None", value: null },
  { label: "Yellow", value: "#fef08a" },
  { label: "Green", value: "#bbf7d0" },
  { label: "Blue", value: "#bfdbfe" },
  { label: "Pink", value: "#fbcfe8" },
  { label: "Orange", value: "#fed7aa" },
];

const Icon = ({
  children,
  strokeWidth = 1.8,
}: {
  children: ReactNode;
  strokeWidth?: number;
}) => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

function Divider() {
  return <span aria-hidden="true" className="w-px h-5 bg-border mx-1 shrink-0" />;
}

/** Move the real controls, rather than maintaining a second set of commands. */
function OverflowTools({ compact, target, children }: { compact: boolean; target: HTMLElement | null; children: ReactNode }) {
  if (!compact) return children;
  return target ? createPortal(<div className="flex flex-wrap items-center gap-1 border-b border-border p-1 last:border-0 [&_button]:gap-2 [&_button]:text-[11px] [&_button]:after:content-[attr(aria-label)] [&_select]:min-w-[90px]">{children}</div>, target) : null;
}

function TButton({
  onClick,
  title,
  active,
  disabled,
  label,
  children,
}: {
  onClick?: () => void;
  title: string;
  active?: boolean | "mixed";
  disabled?: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      aria-pressed={active}
      className={`h-7 min-w-7 px-1.5 rounded flex items-center justify-center shrink-0 transition-colors ${
        active === true
          ? "bg-accent text-foreground"
          : "text-muted hover:text-foreground hover:bg-accent/40"
      } disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted`}
    >
      {children}
    </button>
  );
}

const BLOCK_STYLES = [
  { id: "paragraph", label: "Normal text" },
  { id: "h1", label: "Heading 1" },
  { id: "h2", label: "Heading 2" },
  { id: "h3", label: "Heading 3" },
  { id: "quote", label: "Quote" },
  { id: "code", label: "Code block" },
] as const;

export function FormattingToolbar({
  state, canEdit, appearance, onAppearance, currentStyle, styles = BLOCK_STYLES,
  currentFont, fonts = DOC_FONTS, selecting, currentSize, onFont, onSize, onStyle,
  onAction, onColor, onHighlight, supportedActions, showWidthControls = true, fontPlaceholder = "Font…", sizePlaceholder,
  showStyleControls = true, startControls, serializationHint, onPrint, onHistory,
}: FormattingToolbarProps) {
  const root = useRef<HTMLDivElement>(null), more = useRef<HTMLButtonElement>(null), leading = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0), [overflowOpen, setOverflowOpen] = useState(false);
  const [leadingWidth, setLeadingWidth] = useState(0);
  const hasStartControls = Boolean(startControls);
  const [overflowTarget, setOverflowTarget] = useState<HTMLDivElement | null>(null);
  const overflowId = useId();
  const supports = (action: FormattingAction) => supportedActions === undefined || supportedActions.includes(action);
  const hasActions = (...actions: FormattingAction[]) => actions.some(supports);
  const actionWidth = (...actions: FormattingAction[]) => actions.filter(supports).length * 30;
  // Bounds include each fixed-width control and its 2px row gap. Reserve the
  // real More button before fitting groups, rather than hiding everything at
  // a viewport breakpoint. Unsupported renderer actions consume no space.
  const groups = [
    ["selectors", (showStyleControls ? 114 : 0) + 106],
    ["colour", (onColor ? 40 : 0) + (onHighlight ? 42 : 0)],
    ["lists", actionWidth("bullet", "ordered")],
    ["alignment", actionWidth("align-left", "align-center", "align-right")],
    ["history", actionWidth("undo", "redo")],
    ["marks", actionWidth("strike", "code")],
    ["insert", actionWidth("link", "image")],
    ["task", actionWidth("task")],
    ["clear", actionWidth("clear")],
    ["size", 60],
    ["output", (onPrint ? 30 : 0) + (onHistory ? 30 : 0)],
    ["view", 100 + (showWidthControls ? 114 : 0)],
  ] as const;
  const primaryWidth = 40 + actionWidth("bold", "italic", "underline");
  // The expanded row also has 140px selectors and six visual dividers.
  const reservedStart = hasStartControls ? leadingWidth + 2 : 0;
  const fullWidth = 16 + reservedStart + primaryWidth + groups.reduce((sum, [, size]) => sum + size, 0) + (showStyleControls ? 64 : 36) + 60;
  const compact = width > 0 && width < fullWidth;
  const primaryInOverflow = compact && width - 16 - reservedStart - 30 < primaryWidth;
  let available = width - 16 - reservedStart - (primaryInOverflow ? 0 : primaryWidth) - 30;
  const overflow = new Set<string>();
  if (compact) for (const [group, size] of groups) {
    if (size <= available) available -= size;
    else overflow.add(group);
  }
  const overflows = (group: string) => overflow.has(group);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const start = leading.current;
    const measure = () => { setWidth(node.getBoundingClientRect().width); setLeadingWidth(start?.getBoundingClientRect().width ?? 0); };
    measure();
    if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", measure); return () => window.removeEventListener("resize", measure); }
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === node) setWidth(entry.contentRect.width);
        if (entry.target === start) setLeadingWidth(entry.contentRect.width);
      }
    });
    observer.observe(node); if (start) observer.observe(start);
    return () => observer.disconnect();
  }, [hasStartControls]);
  useDismissibleLayer(overflowOpen, root, () => setOverflowOpen(false));
  useEffect(() => { if (!compact) setOverflowOpen(false); }, [compact]);
  useEffect(() => {
    if (overflowOpen) overflowTarget?.querySelector<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled)')?.focus();
  }, [overflowOpen, overflowTarget]);
  const closeOverflow = () => { setOverflowOpen(false); more.current?.focus(); };
  const withSerializationHint = (label: string) => serializationHint ? `${label} - ${serializationHint}` : label;

  return (
    <div
      ref={root} data-markie-doc-toolbar data-compact={compact || undefined}
      role="toolbar"
      aria-label="Document formatting"
      className="markie-doc-toolbar relative min-w-0 shrink-0 flex items-center gap-0.5 px-2 py-1 border-b border-border"
      style={{ background: "var(--surface)" }}
      onKeyDown={(event) => {
        if (overflowOpen && event.key === "Escape" && (event.target === more.current || overflowTarget?.contains(event.target as Node))) { event.preventDefault(); event.stopPropagation(); closeOverflow(); return; }
        if (!overflowTarget?.contains(event.target as Node)) return;
        if (!(event.target instanceof HTMLButtonElement) || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const controls = [...overflowTarget.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled)')];
        const index = controls.indexOf(event.target), next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : (index + (event.key === "ArrowDown" ? 1 : controls.length - 1)) % controls.length;
        event.preventDefault(); controls[next]?.focus();
      }}
      onClick={(event) => { if (overflowTarget?.contains(event.target as Node) && (event.target as HTMLElement).closest("button")) closeOverflow(); }}
      onChange={(event) => { if (overflowTarget?.contains(event.target as Node) && event.target instanceof HTMLSelectElement) closeOverflow(); }}
      onBlur={(event) => { if (overflowTarget?.contains(event.target as Node) && event.relatedTarget instanceof Node && !overflowTarget.contains(event.relatedTarget) && event.relatedTarget !== more.current) setOverflowOpen(false); }}
    >
      {startControls ? <div ref={leading} data-markie-toolbar-start className="flex flex-wrap items-center gap-0.5 min-w-0" style={{ maxWidth: width > 0 ? Math.max(0, width - 46) : undefined }}>{startControls}</div> : null}
      <OverflowTools compact={overflows("history")} target={overflowTarget}>
      {/* The conventional curved arrows: a hook back on itself, not the
          circular refresh glyph they read as before. */}
      {supports("undo") && (<TButton
        onClick={() => onAction("undo")}
        title={controlTitle("undo", "Undo")}
        label="Undo"
        disabled={!canEdit || !state?.canUndo}
      >
        <Icon><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></Icon>
      </TButton>)}
      {supports("redo") && (<TButton
        onClick={() => onAction("redo")}
        title={controlTitle("redo", "Redo")}
        label="Redo"
        disabled={!canEdit || !state?.canRedo}
      >
        <Icon><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></Icon>
      </TButton>)}
      </OverflowTools>
      <OverflowTools compact={overflows("output")} target={overflowTarget}>
      {onPrint && (<TButton onClick={onPrint} title={controlTitle("print", "Print")} label="Print">
        <Icon><path d="M6 9V2h12v7" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" rx="1" /></Icon>
      </TButton>)}
      {onHistory && (
        <TButton onClick={onHistory} title="Version history" label="History">
          <Icon><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>
        </TButton>
      )}
      </OverflowTools>

      {!compact && (hasActions("undo", "redo") || onPrint || onHistory) && <Divider />}

      {/* Zoom is a viewing preference. The renderer owns whether font and
          size changes affect the selection or the document's appearance. */}
      <OverflowTools compact={overflows("view")} target={overflowTarget}><TButton
        onClick={() => onAppearance({ ...appearance, zoom: stepZoom(appearance.zoom, -1) })}
        title={controlTitle("zoomOut", "Zoom out")}
        label="Zoom out"
      >
        <Icon><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /><path d="M8 11h6" /></Icon>
      </TButton>
      <span className="text-[11px] text-muted tabular-nums w-[38px] text-center shrink-0">
        {zoomLabel(appearance.zoom)}
      </span>
      <TButton
        onClick={() => onAppearance({ ...appearance, zoom: stepZoom(appearance.zoom, 1) })}
        title={controlTitle("zoomIn", "Zoom in")}
        label="Zoom in"
      >
        <Icon><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /><path d="M11 8v6" /><path d="M8 11h6" /></Icon>
      </TButton>

      {showWidthControls && <>
        {/* Page width, beside zoom: a per-document override of the reading
            column, for the table that gets squished at the default width. */}
        <TButton
          onClick={() => onAppearance({ ...appearance, width: stepWidth(appearance.width, -1) })}
          title={controlTitle("pageNarrower", "Narrower page")}
          label="Narrower"
        >
          <Icon><path d="M5 7 9 12 5 17" /><path d="M19 7 15 12 19 17" /></Icon>
        </TButton>
        <span className="text-[11px] text-muted tabular-nums w-[52px] text-center shrink-0">
          {widthLabel(appearance.width)}
        </span>
        <TButton
          onClick={() => onAppearance({ ...appearance, width: stepWidth(appearance.width, 1) })}
          title={controlTitle("pageWider", "Wider page")}
          label="Wider"
        >
          <Icon><path d="M7 7 3 12 7 17" /><path d="M17 7 21 12 17 17" /></Icon>
        </TButton>
      </>}
      </OverflowTools>

      {!compact && <Divider />}

      <OverflowTools compact={overflows("selectors")} target={overflowTarget}>{showStyleControls && <select
        value={currentStyle}
        onChange={(e) => onStyle(e.target.value)}
        disabled={!canEdit}
        aria-label="Paragraph style"
        title="Paragraph style"
        style={{ width: compact ? 112 : 140, minWidth: 0 }}
        className="markie-overlay-field text-[11px] h-7 px-1.5 shrink-0 disabled:opacity-35"
      >
        {styles.map((s) => (
          <option key={s.id} value={s.id}>{s.label}</option>
        ))}
      </select>}

      {/* Font and size follow the selection when there is one, and the whole
          document when there is not. Selecting a word and restyling everything
          is not what any editor does. */}
      <select
        value={currentFont}
        onChange={(e) => onFont(e.target.value)}
        disabled={selecting && !canEdit}
        aria-label="Font"
        title={
          selecting
            ? withSerializationHint("Font for the selected text")
            : "Font for the whole document - a viewing preference, not saved into the file"
        }
        style={{ width: compact ? 104 : 140, minWidth: 0 }}
        className="markie-overlay-field text-[11px] h-7 px-1.5 shrink-0"
      >
        {selecting && <option value="">{fontPlaceholder}</option>}
        {fonts.map((f) => (
          <option key={f.id} value={f.id}>{f.label}</option>
        ))}
      </select>
      </OverflowTools>

      <OverflowTools compact={overflows("size")} target={overflowTarget}><TButton
        onClick={() => { if (currentSize !== null) onSize(currentSize - 1); }}
        title={selecting ? "Smaller selected text" : "Smaller text (whole document)"}
        label="Decrease font size"
        disabled={(selecting && !canEdit) || currentSize === null || currentSize <= 1}
      >
        <Icon><path d="M5 12h14" /></Icon>
      </TButton>
      </OverflowTools>
      <OverflowTools compact={primaryInOverflow} target={overflowTarget}><input
        type="number"
        value={currentSize ?? ""}
        placeholder={sizePlaceholder}
        min={1} max={400} step={.5}
        onChange={(e) => { const value = Number(e.target.value); if (e.target.value && Number.isFinite(value) && value >= 1 && value <= 400 && value * 2 % 1 === 0) onSize(value); }}
        disabled={selecting && !canEdit}
        aria-label="Font size"
        title={
          selecting
            ? withSerializationHint("Size of the selected text")
            : "Font size for the whole document"
        }
        className="markie-overlay-field text-[11px] h-7 w-[38px] text-center shrink-0 tabular-nums"
      /></OverflowTools>
      <OverflowTools compact={overflows("size")} target={overflowTarget}><TButton
        onClick={() => { if (currentSize !== null) onSize(currentSize + 1); }}
        title={selecting ? "Larger selected text" : "Larger text (whole document)"}
        label="Increase font size"
        disabled={(selecting && !canEdit) || currentSize === null || currentSize >= 400}
      >
        <Icon><path d="M12 5v14" /><path d="M5 12h14" /></Icon>
      </TButton>
      </OverflowTools>

      {!compact && (hasActions("bold", "italic", "underline", "strike", "code") || onColor || onHighlight) && <Divider />}

      <OverflowTools compact={primaryInOverflow} target={overflowTarget}>
      {supports("bold") && (<TButton onClick={() => onAction("bold")} title={controlTitle("bold", "Bold")} label="Bold" active={state?.bold} disabled={!canEdit}>
        <span aria-hidden="true" className="text-[13px] font-bold">B</span>
      </TButton>)}
      {supports("italic") && (<TButton onClick={() => onAction("italic")} title={controlTitle("italic", "Italic")} label="Italic" active={state?.italic} disabled={!canEdit}>
        <span aria-hidden="true" className="font-serif text-[13px] italic">I</span>
      </TButton>)}
      {supports("underline") && (<TButton
        onClick={() => onAction("underline")}
        title={controlTitle("underline", "Underline", { note: serializationHint })}
        label="Underline"
        active={state?.underline}
        disabled={!canEdit}
      >
        <span aria-hidden="true" className="text-[13px] underline">U</span>
      </TButton>)}
      </OverflowTools>

      <OverflowTools compact={overflows("colour")} target={overflowTarget}>{onColor && <label
        title={controlTitle("textColour", "Text colour", { note: serializationHint })}
        className="h-7 px-1 rounded flex items-center gap-0.5 shrink-0 text-muted hover:text-foreground hover:bg-accent/40 cursor-pointer"
      >
        <span aria-hidden="true" className="text-[13px] font-semibold leading-none">A</span>
        <select
          value=""
          disabled={!canEdit}
          aria-label="Text colour"
          onChange={(e) => {
            const value = e.target.value;
            if (!canEdit) return;
            onColor(value || null);
            e.target.value = "";
          }}
          className="bg-transparent text-[10px] w-[14px] outline-none appearance-none cursor-pointer disabled:opacity-35"
        >
          <option value="">▾</option>
          {TEXT_COLOURS.map((c) => (
            <option key={c.label} value={c.value ?? ""}>{c.label}</option>
          ))}
        </select>
      </label>}

      {onHighlight && (
        <label
          title={controlTitle("highlight", "Highlight colour", { note: serializationHint })}
          className="h-7 px-1 rounded flex items-center gap-0.5 shrink-0 text-muted hover:text-foreground hover:bg-accent/40 cursor-pointer"
        >
          <Icon><path d="m9 11-6 6v3h3l6-6" /><path d="M13 3 21 11l-6 6-8-8Z" /></Icon>
          <select
            value=""
            disabled={!canEdit}
            aria-label="Highlight colour"
            onChange={(e) => {
              const value = e.target.value;
              if (!canEdit) return;
              onHighlight?.(value || null);
              e.target.value = "";
            }}
            className="bg-transparent text-[10px] w-[14px] outline-none appearance-none cursor-pointer disabled:opacity-35"
          >
            <option value="">▾</option>
            {HIGHLIGHTS.map((c) => (
              <option key={c.label} value={c.value ?? ""}>{c.label}</option>
            ))}
          </select>
        </label>
      )}
      </OverflowTools>
      <OverflowTools compact={overflows("marks")} target={overflowTarget}>
      {supports("strike") && (<TButton onClick={() => onAction("strike")} title={controlTitle("strike", "Strikethrough")} label="Strikethrough" active={state?.strike} disabled={!canEdit}>
        <Icon><path d="M5 12h14" /><path d="M9.5 9.2c0-2 1.6-3.7 4.1-3.7 1.2 0 2.3.3 3 .8" /><path d="M15.5 14.4c.8.4 1.2 1 1.2 1.8 0 1.5-1.5 2.5-3.8 2.5-1.5 0-2.8-.4-3.8-1.1" /></Icon>
      </TButton>)}
      {supports("code") && (<TButton onClick={() => onAction("code")} title={controlTitle("code", "Inline code")} label="Inline code" active={state?.code} disabled={!canEdit}>
        <Icon><path d="m9 18-6-6 6-6" /><path d="m15 6 6 6-6 6" /></Icon>
      </TButton>)}
      </OverflowTools>

      <OverflowTools compact={overflows("insert")} target={overflowTarget}>
      {!compact && hasActions("link", "image") && <Divider />}

      {supports("link") && (<TButton
        onClick={() => onAction("link")}
        title={controlTitle("link", "Insert link")}
        label="Insert link"
        disabled={!canEdit}
      >
        <Icon><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" /></Icon>
      </TButton>)}
      {supports("image") && (<TButton
        onClick={() => onAction("image")}
        title={controlTitle("image", "Insert image")}
        label="Insert image"
        disabled={!canEdit}
      >
        <Icon><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></Icon>
      </TButton>)}
      </OverflowTools>

      {!compact && hasActions("bullet", "ordered", "task", "align-left", "align-center", "align-right") && <Divider />}

      <OverflowTools compact={overflows("lists")} target={overflowTarget}>
      {supports("bullet") && (<TButton onClick={() => onAction("bullet")} title={controlTitle("bullet", "Bullet list")} label="Bullet list" active={state?.bullet} disabled={!canEdit}>
        <Icon><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3.5 6h.01" /><path d="M3.5 12h.01" /><path d="M3.5 18h.01" /></Icon>
      </TButton>)}
      {supports("ordered") && (<TButton onClick={() => onAction("ordered")} title={controlTitle("ordered", "Numbered list")} label="Numbered list" active={state?.ordered} disabled={!canEdit}>
        <Icon><path d="M10 6h11" /><path d="M10 12h11" /><path d="M10 18h11" /><path d="M4 6h1v4" /><path d="M4 10h2" /></Icon>
      </TButton>)}
      </OverflowTools>
      <OverflowTools compact={overflows("task")} target={overflowTarget}>
      {supports("task") && (<TButton onClick={() => onAction("task")} title={controlTitle("task", "Task list")} label="Task list" active={state?.task} disabled={!canEdit}>
        <Icon><rect x="3" y="5" width="5" height="5" rx="1" /><path d="m4.2 7.5 1.2 1.2 2-2.3" /><path d="M11 7.5h10" /><rect x="3" y="14" width="5" height="5" rx="1" /><path d="M11 16.5h10" /></Icon>
      </TButton>)}
      </OverflowTools>
      <OverflowTools compact={overflows("alignment")} target={overflowTarget}>
      {supports("align-left") && (<TButton
        onClick={() => onAction("align-left")}
        title={controlTitle("alignLeft", "Align left", { note: serializationHint })}
        label="Align left"
        active={state?.alignLeft}
        disabled={!canEdit}
      >
        <Icon><path d="M3 6h18" /><path d="M3 12h12" /><path d="M3 18h15" /></Icon>
      </TButton>)}
      {supports("align-center") && (<TButton
        onClick={() => onAction("align-center")}
        title={controlTitle("alignCenter", "Align centre", { note: serializationHint })}
        label="Align centre"
        active={state?.alignCenter}
        disabled={!canEdit}
      >
        <Icon><path d="M3 6h18" /><path d="M6 12h12" /><path d="M5 18h14" /></Icon>
      </TButton>)}
      {supports("align-right") && (<TButton
        onClick={() => onAction("align-right")}
        title={controlTitle("alignRight", "Align right", { note: serializationHint })}
        label="Align right"
        active={state?.alignRight}
        disabled={!canEdit}
      >
        <Icon><path d="M3 6h18" /><path d="M9 12h12" /><path d="M6 18h15" /></Icon>
      </TButton>)}
      </OverflowTools>

      <OverflowTools compact={overflows("clear")} target={overflowTarget}>
      {!compact && supports("clear") && <Divider />}

      {supports("clear") && (<TButton
        onClick={() => onAction("clear")}
        title={controlTitle("clearFormat", "Clear formatting")}
        label="Clear formatting"
        disabled={!canEdit}
      >
        <Icon><path d="m16 16 5-5" /><path d="m21 16-5-5" /><path d="m3 19 6.5-6.5" /><path d="m13 3 8 8" /><path d="M3 19h8" /></Icon>
      </TButton>)}
      </OverflowTools>
      {compact ? <button ref={more} type="button" aria-label="More formatting" title="More formatting and viewing controls" aria-haspopup="dialog" aria-expanded={overflowOpen} aria-controls={overflowOpen ? overflowId : undefined}
        className="h-7 min-w-7 px-1.5 rounded flex items-center justify-center shrink-0 text-muted hover:text-foreground hover:bg-accent/40"
        onClick={() => setOverflowOpen(!overflowOpen)} onKeyDown={(event) => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOverflowOpen(true); } }}>
        <Icon><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></Icon>
      </button> : null}
      {compact && overflowOpen ? <div ref={setOverflowTarget} id={overflowId} role="dialog" aria-label="More formatting" className="markie-format-overflow absolute right-2 top-full z-[60] mt-1 max-h-[60vh] w-[320px] max-w-[calc(100vw-32px)] overflow-auto rounded-lg border border-border bg-surface-2 p-1 shadow-lg" /> : null}
    </div>
  );
}
