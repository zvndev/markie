//! `sanitizeDarkmownBody` (`src/lib/darkmown/security.ts`): parse the
//! compiler's body inertly, keep only offline, bounded runtime data, then run
//! the strict preview schema over it.
//!
//! The rules are the TypeScript's, one for one, written against attribute
//! names (`data-wd-bind`) where the TypeScript reads hast properties
//! (`dataWdBind`). `:fetch` (hosted Live Docs only) is not ported: the Mac
//! preview never asks for network, so every `:fetch` marker is removed.

use std::collections::{HashMap, HashSet};

use markie_export::hast::{self, Element, Node, Space};
use markie_export::sanitize::{Rule, Schema, attr_name};

use super::links::{darkmown_link_target, darkmown_picture_ref, darkmown_picture_url, is_darkmown_picture_base};
use crate::json::{self, Json, js_len};

pub const DARKMOWN_MAX_COMPUTED_GROWTH: f64 = 64.0;
const MAX_LOOP_ROWS: f64 = 20_000.0;
const MAX_FORMAT_STAGES: usize = 8;
const MAX_FORMAT_ARG: usize = 200;
pub const WARNING: &str = "Unsupported scripts, styling, navigation, media, persistence, network or advanced runtime features were disabled. The source is unchanged.";

const TAGS: &[&str] = &[
    "main", "article", "section", "header", "footer", "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b",
    "i", "u", "s", "del", "mark", "small", "sub", "sup", "blockquote", "pre", "code", "ul", "ol", "li", "hr", "br", "table",
    "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "a", "button", "input", "label", "select", "option", "textarea",
    "form", "template",
];
const STRIP: &[&str] = &[
    "script", "style", "svg", "math", "iframe", "object", "embed", "link", "meta", "base", "img", "video", "audio", "source",
    "picture", "track", "noscript",
];
const TEMPLATE_MARKERS: &[&str] = &["dataWdTrue", "dataWdFalse", "dataWdIfTrue", "dataWdIfFalse", "dataWdLoopTemplate", "dataWdLoopEmpty"];
const MARKERS_EXTRA: &[&str] = &["dataWdIfOut", "dataWdEachIf", "dataWdEachIfOut", "dataWdEach", "dataWdLoopOut", "dataWdLoopPiece", "dataWdLoopReverse"];
const CONDITION_ATTRIBUTES: &[&str] = &["dataWdIf", "dataWdIfExpr", "dataWdIfActive", "dataWdMeta"];
const LOOP_ATTRIBUTES: &[&str] = &["dataWdLoop", "dataWdLoopItem", "dataWdLoopWhere", "dataWdLoopSort", "dataWdLoopSortDir", "dataWdLoopLimit", "dataWdLoopOffset", "dataWdLoopKey", "dataWdEachMeta"];
const ACTIONS: &[&str] = &["inc", "dec", "add", "sub", "toggle", "set", "reset", "append", "prepend", "member-toggle", "remove-value", "remove", "clear", "merge", "delete"];
const LOOP_META: &[&str] = &["index", "number", "first", "last", "count"];
const FORMATTERS: &[&str] = &[
    "money", "number", "percent", "round", "date", "time", "datetime", "upper", "lower", "capitalize", "truncate", "trim",
    "pluralize", "default", "sum", "avg", "min", "max", "count", "join",
];
const AGGREGATES: &[&str] = &["sum", "avg", "min", "max", "count"];
const UNSAFE_KEYS: &[&str] = &["__proto__", "prototype", "constructor"];
const RESERVED_FORM_NAMES: &[&str] = &[
    "__proto__", "prototype", "constructor", "reportvalidity", "checkvalidity", "queryselector", "queryselectorall", "dispatchevent",
    "hasattribute", "getattribute", "getattributens", "getattributenames", "setattribute", "setattributens", "removeattribute",
    "removeattributens", "toggleattribute", "closest", "matches", "elements", "submit", "requestsubmit", "reset", "ownerdocument",
    "attributes", "action", "method", "target", "enctype", "encoding", "addeventlistener", "removeeventlistener", "append",
    "appendchild", "remove", "removechild", "replacechildren", "insertbefore", "clonenode", "children", "childnodes", "firstchild",
    "firstelementchild", "parentelement", "parentnode", "contains", "innerhtml", "outerhtml", "textcontent", "nodename", "nodetype",
    "length",
];
const BINARY: &[&str] = &["+", "-", "*", "/", "%", "&&", "||", "==", "!=", ">", "<", ">=", "<="];

