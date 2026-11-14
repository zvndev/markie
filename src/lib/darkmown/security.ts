import type { Element, Root, RootContent } from "hast";
import { unified } from "unified";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { DARKMOWN_MAX_COMPUTED_GROWTH } from "./compiler-types";
import { darkmownLinkTarget, darkmownPictureRef, darkmownPictureUrl, isDarkmownPictureBase } from "./links";

const TAGS = ["main", "article", "section", "header", "footer", "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b", "i", "u", "s", "del", "mark", "small", "sub", "sup", "blockquote", "pre", "code", "ul", "ol", "li", "hr", "br", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "a", "button", "input", "label", "select", "option", "textarea", "form", "template"];
const STRIP = new Set(["script", "style", "svg", "math", "iframe", "object", "embed", "link", "meta", "base", "img", "video", "audio", "source", "picture", "track", "noscript"]);
const TEMPLATE_MARKERS = ["dataWdTrue", "dataWdFalse", "dataWdIfTrue", "dataWdIfFalse", "dataWdLoopTemplate", "dataWdLoopEmpty"];
// Attributes that only say what an element is. Their value carries nothing.
const MARKERS = [...TEMPLATE_MARKERS, "dataWdIfOut", "dataWdEachIf", "dataWdEachIfOut", "dataWdEach", "dataWdLoopOut", "dataWdLoopPiece", "dataWdLoopReverse"];
const CONDITION_ATTRIBUTES = ["dataWdIf", "dataWdIfExpr", "dataWdIfActive", "dataWdMeta"];
const LOOP_ATTRIBUTES = ["dataWdLoop", "dataWdLoopItem", "dataWdLoopWhere", "dataWdLoopSort", "dataWdLoopSortDir", "dataWdLoopLimit", "dataWdLoopOffset", "dataWdLoopKey", "dataWdEachMeta"];
const RUNTIME_ATTRIBUTES = [...MARKERS, "dataWdBind", "dataWdPath", "dataWdComputed", "dataWdComputedKey", "dataWdComputedExpr", "dataWdAction", "dataWdTarget", "dataWdValue", "dataWdActions", "dataWdBindInput", "dataWdForm", ...CONDITION_ATTRIBUTES, ...LOOP_ATTRIBUTES, "dataWdFmt"];
const ACTIONS = new Set(["inc", "dec", "add", "sub", "toggle", "set", "reset", "append", "prepend", "member-toggle", "remove-value", "remove", "clear", "merge", "delete"]);
const LOOP_META = new Set(["index", "number", "first", "last", "count"]);
const FORMATTERS = new Set(["money", "number", "percent", "round", "date", "time", "datetime", "upper", "lower", "capitalize", "truncate", "trim", "pluralize", "default", "sum", "avg", "min", "max", "count", "join"]);
const AGGREGATES = new Set(["sum", "avg", "min", "max", "count"]);
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
const BINARY = new Set(["+", "-", "*", "/", "%", "&&", "||", "==", "!=", ">", "<", ">=", "<="]);
// '+' can join text, so a computed can outgrow its inputs. Chained, it doubles per
// line, and in a cycle it doubles per render. `computedGrowthOk` holds the worst
// case to DARKMOWN_MAX_COMPUTED_GROWTH times the longest input.
// The worst case for nested loops is the longest list to the power of the depth.
const MAX_LOOP_ROWS = 20_000;
const MAX_FORMAT_STAGES = 8;
const MAX_FORMAT_ARG = 200;
const WARNING = "Unsupported scripts, styling, navigation, media, persistence, network or advanced runtime features were disabled. The source is unchanged.";
// The attributes of a `:fetch` marker, kept only when the caller asks for
// network (a hosted Live Doc). The Mac preview never does: it stays offline.
const FETCH_ATTRIBUTES = ["dataWdFetch", "dataWdFetchKey", "dataWdFetchUrl", "dataWdFetchMethod", "dataWdFetchWhen", "dataWdFetchTimeout", "dataWdFetchRetry", "dataWdFetchHeaders", "dataWdFetchBody", "dataWdFetchRefresh", "dataWdFetchDeps"];
const FETCH_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
// Names that never resolve on the public internet, or that point back into
// whoever is reading the page (their machine, their home or office network).
const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "intranet", "lan", "home", "corp", "home.arpa", "test", "example", "invalid", "onion"];

/**
 * The origin a hosted Live Doc's `:fetch` address reaches, or null when it
 * may not be hosted. Only an https:// address whose host is written out in
 * full, before any `{ state }` interpolation, so the origin is fixed when the
 * page compiles and can go into the page's Content Security Policy. Never an
 * IP address, a single-label or private name, credentials, or a relative path.
 */
