//! The user-editable half of the taxonomy: path rules in `Projects.md` front
//! matter under `markie_rules`. A port of `src/lib/projects/rules.ts`. A
//! malformed document parses to an error the caller pairs with the last
//! known-good rules; it never takes the view down.

use regex::Regex;
use serde_yaml::Value;

use super::frontmatter::split_front_matter;

#[derive(Clone, Debug, PartialEq)]
pub struct ProjectRule {
    pub r#match: String,
    pub project: String,
    pub block: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClusteringTunables {
    pub gap_hours: f64,
    pub min_files: f64,
    pub max_blocks_per_project: f64,
    pub bulk_min_files: f64,
    pub bulk_window_minutes: f64,
    pub max_block_share: f64,
    pub max_block_files: f64,
}

pub const DEFAULT_CLUSTERING: ClusteringTunables = ClusteringTunables {
    gap_hours: 24.0,
    min_files: 1.0,
    max_blocks_per_project: 30.0,
    bulk_min_files: 50.0,
    bulk_window_minutes: 15.0,
    max_block_share: 0.4,
    max_block_files: 500.0,
};

pub const DEFAULT_DUMPING_GROUNDS: [&str; 2] = ["~/Downloads/**", "~/.*/**"];

#[derive(Clone, Debug, PartialEq)]
pub struct MarkieRules {
    pub clustering: ClusteringTunables,
    pub rules: Vec<ProjectRule>,
    pub ignore: Vec<String>,
    pub dumping_grounds: Vec<String>,
    pub containers: Vec<String>,
    pub not_containers: Vec<String>,
}

impl Default for MarkieRules {
    fn default() -> Self {
        Self {
            clustering: DEFAULT_CLUSTERING,
            rules: Vec::new(),
            ignore: Vec::new(),
            dumping_grounds: DEFAULT_DUMPING_GROUNDS.iter().map(|s| s.to_string()).collect(),
            containers: Vec::new(),
            not_containers: Vec::new(),
        }
    }
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

fn non_blank_str(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.trim().is_empty())
}

/// Rules from a `Projects.md` document. `Err` carries the message to show.
pub fn parse_rules(markdown: &str) -> Result<MarkieRules, String> {
    let (front, _) = split_front_matter(markdown);
    if front.is_empty() {
        return Ok(MarkieRules::default());
    }
    let body = front.strip_prefix("---\r\n").or_else(|| front.strip_prefix("---\n")).unwrap_or(front);
    let body = ["\r\n---\r\n", "\n---\r\n", "\r\n---\n", "\n---\n", "\r\n...\r\n", "\n...\r\n", "\r\n...\n", "\n...\n", "\r\n---", "\n---", "\r\n...", "\n..."]
        .iter()
        .find_map(|end| body.strip_suffix(end))
        .unwrap_or(body);
    let doc: Value = serde_yaml::from_str(body).map_err(|e| e.to_string())?;
    let raw = match doc.get("markie_rules") {
        None | Some(Value::Null) => return Ok(MarkieRules::default()),
        Some(v) => v,
    };
    // `typeof raw !== "object"`: a list is an object in JavaScript too.
    if !(raw.is_mapping() || raw.is_sequence()) {
        return Err("markie_rules must be a mapping".into());
    }
    let mut out = MarkieRules::default();
    if let Some(c) = raw.get("clustering").filter(|c| c.is_mapping() || c.is_sequence()) {
        let t = &mut out.clustering;
        if let Some(v) = num(c.get("gap_hours")).filter(|v| *v > 0.0) {
            t.gap_hours = v;
        }
        if let Some(v) = num(c.get("min_files")).filter(|v| *v >= 1.0) {
            t.min_files = v;
        }
        if let Some(v) = num(c.get("max_blocks_per_project")).filter(|v| *v >= 1.0) {
            t.max_blocks_per_project = v;
        }
        if let Some(v) = num(c.get("bulk_min_files")).filter(|v| *v >= 2.0) {
            t.bulk_min_files = v;
        }
        if let Some(v) = num(c.get("bulk_window_minutes")).filter(|v| *v > 0.0) {
            t.bulk_window_minutes = v;
        }
        if let Some(v) = num(c.get("max_block_share")).filter(|v| *v > 0.0 && *v <= 1.0) {
            t.max_block_share = v;
        }
        if let Some(v) = num(c.get("max_block_files")).filter(|v| *v >= 1.0) {
            t.max_block_files = v;
        }
    }
    match raw.get("rules") {
        None | Some(Value::Null) => {}
        Some(Value::Sequence(items)) => {
            for (i, item) in items.iter().enumerate() {
                let Some(m) = non_blank_str(item.get("match")) else {
                    return Err(format!("rule {} needs a match pattern", i + 1));
                };
                let Some(p) = non_blank_str(item.get("project")) else {
                    return Err(format!("rule {} needs a project", i + 1));
                };
                out.rules.push(ProjectRule {
                    r#match: m.to_string(),
                    project: p.to_string(),
                    block: non_blank_str(item.get("block")).map(str::to_string),
                });
            }
        }
        Some(_) => return Err("rules must be a list".into()),
    }
    // An absent key means "whatever Markie ships"; a present one, even empty,
    // replaces it.
    for (key, slot) in [
        ("ignore", &mut out.ignore),
        ("dumping_grounds", &mut out.dumping_grounds),
        ("containers", &mut out.containers),
        ("not_containers", &mut out.not_containers),
    ] {
        match raw.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::Sequence(items)) => {
                *slot = items
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_string)
                    .collect();
            }
            Some(_) => return Err(format!("{key} must be a list")),
        }
    }
    Ok(out)
}