fn markers() -> Vec<&'static str> {
    TEMPLATE_MARKERS.iter().chain(MARKERS_EXTRA).copied().collect()
}

fn runtime_attributes() -> Vec<&'static str> {
    let mut v = markers();
    v.extend(["dataWdBind", "dataWdPath", "dataWdComputed", "dataWdComputedKey", "dataWdComputedExpr", "dataWdAction", "dataWdTarget", "dataWdValue", "dataWdActions", "dataWdBindInput", "dataWdForm"]);
    v.extend(CONDITION_ATTRIBUTES);
    v.extend(LOOP_ATTRIBUTES);
    v.push("dataWdFmt");
    v
}

fn a(prop: &str) -> String {
    attr_name(prop, Space::Html)
}

/// `safeDarkmownPath`.
pub fn safe_path(value: &str) -> bool {
    if js_len(value) > 200 || value.is_empty() {
        return false;
    }
    let mut parts = value.split('.');
    let first = parts.next().unwrap_or("");
    let ident = |s: &str, first_rule: fn(char) -> bool| {
        let mut chars = s.chars();
        chars.next().is_some_and(first_rule) && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    if !ident(first, |c| c.is_ascii_alphabetic() || c == '_') {
        return false;
    }
    for part in parts {
        if !ident(part, |c| c.is_ascii_alphanumeric() || c == '_') {
            return false;
        }
    }
    value.split('.').all(|k| !UNSAFE_KEYS.contains(&k))
}

fn safe_json(value: &Json, depth: usize, budget: &mut i64) -> bool {
    *budget -= 1;
    if *budget < 0 || depth > 24 {
        return false;
    }
    match value {
        Json::Null | Json::Bool(_) => true,
        Json::Num(n) => n.is_finite(),
        Json::Str(s) => js_len(s) <= 20_000,
        Json::Arr(a) => a.len() <= 1_000 && a.iter().all(|x| safe_json(x, depth + 1, budget)),
        Json::Obj(o) => o.iter().all(|(k, x)| !UNSAFE_KEYS.contains(&k.as_str()) && safe_json(x, depth + 1, budget)),
    }
}

fn parse_json(raw: &str) -> Option<Json> {
    if js_len(raw) > 100_000 {
        return None;
    }
    let v = json::parse(raw)?;
    safe_json(&v, 0, &mut 10_000).then_some(v)
}

fn is_safe_path_json(v: &Json) -> bool {
    v.as_str().is_some_and(safe_path)
}

fn safe_ast(value: &Json, depth: usize, budget: &mut i64) -> bool {
    *budget -= 1;
    if *budget < 0 || depth > 24 {
        return false;
    }
    let Json::Arr(v) = value else { return false };
    let op = v.first();
    let a = v.get(1);
    let b = v.get(2);
    let nullish = |x: Option<&Json>| matches!(x, None | Some(Json::Null));
    let Some(Json::Str(op)) = op else { return false };
    match op.as_str() {
        "L" => {
            v.len() == 2
                && match a {
                    Some(Json::Null) | Some(Json::Bool(_)) => true,
                    Some(Json::Num(n)) => n.is_finite(),
                    Some(Json::Str(s)) => js_len(s) <= MAX_FORMAT_ARG,
                    _ => false,
                }
        }
        "S" => (2..=3).contains(&v.len()) && a.is_some_and(is_safe_path_json) && (nullish(b) || b.is_some_and(is_safe_path_json)),
        "I" => v.len() <= 2 && (nullish(a) || a.is_some_and(is_safe_path_json)),
        "u-" | "!" => v.len() == 2 && safe_ast(a.unwrap(), depth + 1, budget),
        "C" => v.len() == 3 && safe_ast(a.unwrap(), depth + 1, budget) && safe_ast(b.unwrap(), depth + 1, budget),
        "A" => {
            (3..=4).contains(&v.len())
                && a.and_then(Json::as_str).is_some_and(|s| AGGREGATES.contains(&s))
                && safe_ast(b.unwrap(), depth + 1, budget)
                && (nullish(v.get(3)) || v.get(3).is_some_and(is_safe_path_json))
        }
        op if BINARY.contains(&op) => v.len() == 3 && safe_ast(a.unwrap(), depth + 1, budget) && safe_ast(b.unwrap(), depth + 1, budget),
        _ => false,
    }
}

fn safe_format(raw: &str) -> Option<String> {
    let stages = parse_json(raw)?;
    let list = stages.as_arr()?;
    if list.len() > MAX_FORMAT_STAGES {
        return None;
    }
    let ok = list.iter().all(|stage| {
        let Some(s) = stage.as_arr() else { return false };
        s.len() == 2
            && s[0].as_str().is_some_and(|n| FORMATTERS.contains(&n))
            && s[1].as_arr().is_some_and(|args| {
                args.len() <= 3
                    && args.iter().all(|arg| match arg {
                        Json::Null | Json::Bool(_) => true,
                        Json::Num(n) => n.is_finite(),
                        Json::Str(s) => js_len(s) <= MAX_FORMAT_ARG,
                        _ => false,
                    })
            })
    });
    ok.then(|| json::stringify(&stages))
}

fn computed_growth(ast: &Json, computed: &HashMap<String, Json>, active: &mut HashSet<String>) -> f64 {
    let Json::Arr(v) = ast else { return 0.0 };
    let op = v.first().and_then(Json::as_str).unwrap_or("");
    if op == "L" {
        return 1.0;
    }
    if op == "S" {
        let Some(name) = v.get(1).and_then(Json::as_str) else { return 1.0 };
        let Some(expr) = computed.get(name) else { return 1.0 };
        if active.contains(name) {
            return f64::INFINITY;
        }
        active.insert(name.to_string());
        let g = computed_growth(expr, computed, active);
        active.remove(name);
        return g;
    }
    let parts: Vec<f64> = v[1..].iter().map(|p| computed_growth(p, computed, active)).collect();
    if op == "+" { parts.iter().sum() } else { parts.into_iter().fold(0.0, f64::max) }
}

fn computed_growth_ok(key: &str, computed: &HashMap<String, Json>) -> bool {
    let Some(expr) = computed.get(key) else { return true };
    let mut active = HashSet::from([key.to_string()]);
    computed_growth(expr, computed, &mut active) <= DARKMOWN_MAX_COMPUTED_GROWTH
}

fn longest_list(v: &Json) -> f64 {
    match v {
        Json::Arr(a) => a.iter().map(longest_list).fold(a.len() as f64, f64::max),
        Json::Obj(o) => o.iter().map(|(_, x)| longest_list(x)).fold(0.0, f64::max),
        _ => 0.0,
    }
}

fn safe_action(value: &Json) -> bool {
    let Json::Obj(o) = value else { return false };
    o.iter().all(|(k, _)| ["op", "target", "value"].contains(&k.as_str()))
        && value.get("op").and_then(Json::as_str).is_some_and(|op| ACTIONS.contains(&op))
        && value.get("target").is_some_and(is_safe_path_json)
        && value.get("value").is_none_or(|v| safe_json(v, 0, &mut 10_000))
}

/// What a desktop preview may keep beyond the offline default.
#[derive(Clone, Debug, Default)]
pub struct SanitizeOptions {
    pub links: bool,
    pub picture_base: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Sanitized {
    pub body_html: String,
    pub seeds: Vec<String>,
    pub warnings: Vec<String>,
}

struct State<'a> {
    trusted: bool,
    links: bool,
    picture_base: Option<&'a str>,
    seeds: Vec<String>,
    removed: bool,
    nodes: usize,
    list_length: f64,
    loop_depth: usize,
    computed: HashMap<String, Json>,
    runtime_attrs: Vec<String>,
    markers: Vec<String>,
    template_markers: Vec<String>,
}

fn collect(nodes: &[Node], computed: &mut HashMap<String, Json>) {
    for node in nodes {
        let Node::Element(e) = node else { continue };
        if e.has("data-wd-computed")
            && let Some(key) = e.get("data-wd-computed-key")
            && let Some(expr) = e.get("data-wd-computed-expr").and_then(parse_json)
        {
            computed.insert(key.to_string(), expr);
        }
        collect(&e.children, computed);
        if e.tag == "template"
            && let Some(c) = &e.content
        {
            collect(c, computed);
        }
    }
}

/// An ordered attribute list (JavaScript object key order).
#[derive(Default)]
struct Next(Vec<(String, String)>);

impl Next {
    fn set(&mut self, k: &str, v: &str) {
        match self.0.iter_mut().find(|(n, _)| n == k) {
            Some(slot) => slot.1 = v.to_string(),
            None => self.0.push((k.to_string(), v.to_string())),
        }
    }
    fn has(&self, k: &str) -> bool {
        self.0.iter().any(|(n, _)| n == k)
    }
    fn get(&self, k: &str) -> Option<&str> {
        self.0.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }
    /// A boolean property: present when true, absent when false.
    fn flag(&mut self, k: &str, on: bool) {
        if on {
            self.set(k, "");
        } else {
            self.0.retain(|(n, _)| n != k);
        }
    }
}

/// `Number(value)` is finite, as JavaScript reads a string.
fn js_number_finite(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return true;
    }
    let lower = t.to_ascii_lowercase();
    if let Some(h) = lower.strip_prefix("0x").or_else(|| lower.strip_prefix("0o")).or_else(|| lower.strip_prefix("0b")) {
        return !h.is_empty() && h.chars().all(|c| c.is_ascii_hexdigit());
    }
    if lower.contains("inf") || lower.contains("nan") {
        return false;
    }
    t.parse::<f64>().is_ok_and(f64::is_finite)
}