export function darkmownFetchOrigin(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > 2000) return null;
  // `{ name }` interpolations may hold spaces; nothing else may, and every
  // brace must belong to a well-formed one.
  const bare = url.replace(/\{\s*[A-Za-z_][\w.-]{0,199}\s*\}/g, "");
  if (/[\x00-\x20\x7f\\{}]/.test(bare)) return null;
  // Matched on the whole address, so the host (and port) must end at a `/`,
  // `?`, `#` or the end before anything else: a `{ }` straight after it
  // could otherwise extend the host the browser actually fetches.
  const match = /^https:\/\/([A-Za-z0-9.-]+)(?::(\d{1,5}))?(?=[/?#]|$)/.exec(url);
  if (!match) return null;
  const host = match[1]!.toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  if (host.length > 253 || labels.length < 2 || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1]!)) return null;
  if (PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
  const port = match[2] === undefined ? null : Number(match[2]);
  if (port !== null && (port < 1 || port > 65535)) return null;
  return `https://${host}${port === null || port === 443 ? "" : `:${port}`}`;
}

function digits(value: unknown, max: number): string | null {
  return typeof value === "string" && /^\d{1,9}$/.test(value) && Number(value) <= max ? value : null;
}

function stateKey(value: unknown): value is string {
  return safeDarkmownPath(value) && !value.includes(".");
}

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
  const sub = (node: unknown) => safeAst(node, depth + 1, budget);
  if (op === "L") return value.length === 2 && (a === null || typeof a === "boolean" || (typeof a === "number" ? Number.isFinite(a) : typeof a === "string" && a.length <= MAX_FORMAT_ARG));
  if (op === "S") return value.length >= 2 && value.length <= 3 && safeDarkmownPath(a) && (b == null || safeDarkmownPath(b));
  if (op === "I") return value.length <= 2 && (a == null || safeDarkmownPath(a));
  if (op === "u-" || op === "!") return value.length === 2 && sub(a);
  if (op === "C") return value.length === 3 && sub(a) && sub(b);
  if (op === "A") return value.length >= 3 && value.length <= 4 && typeof a === "string" && AGGREGATES.has(a) && sub(b) && (value[3] == null || safeDarkmownPath(value[3]));
  if (typeof op === "string" && BINARY.has(op)) return value.length === 3 && sub(a) && sub(b);
  return false;
}

/** Rebuilds a pipe chain. The runtime reads it as `[[name, args], ...]`. */
function safeFormat(raw: unknown): string | null {
  try {
    const stages = parseJson(raw);
    if (!Array.isArray(stages) || stages.length > MAX_FORMAT_STAGES) return null;
    const ok = stages.every((stage) => Array.isArray(stage) && stage.length === 2 && typeof stage[0] === "string" && FORMATTERS.has(stage[0])
      && Array.isArray(stage[1]) && stage[1].length <= 3
      && stage[1].every((arg: unknown) => arg === null || typeof arg === "boolean" || (typeof arg === "number" ? Number.isFinite(arg) : typeof arg === "string" && arg.length <= MAX_FORMAT_ARG)));
    return ok ? JSON.stringify(stages) : null;
  } catch { return null; }
}

/** How many times over a computed can repeat its longest input, or Infinity on a cycle. */
function computedGrowth(ast: unknown, computed: ReadonlyMap<string, unknown>, active: Set<string>): number {
  if (!Array.isArray(ast)) return 0;
  const [op, a] = ast;
  if (op === "L") return 1;
  if (op === "S") {
    if (typeof a !== "string" || !computed.has(a)) return 1;
    if (active.has(a)) return Infinity;
    active.add(a);
    const growth = computedGrowth(computed.get(a), computed, active);
    active.delete(a);
    return growth;
  }
  const parts = ast.slice(1).map((part) => computedGrowth(part, computed, active));
  return op === "+" ? parts.reduce((sum, part) => sum + part, 0) : Math.max(0, ...parts);
}

function computedGrowthOk(key: string, computed: ReadonlyMap<string, unknown>): boolean {
  return computedGrowth(computed.get(key), computed, new Set([key])) <= DARKMOWN_MAX_COMPUTED_GROWTH;
}

