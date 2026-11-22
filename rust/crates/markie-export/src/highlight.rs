//! Code highlighting with highlight.js class names.
//!
//! Electron runs rehype-highlight (highlight.js) and the export stylesheet
//! colours fourteen `hljs-*` classes. Here syntect, with the two-face syntax set
//! Typst also uses, tokenizes the code and each token's TextMate scope maps to
//! the highlight.js class that colours the same kind of token. Like
//! rehype-highlight, only a block with a language is highlighted, and a
//! language nobody knows is left as it is.

use std::sync::LazyLock;

use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet};

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

/// The highlight.js class for a TextMate scope, or None for plain text.
fn class_for(scope: &str) -> Option<&'static str> {
    let s = scope;
    let starts = |p: &str| s == p || s.starts_with(&format!("{p}."));
    Some(if starts("comment") || starts("punctuation.definition.comment") {
        "hljs-comment"
    } else if starts("meta.template.expression") || starts("punctuation.section.interpolation") || starts("meta.interpolation") {
        "hljs-subst"
    } else if starts("string") || starts("punctuation.definition.string") {
        "hljs-string"
    } else if starts("constant.numeric") {
        "hljs-number"
    } else if starts("constant.language") {
        "hljs-literal"
    } else if starts("entity.name.function") || starts("meta.function-call.identifier") || starts("variable.function") {
        "hljs-title function_"
    } else if starts("entity.name.class") || starts("entity.name.struct") || starts("entity.name.enum") || starts("entity.other.inherited-class") {
        "hljs-title class_"
    } else if starts("entity.name.type") || starts("support.type") || starts("storage.type.primitive") {
        "hljs-type"
    } else if starts("support.function") || starts("support.class") || starts("variable.language") {
        "hljs-built_in"
    } else if starts("variable.parameter") {
        "hljs-params"
    } else if starts("entity.other.attribute-name") || starts("support.type.property-name") || starts("meta.mapping.key") {
        "hljs-attr"
    } else if starts("entity.name.tag") {
        "hljs-name"
    } else if starts("keyword.operator") || starts("punctuation") {
        return None;
    } else if starts("keyword") || starts("storage") {
        "hljs-keyword"
    } else if starts("variable.other.constant") || starts("variable.other.readwrite.global") {
        "hljs-variable"
    } else {
        return None;
    })
}

fn class_of(stack: &ScopeStack) -> Option<&'static str> {
    stack.as_slice().iter().rev().find_map(|scope: &Scope| class_for(&scope.build_string()))
}

/// The code as `(class, text)` runs. Unknown syntax gives one plain run.
pub fn tokens(code: &str, syntax: &SyntaxReference) -> Vec<(Option<&'static str>, String)> {
    let mut state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut out: Vec<(Option<&'static str>, String)> = Vec::new();
    let mut push = |class: Option<&'static str>, text: &str| {
        if text.is_empty() {
            return;
        }
        match out.last_mut() {
            Some((c, t)) if *c == class => t.push_str(text),
            _ => out.push((class, text.to_string())),
        }
    };
    for line in code.split_inclusive('\n') {
        let Ok(ops) = state.parse_line(line, &SYNTAXES) else {
            push(None, line);
            continue;
        };
        let mut at = 0;
        for (index, op) in ops {
            let index = index.min(line.len());
            if index > at {
                push(class_of(&stack), &line[at..index]);
                at = index;
            }
            let _ = stack.apply(&op);
        }
        if at < line.len() {
            push(class_of(&stack), &line[at..]);
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
    for (class, run) in tokens(&text, syntax) {
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