impl State<'_> {
    fn filter(&mut self, children: Vec<Node>, depth: usize, in_local_form: bool, loops: usize) -> Result<Vec<Node>, String> {
        if depth > 64 {
            return Err("Darkmown markup is nested too deeply".into());
        }
        let mut out = Vec::new();
        for child in children {
            self.nodes += 1;
            if self.nodes > 25_000 {
                return Err("Darkmown preview has too many elements".into());
            }
            match child {
                Node::Text(t) => out.push(Node::Text(t)),
                Node::Element(e) => out.extend(self.element(e, depth, in_local_form, loops)?),
                _ => {}
            }
        }
        Ok(out)
    }

    fn element(&mut self, mut e: Element, depth: usize, in_local_form: bool, loops: usize) -> Result<Vec<Node>, String> {
        let trusted = self.trusted;
        // The compiler's skip link: no CSS or href in this host.
        if e.tag == "a" && e.get("href") == Some("#main") && e.get("class") == Some("wd-skip-link") && hast::text_of(&e.children) == "Skip to content" {
            return Ok(vec![]);
        }
        if e.tag == "script" {
            if e.get("type") == Some("application/json") && e.has("data-wd-state") {
                let seed = parse_json(&hast::text_of(&e.children));
                let ok = seed.as_ref().is_some_and(|s| matches!(s, Json::Obj(o) if o.iter().all(|(k, _)| safe_path(k) && !k.contains('.'))));
                match (ok, seed) {
                    (true, Some(seed)) => {
                        self.list_length = self.list_length.max(longest_list(&seed));
                        if trusted {
                            self.seeds.push(json::stringify(&seed).replace('<', "\\u003c"));
                        }
                        if e.attrs.iter().any(|(k, _)| k != "type" && k != "data-wd-state") {
                            self.removed = true;
                        }
                    }
                    _ => self.removed = true,
                }
            } else if !(e.get("type") == Some("module") && e.get("src") == Some("/__wd/runtime.js")) {
                self.removed = true;
            }
            return Ok(vec![]);
        }
        if e.tag == "img"
            && let Some(base) = self.picture_base
        {
            let Some(r) = e.get("src").and_then(darkmown_picture_ref) else {
                self.removed = true;
                return Ok(vec![]);
            };
            if e.attrs.iter().any(|(k, _)| {
                let k = k.to_ascii_lowercase();
                k.starts_with("on") || k == "style" || k == "srcset"
            }) {
                self.removed = true;
            }
            let mut attrs = vec![("src".to_string(), darkmown_picture_url(base, &r))];
            for key in ["alt", "title"] {
                if let Some(v) = e.get(key) {
                    attrs.push((key.to_string(), v.chars().take(10_000).collect()));
                }
            }
            e.attrs = attrs;
            e.children.clear();
            return Ok(vec![Node::Element(e)]);
        }
        // `:fetch` is for hosted Live Docs only; the Mac preview stays offline.
        if e.tag == "span" && e.has("data-wd-fetch") {
            self.removed = true;
            return Ok(vec![]);
        }
        if STRIP.contains(&e.tag.as_str()) {
            self.removed = true;
            return Ok(vec![]);
        }
        if e.tag == "template" {
            let known: Vec<&String> = self.template_markers.iter().filter(|m| e.has(m)).collect();
            let Some(body) = e.content.take() else {
                self.removed = true;
                return Ok(vec![]);
            };
            if known.len() != 1 {
                self.removed = true;
                return Ok(vec![]);
            }
            if !trusted {
                return Ok(vec![]);
            }
            let marker = known[0].clone();
            e.attrs = vec![(marker, String::new())];
            e.children.clear();
            e.content = Some(self.filter(body, depth + 1, in_local_form, loops)?);
            return Ok(vec![Node::Element(e)]);
        }
        let local_form = e.tag == "form"
            && trusted
            && e.get("data-wd-form").is_some_and(safe_path)
            && !["action", "method", "formaction", "enctype", "target"].iter().any(|k| e.has(k));
        if e.tag == "form" && !local_form {
            self.removed = true;
            return self.filter(e.children, depth + 1, false, loops);
        }
        if e.tag == "input" && !["text", "number", "range", "checkbox", "radio", "email", "url"].contains(&e.get("type").filter(|t| !t.is_empty()).unwrap_or("text")) {
            self.removed = true;
            return Ok(vec![]);
        }
        let mut next = Next::default();
        if local_form {
            next.set("data-wd-form", e.get("data-wd-form").unwrap());
        }
        let href = if self.links && e.tag == "a" { e.get("href").and_then(darkmown_link_target) } else { None };
        if let Some(h) = &href {
            next.set("href", h);
            next.set("target", "_blank");
            next.set("rel", "noopener noreferrer");
        }
        for key in ["title", "aria-label", "aria-hidden", "colspan", "rowspan"] {
            if let Some(v) = e.get(key) {
                next.set(key, v);
            }
        }
        let has_unsupported = e.attrs.iter().any(|(k, v)| {
            let lower = k.to_ascii_lowercase();
            (lower.starts_with("data-wd") && !self.runtime_attrs.contains(&lower))
                || ((lower.starts_with("on") || lower == "style" || lower.starts_with("src") || lower == "href" || lower == "poster" || lower == "action" || lower == "formaction" || lower == "ping")
                    && !(lower == "href" && (v == "#main" || href.is_some())))
        });
        if has_unsupported {
            self.removed = true;
        }
        if trusted {
            for m in &self.markers {
                if e.has(m) && !self.template_markers.contains(m) {
                    next.set(m, "");
                }
            }
            for key in ["data-wd-bind", "data-wd-path", "data-wd-loop", "data-wd-loop-item", "data-wd-loop-sort"] {
                match e.get(key) {
                    Some(v) if safe_path(v) => next.set(key, v),
                    Some(_) => self.removed = true,
                    None => {}
                }
            }
            match e.get("data-wd-if") {
                Some(v) if v.is_empty() || safe_path(v) => next.set("data-wd-if", v),
                Some(_) => self.removed = true,
                None => {}
            }
            for key in ["data-wd-if-expr", "data-wd-loop-where"] {
                if let Some(raw) = e.get(key) {
                    match parse_json(raw).filter(|ast| safe_ast(ast, 0, &mut 1_000)) {
                        Some(ast) => next.set(key, &json::stringify(&ast)),
                        None => self.removed = true,
                    }
                }
            }
            match e.get("data-wd-if-active") {
                Some(v @ ("true" | "false")) => next.set("data-wd-if-active", v),
                Some(_) => self.removed = true,
                None => {}
            }
            for key in ["data-wd-meta", "data-wd-each-meta"] {
                match e.get(key) {
                    Some(v) if LOOP_META.contains(&v) => next.set(key, v),
                    Some(_) => self.removed = true,
                    None => {}
                }
            }
            match e.get("data-wd-loop-sort-dir") {
                Some(v @ ("asc" | "desc")) => next.set("data-wd-loop-sort-dir", v),
                Some(_) => self.removed = true,
                None => {}
            }
            for key in ["data-wd-loop-limit", "data-wd-loop-offset"] {
                match e.get(key) {
                    Some(v) if (1..=6).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit()) => next.set(key, v),
                    Some(_) => self.removed = true,
                    None => {}
                }
            }
            match e.get("data-wd-loop-key") {
                Some(v) if js_len(v) <= 20_000 => next.set("data-wd-loop-key", v),
                Some(_) => self.removed = true,
                None => {}
            }
            if let Some(raw) = e.get("data-wd-fmt") {
                match safe_format(raw) {
                    Some(f) => next.set("data-wd-fmt", &f),
                    None => self.removed = true,
                }
            }
            if e.has("data-wd-computed") {
                let key = e.get("data-wd-computed-key").unwrap_or("");
                let ast = e.get("data-wd-computed-expr").and_then(parse_json);
                match ast {
                    Some(ast) if safe_path(key) && safe_ast(&ast, 0, &mut 1_000) && computed_growth_ok(key, &self.computed) => {
                        next.set("data-wd-computed", "");
                        next.set("data-wd-computed-key", key);
                        next.set("data-wd-computed-expr", &json::stringify(&ast));
                    }
                    _ => self.removed = true,
                }
            }
            if e.tag == "button" {
                if let Some(raw) = e.get("data-wd-actions") {
                    match parse_json(raw) {
                        Some(Json::Arr(actions)) if actions.len() <= 20 && actions.iter().all(safe_action) => {
                            next.set("data-wd-actions", &json::stringify(&Json::Arr(actions)));
                        }
                        _ => self.removed = true,
                    }
                } else if let Some(op) = e.get("data-wd-action") {
                    let mut action = vec![("op".to_string(), Json::Str(op.to_string()))];
                    match e.get("data-wd-target") {
                        Some(t) => action.push(("target".into(), Json::Str(t.to_string()))),
                        None => action.push(("target".into(), Json::Null)),
                    }
                    let mut value_ok = true;
                    if let Some(raw) = e.get("data-wd-value") {
                        match parse_json(raw) {
                            Some(v) => action.push(("value".into(), v)),
                            None => value_ok = false,
                        }
                    }
                    let action = Json::Obj(action);
                    if value_ok && safe_action(&action) {
                        next.set("data-wd-action", op);
                        next.set("data-wd-target", e.get("data-wd-target").unwrap_or(""));
                        if let Some(v) = action.get("value") {
                            next.set("data-wd-value", &json::stringify(v));
                        }
                    } else {
                        self.removed = true;
                    }
                }
            }
            if ["input", "textarea", "select"].contains(&e.tag.as_str())
                && let Some(b) = e.get("data-wd-bind-input")
                && safe_path(b)
            {
                next.set("data-wd-bind-input", b);
            }
        }
        if e.tag == "button" {
            let submit = in_local_form && e.get("type") == Some("submit");
            next.set("type", if submit { "submit" } else { "button" });
            let has_action = next.has("data-wd-action") || next.has("data-wd-actions");
            next.flag("disabled", e.has("disabled") || !trusted || (!submit && !has_action));
        }
        if ["input", "textarea", "select"].contains(&e.tag.as_str()) {
            if e.tag == "input" {
                next.set("type", e.get("type").filter(|t| !t.is_empty()).unwrap_or("text"));
            }
            let name = e.get("name");
            let local_field = in_local_form && name.is_some_and(|n| safe_path(n) && !n.contains('.') && !RESERVED_FORM_NAMES.contains(&n.to_ascii_lowercase().as_str()));
            if local_field {
                next.set("name", name.unwrap());
            } else if in_local_form && name.is_some() {
                self.removed = true;
            }
            let bound = next.has("data-wd-bind-input");
            next.flag("disabled", e.has("disabled") || !trusted || (!bound && !local_field));
            next.set("maxlength", "10000");
            for key in ["min", "max", "step"] {
                if let Some(v) = e.get(key)
                    && js_number_finite(v)
                {
                    next.set(key, v);
                }
            }
            for key in ["value", "placeholder"] {
                if let Some(v) = e.get(key) {
                    next.set(key, &v.chars().take(10_000).collect::<String>());
                }
            }
            if e.has("checked") {
                next.set("checked", "");
            }
        }
        if e.tag == "option" {
            next.set("value", &e.get("value").map(|v| v.chars().take(10_000).collect::<String>()).unwrap_or_default());
            if e.has("selected") {
                next.set("selected", "");
            }
        }
        if trusted && e.attrs.iter().any(|(k, _)| k.starts_with("data-wd") && !next.has(k)) {
            self.removed = true;
        }
        let inside_loop = loops + usize::from(next.has("data-wd-loop") || next.has("data-wd-loop-item"));
        self.loop_depth = self.loop_depth.max(inside_loop);
        let children = std::mem::take(&mut e.children);
        e.children = self.filter(children, depth + 1, in_local_form || local_form, inside_loop)?;
        e.attrs = next.0;
        let _ = Next::get;
        Ok(vec![Node::Element(e)])
    }
}

