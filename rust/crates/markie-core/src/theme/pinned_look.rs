//! The look an owner pinned to a document (`src/lib/pinned-look.ts` and
//! `src/components/share-look.tsx`): theme tokens (colours and faces) and a
//! Markdown style. Both come from another account by way of a server, so
//! both are checked here before anything is painted. The server keeps them in
//! `docs.enforced_theme` and `docs.enforced_style` and answers
//! `GET /api/docs/:id/theme` with `{ tokens, style }`.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use super::{ThemePreset, ThemeStore, ThemeTokens, Tone};
use crate::markdown_style::{self, FontTokens, MarkdownStyle, StyleStore};

static HEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$").unwrap());
static FUNCTIONAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?:[\d\s.,%/+-]|deg|turn|rad|none)+\)$").unwrap());

/// A colour and nothing else: hex, or a colour function over plain numbers.
pub fn plain_color(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    if text.is_empty() || text.len() > 64 {
        return None;
    }
    (HEX.is_match(text) || FUNCTIONAL.is_match(text)).then(|| text.to_string())
}

const REQUIRED: [&str; 8] = ["background", "surface", "surface2", "foreground", "muted", "border", "accent", "link"];
const OPTIONAL: [&str; 6] = ["docRule", "statusGreen", "statusYellow", "statusRed", "statusBlue", "statusPurple"];
const FACES: [&str; 3] = ["bodyFont", "headingFont", "codeFont"];
const SIZES: [&str; 4] = ["fontSize", "contentWidth", "lineHeight", "paragraphGap"];

/// The type fields of some tokens, each a plain string or number. Their
/// values are checked where they are painted (`typography_of`).
fn type_only(raw: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(source) = raw.as_object() else { return out };
    for key in FACES {
        if let Some(v) = source.get(key).and_then(Value::as_str).filter(|v| v.chars().count() <= 200) {
            out.insert(key.into(), json!(v));
        }
    }
    for key in SIZES {
        if let Some(v) = source.get(key).and_then(Value::as_f64).filter(|v| v.is_finite()) {
            out.insert(key.into(), json!(v));
        }
    }
    out
}

/// `safePinnedTokens`: pinned tokens that are safe to paint: every colour a
/// plain colour, or None when a required one is not.
pub fn safe_pinned_tokens(raw: &Value) -> Option<ThemeTokens> {
    let source = raw.as_object()?;
    let mut out = Map::new();
    for key in REQUIRED {
        out.insert(key.into(), json!(plain_color(source.get(key)?)?));
    }
    for key in OPTIONAL {
        if let Some(color) = source.get(key).and_then(plain_color) {
            out.insert(key.into(), json!(color));
        }
    }
    out.extend(type_only(raw));
    serde_json::from_value(Value::Object(out)).ok()
}

/// A pinned look, checked. `tokens` is None when the colours could not be
/// used; the style still applies.
#[derive(Clone, Debug, PartialEq)]
pub struct PinnedLook {
    pub tokens: Option<ThemeTokens>,
    pub style: Option<MarkdownStyle>,
}

/// `pinnedLookFrom`: what a server's `{ tokens, style }` answer amounts to.
/// None when nothing is pinned.
pub fn pinned_look_from(data: &Value) -> Option<PinnedLook> {
    let tokens = data.get("tokens").filter(|t| t.is_object())?;
    Some(PinnedLook { tokens: safe_pinned_tokens(tokens), style: data.get("style").and_then(markdown_style::sanitize) })
}

/// `pinnedLookTokens`: the whole look as one set of tokens to paint. The
/// pinned tokens' own text and heading faces come first: they are what the
/// owner had on screen. The style supplies whatever the tokens do not name,
/// and the code face, which only a style carries to every reader.
pub fn pinned_look_tokens(look: &PinnedLook) -> Option<ThemeTokens> {
    let mut tokens = look.tokens.clone()?;
    let from_style = look.style.as_ref().map(markdown_style::font_tokens).unwrap_or_default();
    tokens.body_font = tokens.body_font.or(from_style.body_font);
    tokens.heading_font = tokens.heading_font.or(from_style.heading_font);
    tokens.code_font = from_style.code_font.or(tokens.code_font);
    Some(tokens)
}

/// The id of the preset a pinned look is painted as.
pub const PINNED_ID: &str = "doc-pinned";

/// The person's store with the owner's look painted over it: the pinned
/// tokens as the active preset, and the pinned style (Spacious when the
/// owner pinned none) in place of the person's own. Nothing here is saved.
pub fn pinned_store(own: &ThemeStore, look: &PinnedLook) -> Option<ThemeStore> {
    let tokens = pinned_look_tokens(look)?;
    let mut store = own.clone();
    store.custom.retain(|p| p.id != PINNED_ID);
    store.custom.push(ThemePreset { id: PINNED_ID.into(), name: "Owner theme".into(), built_in: None, template_id: None, tone: None, tokens });
    store.active_id = PINNED_ID.into();
    store.overrides = None;
    store.typography = None;
    let style = look.style.clone().unwrap_or_default();
    store.markdown_style = Some(StyleStore { active_id: style.base.clone(), profiles: Vec::new(), draft: Some(style) });
    store.pinned = true;
    Some(store)
}

