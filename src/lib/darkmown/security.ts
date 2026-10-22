import type { Element, Root, RootContent } from "hast";
import { unified } from "unified";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";

const TAGS = ["main", "article", "section", "header", "footer", "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b", "i", "u", "s", "del", "mark", "small", "sub", "sup", "blockquote", "pre", "code", "ul", "ol", "li", "hr", "br", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "a", "button", "input", "label", "select", "option", "textarea", "form"];
const STRIP = new Set(["script", "style", "svg", "math", "iframe", "object", "embed", "template", "link", "meta", "base", "img", "video", "audio", "source", "picture", "track", "noscript"]);
const RUNTIME_ATTRIBUTES = ["dataWdBind", "dataWdPath", "dataWdComputed", "dataWdComputedKey", "dataWdComputedExpr", "dataWdAction", "dataWdTarget", "dataWdValue", "dataWdActions", "dataWdBindInput", "dataWdForm"];
const ACTIONS = new Set(["inc", "dec", "add", "sub", "toggle", "set", "reset"]);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
// Form-associated controls create named own properties on HTMLFormElement.
// Never let a field shadow a method/property the pinned runtime or host adapter
// uses. The ordinary user field "name" remains supported.
const RESERVED_FORM_NAMES = new Set([
  ...UNSAFE_KEYS, "reportvalidity", "checkvalidity", "queryselector", "queryselectorall", "dispatchevent",
  "hasattribute", "getattribute", "getattributens", "getattributenames", "setattribute", "setattributens", "removeattribute", "removeattributens", "toggleattribute",
  "closest", "matches", "elements", "submit", "requestsubmit", "reset", "ownerdocument", "attributes", "action", "method", "target", "enctype", "encoding",
  "addeventlistener", "removeeventlistener", "append", "appendchild", "remove", "removechild", "replacechildren", "insertbefore", "clonenode",
  "children", "childnodes", "firstchild", "firstelementchild", "parentelement", "parentnode", "contains", "innerhtml", "outerhtml", "textcontent", "nodename", "nodetype", "length",
]);
// '+' can concatenate strings, including a self-reference that doubles on
// every render. Only numeric-coercing arithmetic is supported in this profile.
const BINARY = new Set(["-", "*", "/", "%"]);
const WARNING = "Unsupported scripts, styling, navigation, media, persistence, network or advanced runtime features were disabled. The source is unchanged.";

export function safeDarkmownPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && /^[A-Za-z_][\w-]*(?:\.[A-Za-z_\d][\w-]*)*$/.test(value)
    && value.split(".").every((key) => !UNSAFE_KEYS.has(key));
}

function safeJson(value: unknown, depth = 0, budget = { remaining: 10_000 }): boolean {
  if (--budget.remaining < 0 || depth > 24) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 20_000;
  if (Array.isArray(value)) return value.length <= 1_000 && value.every((item) => safeJson(item, depth + 1, budget));
  return typeof value === "object" && Object.entries(value).every(([key, item]) => !UNSAFE_KEYS.has(key) && safeJson(item, depth + 1, budget));
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length > 100_000) throw new Error("Invalid or oversized runtime value");
  const value: unknown = JSON.parse(raw);
  if (!safeJson(value)) throw new Error("Unsafe runtime value");
  return value;
}

function safeAst(value: unknown, depth = 0, budget = { remaining: 1_000 }): boolean {
  if (--budget.remaining < 0 || depth > 24 || !Array.isArray(value)) return false;
  const [op, a, b] = value;
  if (op === "L") return value.length === 2 && typeof a === "number" && Number.isFinite(a);
  if (op === "S") return value.length >= 2 && value.length <= 3 && safeDarkmownPath(a) && (b == null || safeDarkmownPath(b));
  if (op === "u-") return value.length === 2 && safeAst(a, depth + 1, budget);
  if (BINARY.has(op)) return value.length === 3 && safeAst(a, depth + 1, budget) && safeAst(b, depth + 1, budget);
  return false;
}

