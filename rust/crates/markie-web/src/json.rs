//! JSON the way JavaScript reads and writes it: object keys keep their
//! insertion order, a repeated key keeps its first position and last value,
//! and numbers print as `Number.prototype.toString` prints them. The Darkmown
//! sanitizer re-serializes runtime values, and the frame's runtime compares
//! some of them as strings, so they must come out exactly as Electron's do.

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_arr(&self) -> Option<&Vec<Json>> {
        match self {
            Json::Arr(a) => Some(a),
            _ => None,
        }
    }
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(o) => o.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

/// `JSON.parse`. None on any syntax error.
pub fn parse(text: &str) -> Option<Json> {
    let mut p = Parser { s: text.as_bytes(), i: 0, src: text };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    (p.i == p.s.len()).then_some(v)
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
    src: &'a str,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn value(&mut self, depth: usize) -> Option<Json> {
        if depth > 512 {
            return None;
        }
        match *self.s.get(self.i)? {
            b'n' => self.word("null", Json::Null),
            b't' => self.word("true", Json::Bool(true)),
            b'f' => self.word("false", Json::Bool(false)),
            b'"' => self.string().map(Json::Str),
            b'[' => {
                self.i += 1;
                let mut out = Vec::new();
                self.ws();
                if self.s.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Some(Json::Arr(out));
                }
                loop {
                    self.ws();
                    out.push(self.value(depth + 1)?);
                    self.ws();
                    match *self.s.get(self.i)? {
                        b',' => self.i += 1,
                        b']' => {
                            self.i += 1;
                            return Some(Json::Arr(out));
                        }
                        _ => return None,
                    }
                }
            }
            b'{' => {
                self.i += 1;
                let mut out: Vec<(String, Json)> = Vec::new();
                self.ws();
                if self.s.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Some(Json::Obj(out));
                }
                loop {
                    self.ws();
                    if self.s.get(self.i) != Some(&b'"') {
                        return None;
                    }
                    let key = self.string()?;
                    self.ws();
                    if self.s.get(self.i) != Some(&b':') {
                        return None;
                    }
                    self.i += 1;
                    self.ws();
                    let v = self.value(depth + 1)?;
                    match out.iter_mut().find(|(k, _)| *k == key) {
                        Some(slot) => slot.1 = v,
                        None => out.push((key, v)),
                    }
                    self.ws();
                    match *self.s.get(self.i)? {
                        b',' => self.i += 1,
                        b'}' => {
                            self.i += 1;
                            return Some(Json::Obj(out));
                        }
                        _ => return None,
                    }
                }
            }
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        }
    }

    fn word(&mut self, w: &str, v: Json) -> Option<Json> {
        if self.src[self.i..].starts_with(w) {
            self.i += w.len();
            Some(v)
        } else {
            None
        }
    }

    fn number(&mut self) -> Option<Json> {
        let start = self.i;
        if self.s[self.i] == b'-' {
            self.i += 1;
        }
        match self.s.get(self.i)? {
            b'0' => self.i += 1,
            b'1'..=b'9' => {
                while self.s.get(self.i).is_some_and(u8::is_ascii_digit) {
                    self.i += 1;
                }
            }
            _ => return None,
        }
        if self.s.get(self.i) == Some(&b'.') {
            self.i += 1;
            if !self.s.get(self.i).is_some_and(u8::is_ascii_digit) {
                return None;
            }
            while self.s.get(self.i).is_some_and(u8::is_ascii_digit) {
                self.i += 1;
            }
        }
        if matches!(self.s.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.s.get(self.i), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if !self.s.get(self.i).is_some_and(u8::is_ascii_digit) {
                return None;
            }
            while self.s.get(self.i).is_some_and(u8::is_ascii_digit) {
                self.i += 1;
            }
        }
        self.src[start..self.i].parse::<f64>().ok().map(Json::Num)
    }

    fn string(&mut self) -> Option<String> {
        self.i += 1;
        let mut out = String::new();
        let mut units: Vec<u16> = Vec::new();
        let flush = |units: &mut Vec<u16>, out: &mut String| {
            if !units.is_empty() {
                out.push_str(&String::from_utf16_lossy(units));
                units.clear();
            }
        };
        loop {
            let c = *self.s.get(self.i)?;
            match c {
                b'"' => {
                    self.i += 1;
                    flush(&mut units, &mut out);
                    return Some(out);
                }
                b'\\' => {
                    self.i += 1;
                    let e = *self.s.get(self.i)?;
                    self.i += 1;
                    let ch = match e {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let hex = self.src.get(self.i..self.i + 4)?;
                            let u = u16::from_str_radix(hex, 16).ok()?;
                            self.i += 4;
                            units.push(u);
                            continue;
                        }
                        _ => return None,
                    };
                    flush(&mut units, &mut out);
                    out.push(ch);
                }
                0..=0x1f => return None,
                _ => {
                    flush(&mut units, &mut out);
                    let ch = self.src[self.i..].chars().next()?;
                    out.push(ch);
                    self.i += ch.len_utf8();
                }
            }
        }
    }
}

/// `Number.prototype.toString()` for a finite number.
pub fn js_number(n: f64) -> String {
    if n == 0.0 {
        return "0".into();
    }
    if !n.is_finite() {
        return "null".into();
    }
    let abs = n.abs();
    if (1e-6..1e21).contains(&abs) {
        if n.fract() == 0.0 && abs < 9.007_199_254_740_992e15 {
            return format!("{}", n as i64);
        }
        return format!("{n}");
    }
    // Exponent form: mantissa digits, then e+NN or e-NN.
    let s = format!("{n:e}");
    match s.split_once('e') {
        Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
        _ => s,
    }
}

/// `JSON.stringify`.
pub fn stringify(v: &Json) -> String {
    let mut out = String::new();
    write(v, &mut out);
    out
}

fn write(v: &Json, out: &mut String) {
    match v {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Num(n) => out.push_str(&js_number(*n)),
        Json::Str(s) => quote(s, out),
        Json::Arr(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(x, out);
            }
            out.push(']');
        }
        Json::Obj(o) => {
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                quote(k, out);
                out.push(':');
                write(x, out);
            }
            out.push('}');
        }
    }
}

fn quote(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// A string's length in UTF-16 code units, which is what JavaScript counts.
pub fn js_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_like_javascript() {
        let v = parse(r#"{"b":2.0,"a":[1e21,0.1,-0,1.5e-7,"xé"],"b":3}"#).unwrap();
        assert_eq!(stringify(&v), r#"{"b":3,"a":[1e+21,0.1,0,1.5e-7,"xé"]}"#);
        assert!(parse("{'a':1}").is_none());
        assert!(parse("[1,]").is_none());
        assert_eq!(js_number(4.5), "4.5");
        assert_eq!(js_number(12.0), "12");
    }
}