/** Longest list in a seed, at any depth. */
function longestList(value: unknown): number {
  if (Array.isArray(value)) return Math.max(value.length, ...value.map(longestList));
  return value && typeof value === "object" ? Math.max(0, ...Object.values(value).map(longestList)) : 0;
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

/**
 * What a desktop preview may keep beyond the offline default. `links` keeps an
 * http(s) or mailto href, as a new-window link the sandbox itself refuses; the
 * host's link bridge is what opens it. `pictureBase` is a picture scope main
 * issued for this document's folder; a relative picture is pointed into it.
 */
export interface DarkmownSanitizeOptions {
  links?: boolean;
  pictureBase?: string | null;
  /**
   * Keep `:fetch` (hosted Live Docs only). Each address must pass
   * darkmownFetchOrigin, and the origins come back in `network`, for the
   * page's CSP. A form still has no action, but a :fetch can carry state,
   * including what a reader typed, to its site, and every listed site sees
   * the page's own address in the Origin header.
   */
  fetch?: boolean;
}

/** Parse inertly (never into a browser document), then expose only offline, bounded runtime data. */
export async function sanitizeDarkmownBody(bodyHtml: string, trusted: boolean, options: DarkmownSanitizeOptions = {}): Promise<{ bodyHtml: string; seeds: string[]; warnings: string[]; network: string[] }> {
  if (bodyHtml.length > 2_000_000) throw new Error("Darkmown preview exceeds the safe rendering limit");
  const links = options.links === true;
  const fetchOn = options.fetch === true && trusted;
  const network = new Set<string>();
  const pictureBase = isDarkmownPictureBase(options.pictureBase) ? options.pictureBase : null;
  const parser = unified().use(rehypeRaw);
  const tree = await parser.run({ type: "root", children: [{ type: "raw", value: bodyHtml }] } as Root);
  const seeds: string[] = [];
  let removed = false;
  let nodes = 0;
  let listLength = 0;
  let loopDepth = 0;
  const computed = new Map<string, unknown>();
  (function collect(children: RootContent[]) {
    for (const child of children) {
      if (child.type !== "element") continue;
      if ("dataWdComputed" in child.properties && typeof child.properties.dataWdComputedKey === "string") {
        try { computed.set(child.properties.dataWdComputedKey, parseJson(child.properties.dataWdComputedExpr)); } catch { /* the filter below removes it */ }
      }
      collect(child.children as RootContent[]);
      if (child.tagName === "template" && child.content) collect(child.content.children as RootContent[]);
    }
  })(tree.children);
  function filter(children: RootContent[], depth = 0, inLocalForm = false, loops = 0): RootContent[] {
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
            listLength = Math.max(listLength, longestList(seed));
            if (trusted) seeds.push(JSON.stringify(seed).replace(/</g, "\\u003c"));
            if (Object.keys(properties).some((key) => !["type", "dataWdState"].includes(key))) removed = true;
          } catch { removed = true; }
        } else if (!(properties.type === "module" && properties.src === "/__wd/runtime.js")) removed = true;
        return [];
      }
      if (child.tagName === "img" && pictureBase) {
        // Only a picture in the document's own folder, through the scope main
        // issued for that folder. Remote, absolute and `..` pictures stay out.
        const ref = darkmownPictureRef(properties.src);
        if (!ref) { removed = true; return []; }
        if (Object.keys(properties).some((key) => /^(on|style$|srcSet$)/i.test(key))) removed = true;
        const picture: Element["properties"] = { src: darkmownPictureUrl(pictureBase, ref) };
        for (const key of ["alt", "title"]) if (typeof properties[key] === "string") picture[key] = String(properties[key]).slice(0, 10_000);
        child.properties = picture; child.children = [];
        return [child];
      }
      if (child.tagName === "span" && "dataWdFetch" in properties) {
        // A `:fetch` marker: kept, rebuilt from validated values only, when
        // the caller asked for network. Every address it can reach (the URL,
        // and a token-refresh URL) is recorded for the page's CSP.
        const origin = fetchOn ? darkmownFetchOrigin(properties.dataWdFetchUrl) : null;
        const refreshOrigin = properties.dataWdFetchRefresh == null ? undefined : fetchOn ? darkmownFetchOrigin(properties.dataWdFetchRefresh) : null;
        const method = properties.dataWdFetchMethod == null ? undefined : FETCH_METHODS.has(String(properties.dataWdFetchMethod)) ? String(properties.dataWdFetchMethod) : null;
        const when = properties.dataWdFetchWhen == null ? undefined : properties.dataWdFetchWhen === "visible" ? "visible" : null;
        const timeout = properties.dataWdFetchTimeout == null ? undefined : digits(properties.dataWdFetchTimeout, 120_000);
        const retry = properties.dataWdFetchRetry == null ? undefined : digits(properties.dataWdFetchRetry, 10);
        const headers = properties.dataWdFetchHeaders == null ? undefined : stateKey(properties.dataWdFetchHeaders) ? properties.dataWdFetchHeaders : null;
        const body = properties.dataWdFetchBody == null ? undefined : stateKey(properties.dataWdFetchBody) ? properties.dataWdFetchBody : null;
        const depsRaw = properties.dataWdFetchDeps;
        const deps = depsRaw == null ? undefined
          : typeof depsRaw === "string" && depsRaw.split(",").length <= 32 && depsRaw.split(",").every(stateKey) ? depsRaw : null;
        const extra = Object.keys(properties).some((key) => !FETCH_ATTRIBUTES.includes(key));
        if (!origin || !stateKey(properties.dataWdFetchKey) || [refreshOrigin, method, when, timeout, retry, headers, body, deps].includes(null) || extra) {
          removed = true;
          return [];
        }
        network.add(origin);
        if (refreshOrigin) network.add(refreshOrigin);
        const marker: Element["properties"] = { dataWdFetch: "", dataWdFetchKey: properties.dataWdFetchKey, dataWdFetchUrl: String(properties.dataWdFetchUrl) };
        const optional: Array<[string, string | undefined]> = [
          ["dataWdFetchMethod", method ?? undefined], ["dataWdFetchWhen", when ?? undefined], ["dataWdFetchTimeout", timeout ?? undefined],
          ["dataWdFetchRetry", retry ?? undefined], ["dataWdFetchHeaders", headers ?? undefined], ["dataWdFetchBody", body ?? undefined],
          ["dataWdFetchRefresh", refreshOrigin ? String(properties.dataWdFetchRefresh) : undefined], ["dataWdFetchDeps", deps ?? undefined],
        ];
        for (const [key, value] of optional) if (value !== undefined) marker[key] = value;
        child.properties = marker;
        child.children = [];
        return [child];
      }
      if (STRIP.has(child.tagName)) { removed = true; return []; }
      if (child.tagName === "template") {
        const known = TEMPLATE_MARKERS.filter((key) => key in properties);
        const body = child.content?.children;
        if (known.length !== 1 || !body) { removed = true; return []; }
        // Before the runtime runs, a branch or row template shows nothing.
        if (!trusted) return [];
        child.properties = { [known[0]]: "" };
        // hast keeps template contents apart from `children`, and the sanitizer only
        // walks `children`, so they travel there until the sanitizer is done.
        child.children = filter(body as RootContent[], depth + 1, inLocalForm, loops) as Element["children"];
        delete child.content;
        return [child];
      }
      const localForm = child.tagName === "form" && trusted && safeDarkmownPath(properties.dataWdForm)
        && !["action", "method", "formAction", "enctype", "target"].some((key) => key in properties);
      if (child.tagName === "form" && !localForm) { removed = true; return filter(child.children as RootContent[], depth + 1); }
      if (child.tagName === "input" && !["text", "number", "range", "checkbox", "radio", "email", "url"].includes(String(properties.type || "text"))) { removed = true; return []; }
      const next: Element["properties"] = {};
      if (localForm) next.dataWdForm = properties.dataWdForm;
      // A link keeps its address only when it is a web page or a mail draft.
      // It opens a new window, which the frame's sandbox refuses, so the frame
      // itself never navigates; the link bridge hands the click to the host.
      const href = links && child.tagName === "a" ? darkmownLinkTarget(properties.href) : null;
      if (href) { next.href = href; next.target = "_blank"; next.rel = ["noopener", "noreferrer"]; }
      for (const key of ["title", "ariaLabel", "ariaHidden", "colSpan", "rowSpan"]) {
        if (properties[key] != null) next[key] = properties[key];
      }
      const hasUnsupported = Object.keys(properties).some((key) =>
        key.startsWith("dataWd") && !RUNTIME_ATTRIBUTES.includes(key)
        || /^(on|style$|src|href$|poster$|action$|formAction$|ping$)/i.test(key) && !(key === "href" && (properties[key] === "#main" || href)));
      if (hasUnsupported) removed = true;
      if (trusted) {
        for (const key of MARKERS) if (key in properties && !TEMPLATE_MARKERS.includes(key)) next[key] = "";
        for (const key of ["dataWdBind", "dataWdPath", "dataWdLoop", "dataWdLoopItem", "dataWdLoopSort"]) {
          if (safeDarkmownPath(properties[key])) next[key] = properties[key];
          else if (properties[key] != null) removed = true;
        }
        if (typeof properties.dataWdIf === "string" && (properties.dataWdIf === "" || safeDarkmownPath(properties.dataWdIf))) next.dataWdIf = properties.dataWdIf;
        else if (properties.dataWdIf != null) removed = true;
        for (const key of ["dataWdIfExpr", "dataWdLoopWhere"]) {
          if (properties[key] == null) continue;
          try {
            const ast = parseJson(properties[key]);
            if (!safeAst(ast)) throw new Error("Invalid expression");
            next[key] = JSON.stringify(ast);
          } catch { removed = true; }
        }
        if (properties.dataWdIfActive === "true" || properties.dataWdIfActive === "false") next.dataWdIfActive = properties.dataWdIfActive;
        else if (properties.dataWdIfActive != null) removed = true;
        for (const key of ["dataWdMeta", "dataWdEachMeta"]) {
          if (typeof properties[key] === "string" && LOOP_META.has(properties[key])) next[key] = properties[key];
          else if (properties[key] != null) removed = true;
        }
        if (properties.dataWdLoopSortDir === "asc" || properties.dataWdLoopSortDir === "desc") next.dataWdLoopSortDir = properties.dataWdLoopSortDir;
        else if (properties.dataWdLoopSortDir != null) removed = true;
        for (const key of ["dataWdLoopLimit", "dataWdLoopOffset"]) {
          if (/^\d{1,6}$/.test(String(properties[key] ?? ""))) next[key] = String(properties[key]);
          else if (properties[key] != null) removed = true;
        }
        // The key is only ever compared, and the runtime writes the same JSON itself.
        if (typeof properties.dataWdLoopKey === "string" && properties.dataWdLoopKey.length <= 20_000) next.dataWdLoopKey = properties.dataWdLoopKey;
        else if (properties.dataWdLoopKey != null) removed = true;
        if (properties.dataWdFmt != null) {
          const format = safeFormat(properties.dataWdFmt);
          if (format) next.dataWdFmt = format;
          else removed = true;
        }
        if ("dataWdComputed" in properties) {
          try {
            const ast = parseJson(properties.dataWdComputedExpr);
            if (!safeDarkmownPath(properties.dataWdComputedKey) || !safeAst(ast) || !computedGrowthOk(properties.dataWdComputedKey, computed)) throw new Error("Invalid expression");
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
      const insideLoop = loops + ("dataWdLoop" in next || "dataWdLoopItem" in next ? 1 : 0);
      loopDepth = Math.max(loopDepth, insideLoop);
      child.children = filter(child.children as RootContent[], depth + 1, inLocalForm || localForm, insideLoop) as Element["children"];
      return [child];
    });
  }
  tree.children = filter(tree.children);
  if (listLength ** loopDepth > MAX_LOOP_ROWS) throw new Error("These nested loops could draw too many rows for an interactive preview. Your source remains available to edit and save.");
  const processor = unified().use(rehypeSanitize, {
    // IDs/form names are never admitted. Validated field names must remain
    // exact for FormData; GitHub's defaults otherwise rename and disable them.
    clobber: [], required: {},
    tagNames: pictureBase ? [...TAGS, "img"] : TAGS,
    attributes: {
      "*": ["title", "ariaLabel", "ariaHidden", "colSpan", "rowSpan", ...RUNTIME_ATTRIBUTES], button: ["type", "disabled"], input: ["name", "type", "disabled", "maxLength", "min", "max", "step", "value", "placeholder", "checked"], textarea: ["name", "disabled", "maxLength", "placeholder"], select: ["name", "disabled"], option: ["value", "selected"],
      ...(links ? { a: ["href", "target", "rel"] } : {}),
      ...(pictureBase ? { img: ["src", "alt", "title"] } : {}),
      ...(fetchOn ? { span: FETCH_ATTRIBUTES } : {}),
    },
    // A second, independent check on the two URL-bearing attributes.
    protocols: { href: ["http", "https", "mailto"], src: ["markie-asset"] },
  }).use(rehypeStringify);
  const clean = await processor.run(tree);
  (function restoreTemplates(node: Root | Element) {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      restoreTemplates(child);
      if (child.tagName === "template") {
        child.content = { type: "root", children: child.children as RootContent[] };
        child.children = [];
      }
    }
  })(clean as Root);
  return { bodyHtml: processor.stringify(clean), seeds, warnings: removed ? [WARNING] : [], network: [...network].sort() };
}