/// The look an account is using right now, as the Share dialog pins it.
#[derive(Clone, Debug, PartialEq)]
pub struct OwnLook {
    pub tokens: ThemeTokens,
    /// The style carries the faces actually on screen (the style's own, or
    /// the ones this person chose over them), so a reader gets them from the
    /// style alone: the code face reaches a public link no other way.
    pub style: MarkdownStyle,
    /// "Markie theme, Spacious style".
    pub label: String,
}

/// `ownLook` in share-look.tsx.
pub fn own_look(store: &ThemeStore, tone: Tone) -> OwnLook {
    let tokens = store.painted(tone).0.tokens;
    let styles = store.style_store();
    let painted = FontTokens { body_font: tokens.body_font.clone(), heading_font: tokens.heading_font.clone(), code_font: tokens.code_font.clone() };
    OwnLook {
        style: markdown_style::with_painted_fonts(&styles.pinnable(), &painted),
        label: format!("{} theme, {} style", store.active_template().name, styles.active_name()),
        tokens,
    }
}

/// The tokens as they are sent: the fields that are set, and no nulls.
pub fn tokens_json(tokens: &ThemeTokens) -> Value {
    match serde_json::to_value(tokens) {
        Ok(Value::Object(map)) => Value::Object(map.into_iter().filter(|(_, v)| !v.is_null()).collect()),
        _ => Value::Null,
    }
}

/// The body of `PUT /api/docs/:id/theme`: a look to pin, or None to unpin.
pub fn pin_body(look: Option<&OwnLook>) -> Value {
    match look {
        Some(look) => json!({ "tokens": tokens_json(&look.tokens), "style": look.style.to_value() }),
        None => json!({ "tokens": null, "style": null }),
    }
}

/// What is pinned to a document, as its owner's Share dialog needs it.
#[derive(Clone, Debug, PartialEq)]
pub enum LookState {
    /// The server could not be asked: show no switch rather than a wrong one.
    Unknown,
    Off,
    /// Pinned, and whether the owner's look has changed since.
    On { drifted: bool },
}

/// `docLookState` and `sameLook`: read the server's answer against the
/// look this account is using.
pub fn look_state(answer: Option<&Value>, own: &OwnLook) -> LookState {
    let Some(answer) = answer else { return LookState::Unknown };
    let Some(tokens) = answer.get("tokens").filter(|t| t.is_object()) else { return LookState::Off };
    let style = answer.get("style").and_then(markdown_style::sanitize).unwrap_or_default();
    let same_tokens = serde_json::from_value::<ThemeTokens>(tokens.clone()).is_ok_and(|t| t == own.tokens);
    LookState::On { drifted: !(same_tokens && markdown_style::same(&style, &own.style)) }
}

/// The line under "Readers see my look" (share-look.tsx).
pub fn look_line(state: &LookState, busy: bool, own: &OwnLook) -> String {
    if busy {
        return "Updating…".into();
    }
    match state {
        LookState::On { drifted: true } => "On, with the look you had when you pinned it. Yours has changed since.".into(),
        LookState::On { drifted: false } => format!("On: {}.", own.label),
        _ => format!("Off. Everyone reads this in their own theme. Turn on to share yours: {}.", own.label),
    }
}

