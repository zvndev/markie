//! Passphrase suggestion and the strength guide: `src/lib/vault/passphrase.ts`.
use crate::envelope::limits;
use crate::error::{VaultError, VaultErrorCode};
use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;

/// 2,048 words from the EFF large wordlist (CC BY 3.0 US), the same list and order as wordlist.ts.
pub fn passphrase_words() -> &'static [&'static str] {
    static WORDS: OnceLock<Vec<&'static str>> = OnceLock::new();
    WORDS.get_or_init(|| include_str!("wordlist.txt").lines().collect())
}

fn word_set() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| passphrase_words().iter().copied().collect())
}

pub const SUGGESTED_PASSPHRASE_WORDS: usize = 6;

/// A uniform index below `size`, by rejection sampling.
fn uniform_index(size: usize) -> Result<usize, VaultError> {
    let limit = (0x1_0000_0000u64 / size as u64) * size as u64;
    loop {
        let sample = u64::from(u32::from_le_bytes(crate::vault::random::<4>()?));
        if sample < limit {
            return Ok((sample % size as u64) as usize);
        }
    }
}

/// Six random words joined by hyphens: about 66 bits.
pub fn suggest_passphrase(words: usize) -> Result<String, VaultError> {
    let list = passphrase_words();
    if list.is_empty() {
        return Err(VaultErrorCode::Unavailable.into());
    }
    let picked = (0..words).map(|_| uniform_index(list.len()).map(|i| list[i])).collect::<Result<Vec<_>, _>>()?;
    Ok(picked.join("-"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StrengthLevel {
    TooShort,
    Weak,
    Fair,
    Strong,
    VeryStrong,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PassphraseStrength {
    pub bits: i64,
    pub level: StrengthLevel,
    pub label: &'static str,
}

fn pool_size(chars: &[char]) -> f64 {
    let mut pool = 0u32;
    if chars.iter().any(|c| c.is_ascii_lowercase()) {
        pool += 26;
    }
    if chars.iter().any(|c| c.is_ascii_uppercase()) {
        pool += 26;
    }
    if chars.iter().any(|c| c.is_ascii_digit()) {
        pool += 10;
    }
    if chars.iter().any(|&c| matches!(c, '\x20'..='\x2f' | '\x3a'..='\x40' | '\x5b'..='\x60' | '\x7b'..='\x7e')) {
        pool += 33;
    }
    if chars.iter().any(|&c| c as u32 > 0x7e) {
        pool += 100;
    }
    f64::from(pool.max(1))
}

fn character_bits(chars: &[char], per_character: f64) -> f64 {
    let mut bits = 0.0;
    for (i, &c) in chars.iter().enumerate() {
        let code = c as i64;
        match i.checked_sub(1).map(|p| chars[p] as i64) {
            Some(prev) if prev == code => bits += 0.25,
            Some(prev) if (code - prev).abs() == 1 => bits += 1.0,
            _ => bits += per_character,
        }
    }
    bits
}

/// A rough guess in bits: list words count as one choice each, lowercase words
/// like language, anything else per character. A guide, not a proof.
pub fn estimate_passphrase_bits(passphrase: &str) -> i64 {
    let all: Vec<char> = passphrase.chars().collect();
    if all.is_empty() {
        return 0;
    }
    static TOKENS: OnceLock<Regex> = OnceLock::new();
    let tokens = TOKENS.get_or_init(|| Regex::new(r"\p{L}+|[^\p{L}]+").unwrap());
    let word_bits = (passphrase_words().len() as f64).log2();
    let per_character = pool_size(&all).log2();
    let total_len = js_len(passphrase);
    let mut bits = 0.0;
    for m in tokens.find_iter(passphrase) {
        let token = m.as_str();
        let chars: Vec<char> = token.chars().collect();
        if is_letter(chars[0]) {
            let lower = token.to_lowercase();
            if word_set().contains(lower.as_str()) {
                bits += word_bits + if token == lower { 0.0 } else { 1.0 };
            } else if token == lower && chars.len() >= 4 {
                bits += character_bits(&chars, 2.5).min(word_bits + 6.0);
            } else {
                bits += character_bits(&chars, per_character);
            }
        } else if chars.len() == 1 && (js_space(chars[0]) || matches!(chars[0], '-' | '_' | '.')) {
            let start = js_len(&passphrase[..m.start()]);
            if start > 0 && start + 1 < total_len {
                bits += 1.0;
            } else {
                bits += character_bits(&chars, per_character);
            }
        } else {
            bits += character_bits(&chars, per_character);
        }
    }
    // Math.round: halves round up.
    (bits + 0.5).floor() as i64
}

fn is_letter(c: char) -> bool {
    static LETTER: OnceLock<Regex> = OnceLock::new();
    let mut buf = [0u8; 4];
    LETTER.get_or_init(|| Regex::new(r"^\p{L}$").unwrap()).is_match(c.encode_utf8(&mut buf))
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn passphrase_strength(passphrase: &str) -> PassphraseStrength {
    let bits = estimate_passphrase_bits(passphrase);
    let (level, label) = if passphrase.chars().count() < limits::MINIMUM_PASSPHRASE_CODE_POINTS {
        (StrengthLevel::TooShort, "Too short")
    } else if bits < 45 {
        (StrengthLevel::Weak, "Weak")
    } else if bits < 60 {
        (StrengthLevel::Fair, "Fair")
    } else if bits < 80 {
        (StrengthLevel::Strong, "Strong")
    } else {
        (StrengthLevel::VeryStrong, "Very strong")
    };
    PassphraseStrength { bits, level, label }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wordlist_is_the_same_size_and_suggestions_validate() {
        assert_eq!(passphrase_words().len(), 2048);
        assert_eq!(passphrase_words()[0], "abacus");
        let suggestion = suggest_passphrase(SUGGESTED_PASSPHRASE_WORDS).unwrap();
        assert_eq!(suggestion.split('-').count(), 6);
        assert!(suggestion.split('-').all(|w| word_set().contains(w)));
        assert_eq!(estimate_passphrase_bits(&suggestion), 71);
    }

    #[test]
    fn strength_levels() {
        assert_eq!(passphrase_strength("short").level, StrengthLevel::TooShort);
        assert_eq!(passphrase_strength("aaaaaaaaaaaaaaaaaaaa").level, StrengthLevel::Weak);
        assert_eq!(estimate_passphrase_bits(""), 0);
    }
}