/// Minimal glob: `~` expansion, `*` within a segment, `**` across segments.
/// Everything else is literal.
pub fn compile_glob(pattern: &str, home: &str) -> Regex {
    let p = if pattern == "~" {
        home.to_string()
    } else if let Some(rest) = pattern.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        pattern.to_string()
    };
    let mut out = String::from("^");
    let chars: Vec<char> = p.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '*' && chars.get(i + 1) == Some(&'*') {
            out.push_str(".*");
            i += 2;
            if chars.get(i) == Some(&'/') {
                i += 1;
            }
        } else if chars[i] == '*' {
            out.push_str("[^/]*");
            i += 1;
        } else {
            out.push_str(&regex::escape(&chars[i].to_string()));
            i += 1;
        }
    }
    out.push('$');
    Regex::new(&out).unwrap_or_else(|_| Regex::new("^$").unwrap())
}

pub(crate) fn normalize(p: &str) -> String {
    p.replace('\\', "/")
}

/// The rules compiled once against one home folder.
pub struct CompiledRules<'a> {
    rules: &'a MarkieRules,
    ignore: Vec<Regex>,
    rule_globs: Vec<Regex>,
}

pub enum RuleOutcome {
    Ignored,
    Placed { project: String, block: Option<String> },
}

fn substitute(value: &str, dir: &str, repo: Option<&str>) -> Option<String> {
    let mut out = value.to_string();
    if out.contains("{repo}") {
        out = out.replace("{repo}", repo?);
    }
    if out.contains("{folder}") {
        let folder = normalize(dir).split('/').filter(|s| !s.is_empty()).last().unwrap_or("").to_string();
        if folder.is_empty() {
            return None;
        }
        out = out.replace("{folder}", &folder);
    }
    Some(out)
}