pub const LOOK_FAILED_LINE: &str = "Markie couldn't change this just now. Check your connection and try again.";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::TypographyPatch;

    #[test]
    fn colours_are_checked_before_anything_is_painted() {
        assert_eq!(plain_color(&json!(" #A1b2C3 ")).as_deref(), Some("#A1b2C3"));
        assert_eq!(plain_color(&json!("rgb(1, 2, 3 / 50%)")).as_deref(), Some("rgb(1, 2, 3 / 50%)"));
        assert_eq!(plain_color(&json!("red; background: url(x)")), None);
        assert_eq!(plain_color(&json!("url(javascript:1)")), None);
        assert_eq!(plain_color(&json!(7)), None);
        let good = json!({ "background": "#101010", "surface": "#111", "surface2": "#222", "foreground": "#fff", "muted": "#999", "border": "#333", "accent": "#444", "link": "#58f",
            "docRule": "x", "statusBlue": "#00f", "bodyFont": "lora", "fontSize": 18, "lineHeight": "1.5", "extra": true });
        let t = safe_pinned_tokens(&good).unwrap();
        assert_eq!((t.background.as_str(), t.doc_rule, t.status_blue.as_deref()), ("#101010", None, Some("#00f")));
        assert_eq!((t.body_font.as_deref(), t.font_size, t.line_height), (Some("lora"), Some(18.0), None));
        let mut bad = good.clone();
        bad["link"] = json!("expression(1)");
        assert_eq!(safe_pinned_tokens(&bad), None);
        assert_eq!(pinned_look_from(&json!({ "tokens": null, "style": { "base": "compact" } })), None);
        // Colours that cannot be used leave the style standing.
        let look = pinned_look_from(&json!({ "tokens": bad, "style": { "base": "compact", "choices": { "tableStyle": "} x {" } } })).unwrap();
        assert_eq!((look.tokens, look.style), (None, Some(MarkdownStyle::preset("compact"))));
    }

    #[test]
    fn a_pinned_look_paints_the_owners_faces_and_style_in_either_mode() {
        let own = ThemeStore::default().choose_template("paper", Tone::Light).with_style_store(StyleStore::default().choose("minimal"));
        let tokens = json!({ "background": "#101010", "surface": "#111", "surface2": "#222", "foreground": "#fff", "muted": "#999", "border": "#333", "accent": "#444", "link": "#58f", "bodyFont": "local:inter:Futura" });
        let look = pinned_look_from(&json!({ "tokens": tokens, "style": { "base": "editorial", "choices": { "bodyFont": "inter" } } })).unwrap();
        let settled = pinned_look_tokens(&look).unwrap();
        // The tokens' own text face first; the style's heading and code faces fill in.
        assert_eq!((settled.body_font.as_deref(), settled.heading_font.as_deref(), settled.code_font.as_deref()), (Some("local:inter:Futura"), Some("playfair"), Some("fira-code")));
        let mut pinned = pinned_store(&own, &look).unwrap();
        pinned.own_code_font = Some("jetbrains-mono".into());
        for tone in [Tone::Light, Tone::Dark] {
            let (p, t) = pinned.painted(tone);
            assert_eq!(p.id, PINNED_ID);
            assert_eq!(p.tokens.background, "#101010");
            assert_eq!((t.body_font.as_str(), t.heading_font.as_str()), ("local:inter:Futura", "playfair"));
            assert_eq!(pinned.code_font(tone), "fira-code", "the owner's code face, not this computer's");
        }
        assert_eq!(pinned.active_style().base, "editorial");
        // The person's own store is untouched, and a pin with no style reads as Spacious.
        assert_eq!(own.active_style().base, "minimal");
        let bare = pinned_store(&own, &PinnedLook { tokens: look.tokens.clone(), style: None }).unwrap();
        assert!(markdown_style::resolve(&bare.active_style()).is_spacious_drawing());
        assert_eq!(bare.painted(Tone::Dark).1.body_font, "local:inter:Futura");
        let mut bare = bare;
        bare.own_code_font = Some("jetbrains-mono".into());
        assert_eq!(bare.code_font(Tone::Dark), "jetbrains-mono", "no pinned code face: this computer's own");
    }

    #[test]
    fn the_share_row_pins_what_is_on_screen_and_says_when_it_drifted() {
        let store = ThemeStore::default()
            .choose_template("nord", Tone::Dark)
            .with_style_store(StyleStore::default().choose("technical"))
            .set_typography(&TypographyPatch { body_font: Some("local:carlito:Calibri".into()), ..Default::default() });
        let own = own_look(&store, Tone::Dark);
        assert_eq!(own.label, "Nord theme, Technical style");
        assert_eq!(own.tokens.body_font.as_deref(), Some("local:carlito:Calibri"));
        // A font from one computer is not stored in a style; its stand-in is not a text face.
        assert!(!own.style.choices.contains_key("bodyFont") || own.style.choices["bodyFont"] != "local:carlito:Calibri");
        assert_eq!(own.style.base, "technical");
        let body = pin_body(Some(&own));
        assert_eq!(body["tokens"]["background"], json!(own.tokens.background));
        assert!(body["tokens"].as_object().unwrap().values().all(|v| !v.is_null()));
        assert_eq!(body["style"]["base"], "technical");
        assert_eq!(pin_body(None), json!({ "tokens": null, "style": null }));

        assert_eq!(look_state(None, &own), LookState::Unknown);
        assert_eq!(look_state(Some(&json!({ "tokens": null, "style": null })), &own), LookState::Off);
        assert_eq!(look_state(Some(&body), &own), LookState::On { drifted: false });
        let later = own_look(&store.with_style_store(StyleStore::default().choose("classic")), Tone::Dark);
        assert_eq!(look_state(Some(&body), &later), LookState::On { drifted: true });
        assert_eq!(look_line(&LookState::Off, false, &own), "Off. Everyone reads this in their own theme. Turn on to share yours: Nord theme, Technical style.");
        assert_eq!(look_line(&LookState::On { drifted: false }, false, &own), "On: Nord theme, Technical style.");
        assert!(look_line(&LookState::On { drifted: true }, false, &own).ends_with("Yours has changed since."));
        assert_eq!(look_line(&LookState::Off, true, &own), "Updating…");
    }
}