/// The preview schema (`rehype-sanitize` in security.ts).
fn schema(links: bool, pictures: bool) -> Schema {
    let mut tags: Vec<String> = TAGS.iter().map(|s| s.to_string()).collect();
    if pictures {
        tags.push("img".into());
    }
    let mut star = vec!["title", "ariaLabel", "ariaHidden", "colSpan", "rowSpan"];
    star.extend(runtime_attributes());
    let rules = |props: &[&str]| props.iter().map(|p| Rule::any(p)).collect::<Vec<_>>();
    let mut attributes = vec![
        ("*".to_string(), rules(&star)),
        ("button".into(), rules(&["type", "disabled"])),
        ("input".into(), rules(&["name", "type", "disabled", "maxLength", "min", "max", "step", "value", "placeholder", "checked"])),
        ("textarea".into(), rules(&["name", "disabled", "maxLength", "placeholder"])),
        ("select".into(), rules(&["name", "disabled"])),
        ("option".into(), rules(&["value", "selected"])),
    ];
    if links {
        attributes.push(("a".into(), rules(&["href", "target", "rel"])));
    }
    if pictures {
        attributes.push(("img".into(), rules(&["src", "alt", "title"])));
    }
    Schema {
        tag_names: tags,
        strip: vec![],
        attributes,
        ancestors: vec![],
        protocols: vec![("href", vec!["http", "https", "mailto"]), ("src", vec!["markie-asset"])],
        clobber: vec![],
        clobber_prefix: "",
        required: vec![],
    }
}