impl<'a> CompiledRules<'a> {
    pub fn new(rules: &'a MarkieRules, home: &str) -> Self {
        let h = normalize(home);
        Self {
            ignore: rules
                .ignore
                .iter()
                .chain(rules.dumping_grounds.iter())
                .map(|g| compile_glob(&normalize(g), &h))
                .collect(),
            rule_globs: rules.rules.iter().map(|r| compile_glob(&normalize(&r.r#match), &h)).collect(),
            rules,
        }
    }

    pub fn apply(&self, path: &str, dir: &str, repo: Option<&str>) -> Option<RuleOutcome> {
        let p = normalize(path);
        if self.ignore.iter().any(|re| re.is_match(&p)) {
            return Some(RuleOutcome::Ignored);
        }
        for (rule, re) in self.rules.rules.iter().zip(&self.rule_globs) {
            if !re.is_match(&p) {
                continue;
            }
            let Some(project) = substitute(&rule.project, dir, repo) else { continue };
            let block = rule.block.as_deref().and_then(|b| substitute(b, dir, repo));
            return Some(RuleOutcome::Placed { project, block });
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_absent_rules_are_defaults() {
        assert_eq!(parse_rules("").unwrap(), MarkieRules::default());
        assert_eq!(parse_rules("---\ntitle: x\n---\n").unwrap(), MarkieRules::default());
        assert_eq!(parse_rules(super::super::config::DEFAULT_PROJECTS_MD).unwrap(), MarkieRules::default());
    }

    #[test]
    fn parses_tunables_rules_and_lists() {
        let md = "---\nmarkie_rules:\n  clustering:\n    gap_hours: 6\n    min_files: 0\n    max_block_share: 2\n  rules:\n    - match: \"~/Code/**\"\n      project: \"{repo}\"\n    - match: ~/Notes/**\n      project: Notes\n      block: \"{folder}\"\n  dumping_grounds: []\n  ignore: [\"~/tmp/**\", \"\"]\n---\n# body";
        let r = parse_rules(md).unwrap();
        assert_eq!(r.clustering.gap_hours, 6.0);
        assert_eq!(r.clustering.min_files, 1.0, "out-of-range values keep the default");
        assert_eq!(r.clustering.max_block_share, 0.4);
        assert_eq!(r.rules.len(), 2);
        assert_eq!(r.rules[1].block.as_deref(), Some("{folder}"));
        assert!(r.dumping_grounds.is_empty(), "a present empty list replaces the default");
        assert_eq!(r.ignore, vec!["~/tmp/**"]);
    }

    #[test]
    fn reports_errors() {
        assert_eq!(parse_rules("---\nmarkie_rules: 5\n---\n").unwrap_err(), "markie_rules must be a mapping");
        assert_eq!(parse_rules("---\nmarkie_rules:\n  rules: x\n---\n").unwrap_err(), "rules must be a list");
        assert_eq!(
            parse_rules("---\nmarkie_rules:\n  rules:\n    - project: A\n---\n").unwrap_err(),
            "rule 1 needs a match pattern"
        );
        assert_eq!(
            parse_rules("---\nmarkie_rules:\n  rules:\n    - match: a\n---\n").unwrap_err(),
            "rule 1 needs a project"
        );
        assert_eq!(parse_rules("---\nmarkie_rules:\n  ignore: x\n---\n").unwrap_err(), "ignore must be a list");
        assert!(parse_rules("---\nmarkie_rules: [unclosed\n---\n").is_err());
    }

    #[test]
    fn globs_are_literal_except_stars() {
        let re = compile_glob("~/Code/**", "/Users/k");
        assert!(re.is_match("/Users/k/Code/a/b.md"));
        assert!(!re.is_match("/Users/k/Codex/a.md"));
        let one = compile_glob("~/Notes/*.md", "/Users/k");
        assert!(one.is_match("/Users/k/Notes/a.md"));
        assert!(!one.is_match("/Users/k/Notes/x/a.md"));
        let lit = compile_glob("/x/C++/Q&A?/**", "/h");
        assert!(lit.is_match("/x/C++/Q&A?/n.md"));
        assert!(!lit.is_match("/x/CC/QA/n.md"));
        let hidden = compile_glob("~/.*/**", "/Users/k");
        assert!(hidden.is_match("/Users/k/.claude/skills/a.md"));
        assert!(!hidden.is_match("/Users/k/Docs/a.md"));
    }

    #[test]
    fn applies_rules_in_order_with_substitution() {
        let r = parse_rules("---\nmarkie_rules:\n  rules:\n    - match: ~/Code/**\n      project: \"{repo}\"\n    - match: ~/**\n      project: Home\n      block: \"{folder}\"\n---\n").unwrap();
        let c = CompiledRules::new(&r, "/Users/k");
        match c.apply("/Users/k/Code/app/README.md", "/Users/k/Code/app", Some("app")) {
            Some(RuleOutcome::Placed { project, block }) => assert_eq!((project.as_str(), block), ("app", None)),
            _ => panic!(),
        }
        // {repo} unavailable: falls through to the next rule.
        match c.apply("/Users/k/Code/x/a.md", "/Users/k/Code/x", None) {
            Some(RuleOutcome::Placed { project, block }) => {
                assert_eq!((project.as_str(), block.as_deref()), ("Home", Some("x")))
            }
            _ => panic!(),
        }
        assert!(matches!(c.apply("/Users/k/Downloads/a.md", "/Users/k/Downloads", None), Some(RuleOutcome::Ignored)));
    }
}