function safeAction(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  return Object.keys(action).every((key) => ["op", "target", "value"].includes(key))
    && typeof action.op === "string" && ACTIONS.has(action.op) && safeDarkmownPath(action.target)
    && (!("value" in action) || safeJson(action.value));
}

function textOf(node: Element): string {
  return node.children.map((child) => child.type === "text" ? child.value : "").join("");
}

/** Parse inertly (never into a browser document), then expose only offline, bounded runtime data. */
export async function sanitizeDarkmownBody(bodyHtml: string, trusted: boolean): Promise<{ bodyHtml: string; seeds: string[]; warnings: string[] }> {
  if (bodyHtml.length > 2_000_000) throw new Error("Darkmown preview exceeds the safe rendering limit");
  const parser = unified().use(rehypeRaw);
  const tree = await parser.run({ type: "root", children: [{ type: "raw", value: bodyHtml }] } as Root);
  const seeds: string[] = [];
  let removed = false;
  let nodes = 0;
  function filter(children: RootContent[], depth = 0, inLocalForm = false): RootContent[] {
    if (depth > 64) throw new Error("Darkmown markup is nested too deeply");
    return children.flatMap((child): RootContent[] => {
      if (++nodes > 25_000) throw new Error("Darkmown preview has too many elements");
      if (child.type !== "element") return child.type === "text" ? [child] : [];
      const properties = child.properties;
      // The standalone-site compiler's hidden skip link loses its CSS/href in
      // this host. Markie already labels the preview region; do not leave a
      // decorative, nonfunctional "Skip to content" line above the document.
      if (child.tagName === "a" && properties.href === "#main"
        && Array.isArray(properties.className) && properties.className.length === 1 && properties.className[0] === "wd-skip-link"
        && textOf(child) === "Skip to content") return [];
      if (child.tagName === "script") {
        if (properties.type === "application/json" && "dataWdState" in properties) {
          try {
            const seed = parseJson(textOf(child));
            if (!seed || typeof seed !== "object" || Array.isArray(seed) || !Object.keys(seed).every((key) => safeDarkmownPath(key) && !key.includes("."))) throw new Error("Invalid state keys");
            if (trusted) seeds.push(JSON.stringify(seed).replace(/</g, "\\u003c"));
            if (Object.keys(properties).some((key) => !["type", "dataWdState"].includes(key))) removed = true;
          } catch { removed = true; }
        } else if (!(properties.type === "module" && properties.src === "/__wd/runtime.js")) removed = true;
        return [];
      }
      if (STRIP.has(child.tagName)) { removed = true; return []; }
      const localForm = child.tagName === "form" && trusted && safeDarkmownPath(properties.dataWdForm)
        && !["action", "method", "formAction", "enctype", "target"].some((key) => key in properties);
      if (child.tagName === "form" && !localForm) { removed = true; return filter(child.children as RootContent[], depth + 1); }
      if (child.tagName === "input" && !["text", "number", "range", "checkbox", "radio", "email", "url"].includes(String(properties.type || "text"))) { removed = true; return []; }
      const next: Element["properties"] = {};
      if (localForm) next.dataWdForm = properties.dataWdForm;
      for (const key of ["title", "ariaLabel", "ariaHidden", "colSpan", "rowSpan"]) {
        if (properties[key] != null) next[key] = properties[key];
      }
      const hasUnsupported = Object.keys(properties).some((key) =>
        key.startsWith("dataWd") && !RUNTIME_ATTRIBUTES.includes(key)
        || /^(on|style$|src|href$|poster$|action$|formAction$|ping$)/i.test(key) && !(key === "href" && properties[key] === "#main"));
      if (hasUnsupported) removed = true;
      if (trusted) {
        for (const key of ["dataWdBind", "dataWdPath"]) {
          if (safeDarkmownPath(properties[key])) next[key] = properties[key];
          else if (properties[key] != null) removed = true;
        }
        if ("dataWdComputed" in properties) {
          try {
            const ast = parseJson(properties.dataWdComputedExpr);
            if (!safeDarkmownPath(properties.dataWdComputedKey) || !safeAst(ast)) throw new Error("Invalid expression");
            next.dataWdComputed = ""; next.dataWdComputedKey = properties.dataWdComputedKey; next.dataWdComputedExpr = JSON.stringify(ast);
          } catch { removed = true; }
        }
        if (child.tagName === "button") {
          try {
            if (properties.dataWdActions != null) {
              const actions = parseJson(properties.dataWdActions);
              if (!Array.isArray(actions) || actions.length > 20 || !actions.every(safeAction)) throw new Error("Invalid actions");
              next.dataWdActions = JSON.stringify(actions);
            } else if (properties.dataWdAction != null) {
              const action = { op: properties.dataWdAction, target: properties.dataWdTarget, ...(properties.dataWdValue == null ? {} : { value: parseJson(properties.dataWdValue) }) };
              if (!safeAction(action)) throw new Error("Invalid action");
              next.dataWdAction = properties.dataWdAction; next.dataWdTarget = properties.dataWdTarget;
              if ("value" in action) next.dataWdValue = JSON.stringify(action.value);
            }
          } catch { removed = true; }
        }
        if (["input", "textarea", "select"].includes(child.tagName) && safeDarkmownPath(properties.dataWdBindInput)) next.dataWdBindInput = properties.dataWdBindInput;
      }
      if (child.tagName === "button") {
        const submit = inLocalForm && properties.type === "submit";
        next.type = submit ? "submit" : "button";
        next.disabled = properties.disabled === true || !trusted || !submit && !("dataWdAction" in next || "dataWdActions" in next);
      }
      if (["input", "textarea", "select"].includes(child.tagName)) {
        if (child.tagName === "input") next.type = properties.type || "text";
        const localField = inLocalForm && safeDarkmownPath(properties.name) && !properties.name.includes(".") && !RESERVED_FORM_NAMES.has(properties.name.toLowerCase());
        if (localField) next.name = properties.name;
        else if (inLocalForm && properties.name != null) removed = true;
        next.disabled = properties.disabled === true || !trusted || !next.dataWdBindInput && !localField;
        next.maxLength = 10_000;
        for (const key of ["min", "max", "step"]) {
          if (properties[key] != null && Number.isFinite(Number(properties[key]))) next[key] = String(properties[key]);
        }
        for (const key of ["value", "placeholder"]) if (typeof properties[key] === "string") next[key] = properties[key].slice(0, 10_000);
        if (properties.checked === true) next.checked = true;
      }
      if (child.tagName === "option") { next.value = typeof properties.value === "string" ? properties.value.slice(0, 10_000) : ""; if (properties.selected) next.selected = true; }
      if (trusted && Object.keys(properties).some((key) => key.startsWith("dataWd") && !(key in next))) removed = true;
      child.properties = next;
      child.children = filter(child.children as RootContent[], depth + 1, inLocalForm || localForm) as Element["children"];
      return [child];
    });
  }
  tree.children = filter(tree.children);
  const processor = unified().use(rehypeSanitize, {
    // IDs/form names are never admitted. Validated field names must remain
    // exact for FormData; GitHub's defaults otherwise rename and disable them.
    clobber: [], required: {},
    tagNames: TAGS,
    attributes: { "*": ["title", "ariaLabel", "ariaHidden", "colSpan", "rowSpan", ...RUNTIME_ATTRIBUTES], button: ["type", "disabled"], input: ["name", "type", "disabled", "maxLength", "min", "max", "step", "value", "placeholder", "checked"], textarea: ["name", "disabled", "maxLength", "placeholder"], select: ["name", "disabled"], option: ["value", "selected"] },
  }).use(rehypeStringify);
  const clean = await processor.run(tree);
  return { bodyHtml: processor.stringify(clean), seeds, warnings: removed ? [WARNING] : [] };
}
