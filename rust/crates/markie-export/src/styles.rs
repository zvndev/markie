//! `pdf-styles.ts`: the standalone stylesheet and page around an export.
//! The CSS and the fit script are the Electron text, extracted verbatim into
//! `assets/` (a test checks them against Electron's own output).

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Theme {
    Light,
    Dark,
}

impl Theme {
    pub fn name(self) -> &'static str {
        match self {
            Theme::Light => "light",
            Theme::Dark => "dark",
        }
    }
}

pub const SHARED_CSS: &str = include_str!("assets/pdf-shared.css");
pub const DARK_CSS: &str = include_str!("assets/pdf-dark.css");
pub const LIGHT_CSS: &str = include_str!("assets/pdf-light.css");
pub const MATH_CSS: &str = include_str!("assets/pdf-math.css");
pub const FIT_SCRIPT: &str = include_str!("assets/fit-script.js");

/// The `<style>` element, without KaTeX's stylesheet: math is SVG here.
pub fn pdf_styles(theme: Theme) -> String {
    let body = match theme {
        Theme::Dark => DARK_CSS,
        Theme::Light => LIGHT_CSS,
    };
    format!("<style>{SHARED_CSS}\n{body}\n{MATH_CSS}</style>")
}

/// `neutralizeBodyBreakouts`: a template-integrity guard, not a sanitizer.
pub fn neutralize_body_breakouts(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(at) = rest.find('<') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let (slash, name_at) = if let Some(s) = after.strip_prefix('/') { ("/", s) } else { ("", after) };
        let lower: String = name_at.chars().take(6).collect::<String>().to_ascii_lowercase();
        let hit = ["script", "style"].into_iter().find(|n| {
            lower.starts_with(n) && !name_at[n.len()..].starts_with(|c: char| c.is_alphanumeric() || c == '_')
        });
        match hit {
            Some(n) => {
                out.push_str("&lt;");
                out.push_str(slash);
                out.push_str(&name_at[..n.len()]);
                rest = &name_at[n.len()..];
            }
            None => {
                out.push('<');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `buildPDFHTML`: the whole standalone document.
pub fn build_pdf_html(markdown_html: &str, theme: Theme) -> String {
    format!(
        "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n{}\n<script>{FIT_SCRIPT}</script>\n</head>\n<body>\n<article class=\"markdown-body\">{}</article>\n</body>\n</html>",
        pdf_styles(theme),
        neutralize_body_breakouts(markdown_html)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn breakouts_are_neutralized() {
        assert_eq!(neutralize_body_breakouts("<p>a</p><script>x</script><STYLE>"), "<p>a</p>&lt;script>x&lt;/script>&lt;STYLE>");
        assert_eq!(neutralize_body_breakouts("<scripts>"), "<scripts>");
    }

    #[test]
    fn fit_script_never_closes_itself() {
        assert!(!FIT_SCRIPT.to_ascii_lowercase().contains("</script"));
    }
}
