//! hast-util-sanitize, ported for the two schemas Markie uses: the export
//! schema (`markdown-html.ts`, shared with the server's share renderer) and the
//! Darkmown preview schema (`darkmown/security.ts`).
//!
//! Semantics kept from the JavaScript:
//! - An element whose tag is not allowed is replaced by its children. One in
//!   `strip` goes with everything inside it. Comments and doctypes go.
//! - `ancestors` unwraps table parts that are not inside a table.
//! - Attributes are looked up on the tag first and on `*` second. A rule with
//!   values keeps only those values (each class token for `class`).
//! - URL attributes must be relative or use a listed protocol.
//! - `clobber` attributes get the prefix, always (so an id remark already
//!   prefixed is prefixed twice, as in Electron).
//! - `required` attributes are forced onto their tag.
//!
//! Rules are written with hast property names (`className`, `ariaHidden`,
//! `dataWdBind`) like the TypeScript, and compared to HTML attribute names
//! through [`attr_name`].

use crate::hast::{Element, Node, Space};

#[derive(Clone, Debug)]
pub enum Values {
    Any,
    /// Only these values (class: these tokens).
    Only(Vec<&'static str>),
    /// A class token or value that starts with this prefix and has more after it.
    Prefix(&'static str),
}

#[derive(Clone, Debug)]
pub struct Rule {
    pub prop: String,
    pub values: Values,
}

impl Rule {
    pub fn any(prop: &str) -> Self {
        Self { prop: prop.to_string(), values: Values::Any }
    }
    pub fn only(prop: &str, values: &[&'static str]) -> Self {
        Self { prop: prop.to_string(), values: Values::Only(values.to_vec()) }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Schema {
    pub tag_names: Vec<String>,
    pub strip: Vec<String>,
    /// Per tag, and `*` for every tag.
    pub attributes: Vec<(String, Vec<Rule>)>,
    pub ancestors: Vec<(&'static str, Vec<&'static str>)>,
    pub protocols: Vec<(&'static str, Vec<&'static str>)>,
    pub clobber: Vec<&'static str>,
    pub clobber_prefix: &'static str,
    pub required: Vec<(&'static str, Vec<(&'static str, &'static str)>)>,
}

/// A hast property name as the attribute it is written as.
pub fn attr_name(prop: &str, space: Space) -> String {
    match prop {
        "className" => return "class".into(),
        "htmlFor" => return "for".into(),
        "acceptCharset" => return "accept-charset".into(),
        "httpEquiv" => return "http-equiv".into(),
        _ => {}
    }
    if let Some(rest) = prop.strip_prefix("aria")
        && rest.starts_with(|c: char| c.is_ascii_uppercase())
    {
        return format!("aria-{}", rest.to_ascii_lowercase());
    }
    if let Some(rest) = prop.strip_prefix("data")
        && rest.starts_with(|c: char| c.is_ascii_uppercase() || c.is_ascii_digit())
    {
        let mut out = String::from("data");
        for c in rest.chars() {
            if c.is_ascii_uppercase() {
                out.push('-');
                out.push(c.to_ascii_lowercase());
            } else {
                out.push(c);
            }
        }
        return out;
    }
    if space == Space::Html { prop.to_ascii_lowercase() } else { prop.to_string() }
}

/// The hast property name for an HTML attribute (the inverse of [`attr_name`]
/// for the names the schemas use).
pub fn prop_name(attr: &str) -> String {
    match attr {
        "class" => return "className".into(),
        "for" => return "htmlFor".into(),
        _ => {}
    }
    if let Some(rest) = attr.strip_prefix("data-") {
        let mut out = String::from("data");
        let mut upper = true;
        for c in rest.chars() {
            if c == '-' {
                upper = true;
            } else if upper {
                out.push(c.to_ascii_uppercase());
                upper = false;
            } else {
                out.push(c);
            }
        }
        return out;
    }
    attr.to_string()
}

impl Schema {
    fn rules<'a>(&'a self, tag: &str) -> Option<&'a Vec<Rule>> {
        self.attributes.iter().find(|(t, _)| t == tag).map(|(_, r)| r)
    }

    fn allowed(&self, tag: &str) -> bool {
        self.tag_names.iter().any(|t| t == tag)
    }

    fn find<'a>(&'a self, tag: &str, attr: &str, space: Space) -> Option<&'a Rule> {
        let hit = |rules: &'a Vec<Rule>| rules.iter().find(|r| attr_name(&r.prop, space).eq_ignore_ascii_case(attr) && (space == Space::Html || attr_name(&r.prop, space) == attr));
        self.rules(tag).and_then(hit).or_else(|| self.rules("*").and_then(hit))
    }

    pub fn sanitize(&self, nodes: Vec<Node>) -> Vec<Node> {
        let mut stack = Vec::new();
        self.nodes(nodes, &mut stack)
    }

    fn nodes(&self, nodes: Vec<Node>, stack: &mut Vec<String>) -> Vec<Node> {
        let mut out = Vec::new();
        for node in nodes {
            match node {
                Node::Text(t) => out.push(Node::Text(t)),
                Node::Raw(r) => out.push(Node::Raw(r)),
                Node::Comment(_) => {}
                Node::Element(e) => {
                    if self.strip.iter().any(|s| *s == e.tag) {
                        continue;
                    }
                    let ancestors_ok = self
                        .ancestors
                        .iter()
                        .find(|(t, _)| *t == e.tag)
                        .is_none_or(|(_, need)| stack.iter().any(|s| need.contains(&s.as_str())));
                    if !self.allowed(&e.tag) || !ancestors_ok {
                        stack.push(e.tag.clone());
                        let children = self.nodes(e.children, stack);
                        stack.pop();
                        out.extend(children);
                        continue;
                    }
                    let tag = e.tag.clone();
                    let attrs = self.attrs(&tag, e.space, e.attrs);
                    stack.push(tag.clone());
                    let children = self.nodes(e.children, stack);
                    let content = e.content.map(|c| self.nodes(c, stack));
                    stack.pop();
                    out.push(Node::Element(Element { tag, space: e.space, attrs, children, content }));
                }
            }
        }
        out
    }

    fn attrs(&self, tag: &str, space: Space, attrs: Vec<(String, String)>) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = Vec::new();
        for (name, value) in attrs {
            let Some(rule) = self.find(tag, &name, space) else { continue };
            let value = match &rule.values {
                Values::Any => Some(value),
                Values::Only(allowed) => {
                    if name == "class" {
                        let kept: Vec<&str> = value.split_ascii_whitespace().filter(|t| allowed.contains(t)).collect();
                        (!kept.is_empty()).then(|| kept.join(" "))
                    } else if allowed.contains(&value.as_str()) || (allowed.contains(&"true") && (value.is_empty() || value.eq_ignore_ascii_case(&name))) {
                        Some(value)
                    } else {
                        None
                    }
                }
                Values::Prefix(prefix) => {
                    if name == "class" {
                        let kept: Vec<&str> = value.split_ascii_whitespace().filter(|t| t.len() > prefix.len() && t.starts_with(prefix)).collect();
                        (!kept.is_empty()).then(|| kept.join(" "))
                    } else {
                        (value.len() > prefix.len() && value.starts_with(prefix)).then_some(value)
                    }
                }
            };
            let Some(mut value) = value else { continue };
            let prop = rule.prop.as_str();
            if let Some((_, protocols)) = self.protocols.iter().find(|(p, _)| *p == prop)
                && !safe_protocol(&value, protocols)
            {
                continue;
            }
            if self.clobber.contains(&prop) {
                value = format!("{}{}", self.clobber_prefix, value);
            }
            out.push((name, value));
        }
        if let Some((_, required)) = self.required.iter().find(|(t, _)| *t == tag) {
            for (name, value) in required {
                if !out.iter().any(|(k, _)| k == name) {
                    out.push((name.to_string(), value.to_string()));
                }
            }
        }
        out
    }
}

/// hast-util-sanitize's protocol check: relative URLs pass; otherwise the
/// scheme (case as written) must be listed.
pub fn safe_protocol(value: &str, protocols: &[&str]) -> bool {
    let colon = value.find(':');
    let q = value.find('?');
    let hash = value.find('#');
    let slash = value.find('/');
    match colon {
        None => true,
        Some(c) if slash.is_some_and(|s| c > s) || q.is_some_and(|s| c > s) || hash.is_some_and(|s| c > s) => true,
        Some(c) => protocols.iter().any(|p| p.len() == c && &value[..c] == *p),
    }
}

const ARIA: &[&str] = &["ariaDescribedBy", "ariaLabel", "ariaLabelledBy"];

fn rules(props: &[&str]) -> Vec<Rule> {
    props.iter().map(|p| Rule::any(p)).collect()
}

/// GitHub's schema as hast-util-sanitize ships it (`defaultSchema`).
pub fn github_schema() -> Schema {
    let all = [
        "abbr", "accept", "acceptCharset", "accessKey", "action", "align", "alt", "axis", "border", "cellPadding", "cellSpacing",
        "char", "charOff", "charSet", "checked", "clear", "colSpan", "color", "cols", "compact", "coords", "dateTime", "dir",
        "encType", "frame", "hSpace", "headers", "height", "hrefLang", "htmlFor", "id", "isMap", "itemProp", "label", "lang",
        "maxLength", "media", "method", "multiple", "name", "noHref", "noShade", "noWrap", "open", "prompt", "readOnly", "rev",
        "rowSpan", "rows", "rules", "scope", "selected", "shape", "size", "span", "start", "summary", "tabIndex", "title",
        "useMap", "vAlign", "value", "width",
    ];
    let with_aria = |extra: Vec<Rule>| -> Vec<Rule> {
        let mut r = rules(ARIA);
        r.extend(extra);
        r
    };
    let attributes = vec![
        ("a".to_string(), with_aria(vec![Rule::any("dataFootnoteBackref"), Rule::any("dataFootnoteRef"), Rule::only("className", &["data-footnote-backref"]), Rule::any("href")])),
        ("blockquote".into(), rules(&["cite"])),
        ("code".into(), vec![Rule { prop: "className".into(), values: Values::Prefix("language-") }]),
        ("del".into(), rules(&["cite"])),
        ("div".into(), rules(&["itemScope", "itemType"])),
        ("dl".into(), rules(ARIA)),
        ("h2".into(), vec![Rule::only("className", &["sr-only"])]),
        ("img".into(), with_aria(rules(&["longDesc", "src"]))),
        ("input".into(), vec![Rule::only("disabled", &["true"]), Rule::only("type", &["checkbox"])]),
        ("ins".into(), rules(&["cite"])),
        ("li".into(), vec![Rule::only("className", &["task-list-item"])]),
        ("ol".into(), with_aria(vec![Rule::only("className", &["contains-task-list"])])),
        ("q".into(), rules(&["cite"])),
        ("section".into(), vec![Rule::any("dataFootnotes"), Rule::only("className", &["footnotes"])]),
        ("source".into(), rules(&["srcSet"])),
        ("summary".into(), rules(ARIA)),
        ("table".into(), rules(ARIA)),
        ("ul".into(), with_aria(vec![Rule::only("className", &["contains-task-list"])])),
        ("*".into(), rules(&all)),
    ];
    let tags = [
        "a", "b", "blockquote", "br", "code", "dd", "del", "details", "div", "dl", "dt", "em", "h1", "h2", "h3", "h4", "h5", "h6",
        "hr", "i", "img", "input", "ins", "kbd", "li", "ol", "p", "picture", "pre", "q", "rp", "rt", "ruby", "s", "samp",
        "section", "source", "span", "strike", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead",
        "tr", "tt", "ul", "var",
    ];
    Schema {
        tag_names: tags.iter().map(|t| t.to_string()).collect(),
        strip: vec!["script".into()],
        attributes,
        ancestors: vec![
            ("tbody", vec!["table"]),
            ("td", vec!["table"]),
            ("th", vec!["table"]),
            ("thead", vec!["table"]),
            ("tfoot", vec!["table"]),
            ("tr", vec!["table"]),
        ],
        protocols: vec![
            ("cite", vec!["http", "https"]),
            ("href", vec!["http", "https", "irc", "ircs", "mailto", "xmpp"]),
            ("longDesc", vec!["http", "https"]),
            ("src", vec!["http", "https"]),
        ],
        clobber: vec!["ariaDescribedBy", "ariaLabelledBy", "id", "name"],
        clobber_prefix: "user-content-",
        required: vec![("input", vec![("disabled", ""), ("type", "checkbox")])],
    }
}

const MATHML: &[&str] = &[
    "math", "semantics", "annotation", "mrow", "mi", "mo", "mn", "ms", "mtext", "mspace", "msup", "msub", "msubsup", "mfrac",
    "msqrt", "mroot", "munder", "mover", "munderover", "mtable", "mtr", "mtd", "mpadded", "mphantom", "menclose", "mstyle",
    "mglyph",
];
const SVG: &[&str] = &["svg", "path", "line", "g", "defs", "use", "rect", "polyline"];
const MEDIA: &[&str] = &["video", "audio", "source"];

/// The schema `markdown-html.ts` (and the server's share renderer) uses.
pub fn export_schema() -> Schema {
    let mut s = github_schema();
    s.protocols.iter_mut().find(|(p, _)| *p == "src").unwrap().1.push("data");
    s.strip.push("style".into());
    for t in ["span", "div", "mark", "u"].iter().chain(MATHML).chain(SVG).chain(MEDIA) {
        s.tag_names.push(t.to_string());
    }
    let set = |s: &mut Schema, tag: &str, r: Vec<Rule>| {
        if let Some(slot) = s.attributes.iter_mut().find(|(t, _)| t == tag) {
            slot.1 = r;
        } else {
            s.attributes.push((tag.to_string(), r));
        }
    };
    let star = s.attributes.iter_mut().find(|(t, _)| t == "*").unwrap();
    star.1.extend(rules(&["className", "ariaHidden", "ariaLabel"]));
    set(&mut s, "span", rules(&["className", "style", "ariaHidden"]));
    set(&mut s, "div", rules(&["className", "style"]));
    for tag in ["mark", "p", "h1", "h2", "h3", "h4", "h5", "h6"] {
        set(&mut s, tag, rules(&["style"]));
    }
    set(&mut s, "code", rules(&["className"]));
    set(&mut s, "pre", rules(&["className"]));
    set(&mut s, "math", rules(&["xmlns", "display"]));
    set(&mut s, "annotation", rules(&["encoding"]));
    set(&mut s, "svg", rules(&["xmlns", "width", "height", "viewBox", "preserveAspectRatio", "style", "ariaHidden"]));
    set(&mut s, "path", rules(&["d"]));
    set(&mut s, "line", rules(&["x1", "y1", "x2", "y2"]));
    set(&mut s, "video", rules(&["src", "controls", "preload", "width", "height", "poster"]));
    set(&mut s, "audio", rules(&["src", "controls", "preload"]));
    set(&mut s, "source", rules(&["src", "type"]));
    s
}

/// `rehype-contain-styles.ts`: drop `position` other than static or relative,
/// and any `z-index`. A style with a CSS escape or comment goes whole.
pub fn contain_style(style: &str) -> Option<String> {
    if style.contains('\\') || style.contains("/*") {
        return None;
    }
    let unsafe_decl = |decl: &str| {
        let Some(colon) = decl.find(':') else { return false };
        let name = decl[..colon].trim().to_ascii_lowercase();
        let value = decl[colon + 1..].trim().to_ascii_lowercase();
        if name == "z-index" {
            return true;
        }
        name == "position" && !safe_position(&value)
    };
    let decls: Vec<&str> = style.split(';').collect();
    if !decls.iter().any(|d| unsafe_decl(d)) {
        return Some(style.to_string());
    }
    let kept: Vec<&str> = decls.iter().map(|d| d.trim()).filter(|d| !d.is_empty() && !unsafe_decl(d)).collect();
    (!kept.is_empty()).then(|| kept.join("; "))
}

fn safe_position(value: &str) -> bool {
    let v = value.trim();
    let (word, rest) = match v.find(|c: char| c.is_whitespace() || c == '!') {
        Some(i) => (&v[..i], v[i..].trim()),
        None => (v, ""),
    };
    if word != "static" && word != "relative" {
        return false;
    }
    if rest.is_empty() {
        return true;
    }
    rest.strip_prefix('!').is_some_and(|r| r.trim() == "important")
}

pub fn contain_styles(nodes: &mut [Node]) {
    crate::hast::walk_mut(nodes, &mut |e| {
        if let Some(style) = e.get("style").map(str::to_string) {
            match contain_style(&style) {
                Some(safe) => e.set("style", &safe),
                None => {
                    e.remove("style");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contain_matches_the_typescript() {
        assert_eq!(contain_style("position: fixed; inset: 0; z-index: 99; color: #16a34a").as_deref(), Some("inset: 0; color: #16a34a"));
        assert_eq!(contain_style("position: relative !important").as_deref(), Some("position: relative !important"));
        assert_eq!(contain_style("color: red").as_deref(), Some("color: red"));
        assert_eq!(contain_style("pos\\ition: fixed"), None);
        assert_eq!(contain_style("z-index: 1"), None);
    }

    #[test]
    fn protocols() {
        assert!(safe_protocol("pic.png", &["http"]));
        assert!(safe_protocol("a/b:c", &["http"]));
        assert!(!safe_protocol("javascript:alert(1)", &["http", "https"]));
        assert!(safe_protocol("https://x", &["http", "https"]));
        assert!(!safe_protocol("HTTPS://x", &["http", "https"]));
    }

    #[test]
    fn names_round_trip() {
        assert_eq!(attr_name("ariaDescribedBy", Space::Html), "aria-describedby");
        assert_eq!(attr_name("dataWdIfTrue", Space::Html), "data-wd-if-true");
        assert_eq!(prop_name("data-wd-if-true"), "dataWdIfTrue");
        assert_eq!(attr_name("viewBox", Space::Svg), "viewBox");
        assert_eq!(attr_name("colSpan", Space::Html), "colspan");
    }
}
