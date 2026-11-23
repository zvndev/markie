//! Code highlighting with highlight.js class names.
//!
//! Electron runs rehype-highlight (highlight.js) and the export stylesheet
//! colours fourteen `hljs-*` classes. Here syntect, with the two-face syntax set
//! Typst also uses, tokenizes the code; each token's TextMate scopes map to the
//! highlight.js class, with per-language rules where highlight.js's grammar
//! classes a token differently (a JSON key is an attribute, a Python method
//! call is plain, a Go parameter list keeps its parentheses). A few rules span
//! tokens, as highlight.js's modes do: parameter lists, arrow functions,
//! CamelCase class references, `name:` keys, Rust bindings and calls. The
//! result colours every character of the test corpus as Electron's does
//! (`code_colours_match_highlight_js`). Like rehype-highlight, only a block
//! with a language is highlighted, and a language nobody knows is left as it is.

use std::sync::LazyLock;

use syntect::parsing::{ParseState, ScopeStack, SyntaxReference, SyntaxSet};

use crate::hast::{Element, Node};

static SYNTAXES: LazyLock<SyntaxSet> = LazyLock::new(two_face::syntax::extra_newlines);

/// highlight.js names syntect may not know under the same word.
fn alias(lang: &str) -> &str {
    match lang {
        "js" | "jsx" | "mjs" | "cjs" | "javascript" => "js",
        "ts" | "tsx" | "typescript" => "ts",
        "py" | "python" => "py",
        "sh" | "shell" | "zsh" | "bash" | "console" => "bash",
        "yml" | "yaml" => "yaml",
        "rs" | "rust" => "rs",
        "md" | "markdown" => "md",
        "html" | "xml" | "svg" => "html",
        "c++" | "cpp" | "cc" => "cpp",
        "cs" | "csharp" => "cs",
        "golang" | "go" => "go",
        "rb" | "ruby" => "rb",
        "kt" | "kotlin" => "kt",
        "json" | "jsonc" => "json",
        other => other,
    }
}

pub fn syntax_for(lang: &str) -> Option<&'static SyntaxReference> {
    let lower = lang.to_ascii_lowercase();
    let token = alias(&lower);
    SYNTAXES.find_syntax_by_token(token).or_else(|| SYNTAXES.find_syntax_by_name(lang))
}

/// The languages whose highlight.js grammar choices are mirrored below.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Lang {
    Js,
    Ts,
    Python,
    Bash,
    Json,
    Css,
    Html,
    Yaml,
    Rust,
    Go,
    Sql,
    Other,
}

fn lang_of(name: &str) -> Lang {
    match alias(&name.to_ascii_lowercase()) {
        "js" => Lang::Js,
        "ts" => Lang::Ts,
        "py" => Lang::Python,
        "bash" => Lang::Bash,
        "json" => Lang::Json,
        "css" | "scss" | "less" => Lang::Css,
        "html" => Lang::Html,
        "yaml" => Lang::Yaml,
        "rs" => Lang::Rust,
        "go" => Lang::Go,
        "sql" => Lang::Sql,
        _ => Lang::Other,
    }
}