/// Parse inertly, then expose only offline, bounded runtime data.
pub fn sanitize_darkmown_body(body_html: &str, trusted: bool, options: &SanitizeOptions) -> Result<Sanitized, String> {
    if js_len(body_html) > 2_000_000 {
        return Err("Darkmown preview exceeds the safe rendering limit".into());
    }
    let picture_base = options.picture_base.as_deref().filter(|b| is_darkmown_picture_base(b));
    let tree = hast::parse_fragment(body_html);
    let mut computed = HashMap::new();
    collect(&tree, &mut computed);
    let mut state = State {
        trusted,
        links: options.links,
        picture_base,
        seeds: Vec::new(),
        removed: false,
        nodes: 0,
        list_length: 0.0,
        loop_depth: 0,
        computed,
        runtime_attrs: runtime_attributes().iter().map(|p| a(p)).collect(),
        markers: markers().iter().map(|p| a(p)).collect(),
        template_markers: TEMPLATE_MARKERS.iter().map(|p| a(p)).collect(),
    };
    let filtered = state.filter(tree, 0, false, 0)?;
    if state.list_length.powi(state.loop_depth as i32) > MAX_LOOP_ROWS {
        return Err("These nested loops could draw too many rows for an interactive preview. Your source remains available to edit and save.".into());
    }
    let clean = schema(state.links, picture_base.is_some()).sanitize(filtered);
    Ok(Sanitized {
        body_html: hast::to_html(&clean),
        seeds: state.seeds,
        warnings: if state.removed { vec![WARNING.to_string()] } else { vec![] },
    })
}