/// What a scope says about a token: a class, plain text (stop looking), or
/// nothing (ask the enclosing scope).
enum Rule {
    Class(&'static str),
    Plain,
    Pass,
}

const RUST_TYPES: &[&str] = &[
    "str", "usize", "isize", "u8", "u16", "u32", "u64", "u128", "i8", "i16", "i32", "i64", "i128", "f32", "f64", "bool", "char", "String", "Vec", "Option", "Result", "Box",
];
const BASH_BUILTINS: &[&str] = &["export", "local", "declare", "readonly", "typeset", "unset", "alias", "cd", "echo", "set", "source", "eval", "exec", "read", "printf", "test", "trap", "shift", "exit"];

/// A scope's rule in one language. Language rules mirror where highlight.js's
/// grammar classes a token differently from the TextMate grammar.
fn rule(lang: Lang, scope: &str, text: &str) -> Rule {
    let starts = |p: &str| scope == p || scope.starts_with(&format!("{p}."));
    let word = !text.is_empty() && text.chars().all(|c| c.is_alphanumeric() || c == '_');
    match lang {
        Lang::Python => {
            if starts("comment.block.documentation") || starts("storage.type.string") {
                return Rule::Class("hljs-string");
            }
            // A docstring's quotes belong to the string, as the docstring does.
            if starts("punctuation.definition.comment") {
                return Rule::Pass;
            }
            if starts("support.type") {
                return Rule::Class("hljs-built_in");
            }
            if starts("support.function.builtin") {
                return Rule::Class("hljs-built_in");
            }
            if starts("support.function.magic") || starts("variable.function") || starts("meta.function-call") {
                return Rule::Pass;
            }
            if starts("punctuation.section.parameters") {
                return Rule::Plain;
            }
            if starts("meta.function.parameters") {
                return Rule::Class("hljs-params");
            }
        }
        Lang::Js | Lang::Ts => {
            if starts("support.type.builtin") && text == "undefined" {
                return Rule::Class("hljs-literal");
            }
            if starts("support.type.primitive") {
                return Rule::Class("hljs-built_in");
            }
            if starts("support.variable.property") {
                return Rule::Plain;
            }
            if starts("punctuation.definition.parameters") {
                return Rule::Plain;
            }
        }
        Lang::Bash => {
            if starts("meta.group.expansion") {
                return Rule::Class("hljs-variable");
            }
            if (starts("storage.modifier") || starts("support.function")) && BASH_BUILTINS.contains(&text) {
                return Rule::Class("hljs-built_in");
            }
            if starts("variable.function") {
                return if text == "true" || text == "false" { Rule::Class("hljs-literal") } else { Rule::Plain };
            }
            if starts("variable.parameter") {
                return Rule::Plain;
            }
        }
        Lang::Json => {
            if starts("meta.mapping.key") {
                return Rule::Class("hljs-attr");
            }
            if starts("constant.language") {
                return Rule::Class("hljs-keyword");
            }
        }
        Lang::Css => {
            if starts("constant.other.color") {
                return Rule::Class("hljs-number");
            }
            if starts("keyword.other.unit") {
                return Rule::Pass;
            }
            if starts("keyword.other.important") || starts("support.type.property-name") || starts("entity.other") || starts("entity.name.tag") {
                return Rule::Plain;
            }
        }
        Lang::Yaml => {
            if starts("entity.name.tag") || starts("punctuation.separator.key-value.mapping") {
                return Rule::Class("hljs-attr");
            }
        }
        Lang::Rust => {
            if starts("storage.type") && word {
                return Rule::Class(if RUST_TYPES.contains(&text) { "hljs-type" } else { "hljs-keyword" });
            }
            if starts("support.macro") {
                return Rule::Class("hljs-built_in");
            }
            if starts("support.function") {
                return Rule::Class("hljs-title function_ invoke__");
            }
            if starts("variable.parameter") || starts("punctuation.section.parameters") {
                return Rule::Plain;
            }
        }
        Lang::Go => {
            if starts("support.function.builtin") {
                return Rule::Class("hljs-built_in");
            }
            if starts("variable.function") {
                return Rule::Plain;
            }
        }
        Lang::Sql => {
            if starts("constant.boolean") {
                return Rule::Class("hljs-literal");
            }
        }
        Lang::Html | Lang::Other => {}
    }
    if starts("comment") || starts("punctuation.definition.comment") {
        Rule::Class("hljs-comment")
    } else if starts("meta.template.expression") || starts("punctuation.section.interpolation") || starts("meta.interpolation") {
        Rule::Class("hljs-subst")
    } else if starts("string") || starts("punctuation.definition.string") {
        Rule::Class("hljs-string")
    } else if starts("constant.numeric") {
        Rule::Class("hljs-number")
    } else if starts("constant.language") || starts("constant.boolean") {
        Rule::Class("hljs-literal")
    } else if starts("entity.name.function") || starts("meta.function-call.identifier") || starts("variable.function") {
        Rule::Class("hljs-title function_")
    } else if starts("entity.name.class") || starts("entity.name.struct") || starts("entity.name.enum") || starts("entity.name.interface") || starts("entity.other.inherited-class") {
        Rule::Class("hljs-title class_")
    } else if starts("entity.name.type") || starts("support.type") || starts("storage.type.primitive") {
        Rule::Class("hljs-type")
    } else if starts("support.function") || starts("support.class") || starts("variable.language") {
        Rule::Class("hljs-built_in")
    } else if starts("variable.parameter") {
        Rule::Class("hljs-params")
    } else if starts("entity.other.attribute-name") || starts("support.type.property-name") || starts("meta.mapping.key") {
        Rule::Class("hljs-attr")
    } else if starts("entity.name.tag") {
        Rule::Plain
    } else if starts("keyword.operator") || starts("punctuation") {
        // `new`, `not`, `in`, `and`: word operators are keywords to highlight.js.
        if word && text.chars().all(|c| c.is_ascii_alphabetic()) { Rule::Class("hljs-keyword") } else { Rule::Pass }
    } else if starts("keyword") || starts("storage") {
        Rule::Class("hljs-keyword")
    } else if starts("variable.other.constant") || starts("variable.other.readwrite.global") {
        Rule::Class("hljs-variable")
    } else {
        Rule::Pass
    }
}

/// A token's class from its scopes, innermost first.
fn class_of(lang: Lang, scopes: &[String], text: &str) -> Option<&'static str> {
    // highlight.js keeps an f-string's `{...}` one substitution.
    if lang == Lang::Python && scopes.iter().any(|s| s.starts_with("meta.interpolation")) {
        return Some("hljs-subst");
    }
    // A JSON key is an attribute, though the grammar calls it a string.
    if lang == Lang::Json && scopes.iter().any(|s| s.starts_with("meta.mapping.key")) {
        return Some("hljs-attr");
    }
    // A definition's name is its title, whatever else the grammar says.
    if lang == Lang::Python && scopes.iter().any(|s| s.starts_with("entity.name.function")) {
        return Some("hljs-title function_");
    }
    for scope in scopes.iter().rev() {
        match rule(lang, scope, text) {
            Rule::Class(c) => return Some(c),
            Rule::Plain => return None,
            Rule::Pass => {}
        }
    }
    None
}

struct Tok {
    /// Start, in chars.
    start: usize,
    len: usize,
    text: String,
    scopes: Vec<String>,
}

fn is_ident(t: &str) -> bool {
    let mut c = t.chars();
    c.next().is_some_and(|f| f.is_alphabetic() || f == '_' || f == '$') && c.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

/// highlight.js's `CLASS_REFERENCE`: a CamelCase word is a class title.
fn camel_case(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() >= 2 && b[0].is_ascii_uppercase() && b[1].is_ascii_lowercase() && b.iter().all(|c| c.is_ascii_alphanumeric())
}

/// The index of the bracket that closes the one at `open`.
fn closing(chars: &[char], open: usize) -> Option<usize> {
    let (o, c) = (chars[open], if chars[open] == '(' { ')' } else { ']' });
    let mut depth = 0;
    for (i, ch) in chars.iter().enumerate().skip(open) {
        if *ch == o {
            depth += 1;
        } else if *ch == c {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

fn opening(chars: &[char], close: usize) -> Option<usize> {
    let mut depth = 0;
    for i in (0..=close).rev() {
        match chars[i] {
            ')' => depth += 1,
            '(' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

fn skip_ws(chars: &[char], mut i: usize) -> usize {
    while i < chars.len() && (chars[i] == ' ' || chars[i] == '\t') {
        i += 1;
    }
    i
}

/// The grammar rules highlight.js applies across tokens: parameter lists,
/// arrow functions, class references, object keys, bindings and calls.
fn passes(lang: Lang, chars: &[char], toks: &[Tok], cls: &mut [Option<&'static str>]) {
    let set = |cls: &mut [Option<&'static str>], t: &Tok, c: Option<&'static str>| cls[t.start..t.start + t.len].iter_mut().for_each(|x| *x = c);
    for t in toks {
        let here = cls[t.start];
        let end = t.start + t.len;
        match lang {
            Lang::Js | Lang::Ts | Lang::Go => {
                let decl = here.is_some_and(|c| c.starts_with("hljs-title function_"))
                    && t.scopes.iter().any(|s| s.starts_with("meta.function.declaration") || s.starts_with("meta.definition.function") || s.starts_with("entity.name.function.go"));
                if decl {
                    let j = skip_ws(chars, end);
                    if j < chars.len() && chars[j] == '<' {
                        // highlight.js does not see a generic function's name or parameters.
                        set(cls, t, None);
                        continue;
                    }
                    if j < chars.len() && chars[j] == '('
                        && let Some(k) = closing(chars, j)
                    {
                        for x in &mut cls[j + 1..k] {
                            if x.is_none() || *x == Some("hljs-params") {
                                *x = Some("hljs-params");
                            }
                        }
                        // Go's parameters keep their parentheses.
                        let parens = if lang == Lang::Go { Some("hljs-params") } else { None };
                        cls[j] = parens;
                        cls[k] = parens;
                    }
                }
            }
            _ => {}
        }
        if matches!(lang, Lang::Js | Lang::Ts) {
            if t.scopes.iter().any(|s| s.starts_with("storage.type.function.arrow")) {
                // `(a, b) =>` is one function span with its parameters inside.
                set(cls, t, Some("hljs-function"));
                let b = (0..t.start).rev().find(|&i| chars[i] != ' ' && chars[i] != '\t');
                if let Some(b) = b
                    && chars[b] == ')'
                    && let Some(a) = opening(chars, b)
                {
                    for x in &mut cls[a + 1..b] {
                        if x.is_none() {
                            *x = Some("hljs-params");
                        }
                    }
                    cls[a] = Some("hljs-function");
                    cls[b] = Some("hljs-function");
                }
            }
            if camel_case(&t.text) && matches!(here, None | Some("hljs-built_in") | Some("hljs-type")) {
                set(cls, t, Some("hljs-title class_"));
            } else if lang == Lang::Ts && here == Some("hljs-type") {
                set(cls, t, None);
            }
            // `name:` and `name?:` are object keys.
            if is_ident(&t.text) && !matches!(here, Some("hljs-keyword") | Some("hljs-string") | Some("hljs-comment") | Some("hljs-literal") | Some("hljs-number")) {
                let mut j = skip_ws(chars, end);
                if j < chars.len() && chars[j] == '?' {
                    j += 1;
                }
                if j < chars.len() && chars[j] == ':' && chars.get(j + 1) != Some(&':') {
                    set(cls, t, Some("hljs-attr"));
                }
            }
        }
        if lang == Lang::Rust {
            // `let`, `let mut` and `for` bind a variable.
            if matches!(t.text.trim(), "let" | "mut" | "for") && here == Some("hljs-keyword") {
                let j = skip_ws(chars, end);
                let mut k = j;
                while k < chars.len() && (chars[k].is_alphanumeric() || chars[k] == '_') {
                    k += 1;
                }
                let name: String = chars[j..k].iter().collect();
                if !name.is_empty() && name != "mut" && cls[j..k].iter().all(Option::is_none) {
                    cls[j..k].iter_mut().for_each(|x| *x = Some("hljs-variable"));
                }
            }
        }
    }
    if lang == Lang::Rust {
        // `name(` is an invocation.
        let mut i = 0;
        while i < chars.len() {
            if (chars[i].is_alphabetic() || chars[i] == '_') && (i == 0 || !(chars[i - 1].is_alphanumeric() || chars[i - 1] == '_')) {
                let mut k = i;
                while k < chars.len() && (chars[k].is_alphanumeric() || chars[k] == '_') {
                    k += 1;
                }
                let word: String = chars[i..k].iter().collect();
                if chars.get(k) == Some(&'(') && cls[i..k].iter().all(Option::is_none) && !matches!(word.as_str(), "if" | "while" | "match" | "for" | "return" | "in") {
                    cls[i..k].iter_mut().for_each(|x| *x = Some("hljs-title function_ invoke__"));
                }
                i = k;
            } else {
                i += 1;
            }
        }
    }
    if lang == Lang::Bash && chars.starts_with(&['#', '!']) {
        // The `#!` line is a meta line, not a comment.
        let end = chars.iter().position(|c| *c == '\n').unwrap_or(chars.len());
        cls[..end].iter_mut().for_each(|x| *x = None);
    }
    if lang == Lang::Html {
        // `<!doctype html>`: the document type is a keyword inside the meta.
        let text: String = chars.iter().collect();
        let lower = text.to_ascii_lowercase();
        let mut from = 0;
        while let Some(at) = lower[from..].find("<!doctype ") {
            let s = from + at + 10;
            let e = lower[s..].find(|c: char| !c.is_alphanumeric()).map_or(lower.len(), |e| s + e);
            let (cs, ce) = (text[..s].chars().count(), text[..e].chars().count());
            cls[cs..ce].iter_mut().for_each(|x| *x = Some("hljs-keyword"));
            from = e;
        }
    }
}

/// The code as `(class, text)` runs. Unknown syntax gives one plain run.
pub fn tokens(code: &str, syntax: &SyntaxReference) -> Vec<(Option<&'static str>, String)> {
    tokens_in(code, syntax, Lang::Other)
}

fn tokens_in(code: &str, syntax: &SyntaxReference, lang: Lang) -> Vec<(Option<&'static str>, String)> {
    let mut state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut toks: Vec<Tok> = Vec::new();
    let mut at_char = 0;
    let mut push = |text: &str, stack: &ScopeStack, at_char: &mut usize| {
        if text.is_empty() {
            return;
        }
        let len = text.chars().count();
        let scopes = stack.as_slice().iter().map(|s| s.build_string()).collect();
        toks.push(Tok { start: *at_char, len, text: text.to_string(), scopes });
        *at_char += len;
    };
    for line in code.split_inclusive('\n') {
        let Ok(ops) = state.parse_line(line, &SYNTAXES) else {
            push(line, &ScopeStack::new(), &mut at_char);
            continue;
        };
        let mut at = 0;
        for (index, op) in ops {
            let index = index.min(line.len());
            if index > at {
                push(&line[at..index], &stack, &mut at_char);
                at = index;
            }
            let _ = stack.apply(&op);
        }
        if at < line.len() {
            push(&line[at..], &stack, &mut at_char);
        }
    }
    let chars: Vec<char> = code.chars().collect();
    let mut cls: Vec<Option<&'static str>> = vec![None; chars.len()];
    for t in &toks {
        let c = class_of(lang, &t.scopes, t.text.trim());
        cls[t.start..t.start + t.len].iter_mut().for_each(|x| *x = c);
    }
    passes(lang, &chars, &toks, &mut cls);
    let mut out: Vec<(Option<&'static str>, String)> = Vec::new();
    for (c, ch) in cls.into_iter().zip(chars) {
        // White space joins whatever run it sits in, as in highlight.js's spans.
        match out.last_mut() {
            Some((last, t)) if *last == c => t.push(ch),
            _ => out.push((c, ch.to_string())),
        }
    }
    out
}

/// rehype-highlight over a tree: `<pre><code class="language-x">` gets
/// `hljs` and token spans when the language is known.
pub fn highlight_tree(nodes: &mut [Node]) {
    for node in nodes.iter_mut() {
        let Node::Element(pre) = node else { continue };
        if pre.tag == "pre" {
            for child in pre.children.iter_mut() {
                if let Node::Element(code) = child
                    && code.tag == "code"
                {
                    highlight_code(code);
                }
            }
            continue;
        }
        highlight_tree(&mut pre.children);
    }
}

fn highlight_code(code: &mut Element) {
    let classes: Vec<String> = code.classes().iter().map(|s| s.to_string()).collect();
    let Some(lang) = classes.iter().find_map(|c| c.strip_prefix("language-").or_else(|| c.strip_prefix("lang-"))) else { return };
    if lang == "math" || lang == "no-highlight" || lang == "nohighlight" || lang == "plaintext" || lang == "text" || lang == "txt" {
        return;
    }
    let Some(syntax) = syntax_for(lang) else { return };
    let text = code.text();
    let mut children = Vec::new();
    for (class, run) in tokens_in(&text, syntax, lang_of(lang)) {
        match class {
            Some(class) => children.push(Node::Element(Element::new("span").with_attr("class", class).with_children(vec![Node::Text(run)]))),
            None => children.push(Node::Text(run)),
        }
    }
    code.children = children;
    let mut list = vec!["hljs".to_string()];
    list.extend(classes);
    code.set("class", &list.join(" "));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_gets_hljs_classes() {
        let syntax = syntax_for("js").unwrap();
        let t = tokens("// hi\nconst a = 42;\n", syntax);
        let classes: Vec<_> = t.iter().filter_map(|(c, s)| c.map(|c| (c, s.trim().to_string()))).collect();
        assert!(classes.contains(&("hljs-comment", "// hi".into())), "{classes:?}");
        assert!(classes.contains(&("hljs-keyword", "const".into())), "{classes:?}");
        assert!(classes.contains(&("hljs-number", "42".into())), "{classes:?}");
    }
}

/// Every token with its full scope stack, for tuning the class mapping
/// (`MARKIE_SCOPES=<file>:<lang> cargo test -p markie-export dump_scopes -- --ignored --nocapture`).
#[cfg(test)]
#[test]
#[ignore]
fn dump_scopes() {
    let spec = std::env::var("MARKIE_SCOPES").unwrap();
    let (file, lang) = spec.rsplit_once(':').unwrap();
    let code = std::fs::read_to_string(file).unwrap();
    let syntax = syntax_for(lang).unwrap();
    let mut state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    for line in code.split_inclusive('\n') {
        let ops = state.parse_line(line, &SYNTAXES).unwrap();
        let mut at = 0;
        for (index, op) in ops {
            let index = index.min(line.len());
            if index > at {
                let names: Vec<String> = stack.as_slice().iter().skip(1).map(|s| s.build_string()).collect();
                println!("{:?}  {}", &line[at..index], names.join(" > "));
                at = index;
            }
            let _ = stack.apply(&op);
        }
        if at < line.len() {
            let names: Vec<String> = stack.as_slice().iter().skip(1).map(|s| s.build_string()).collect();
            println!("{:?}  {}", &line[at..], names.join(" > "));
        }
    }
}
