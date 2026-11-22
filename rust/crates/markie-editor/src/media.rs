//! Pictures (local, remote, data URIs), formulas drawn by `markie-math`,
//! and CSS colours from the marks.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui_kit::*;

/// A remote picture's state.
pub enum Remote {
    Loading,
    Ready(Arc<Image>),
    Failed,
}

#[derive(Default)]
pub struct Media {
    pub remote: HashMap<String, Remote>,
    /// Formulas by (source, display, colour, size in tenths of a pixel).
    pub math: HashMap<(String, bool, u32, u32), Option<MathImage>>,
}

#[derive(Clone)]
pub struct MathImage {
    pub image: Arc<Image>,
    pub width: f32,
    pub height: f32,
    pub baseline: f32,
}

/// Where a picture comes from.
pub enum Source {
    Local(PathBuf),
    Remote(String),
    Inline(Arc<Image>),
    None,
}

pub fn resolve(src: &str, base: Option<&Path>) -> Source {
    let s = src.trim();
    if s.starts_with("http://") || s.starts_with("https://") {
        return Source::Remote(s.to_string());
    }
    if let Some(rest) = s.strip_prefix("data:") {
        return match data_uri(rest) {
            Some(img) => Source::Inline(Arc::new(img)),
            None => Source::None,
        };
    }
    let path = s.strip_prefix("file://").unwrap_or(s);
    let path = percent_decode(path);
    let p = Path::new(&path);
    if p.is_absolute() {
        return Source::Local(p.to_path_buf());
    }
    match base {
        Some(b) => Source::Local(b.join(p)),
        None => Source::None,
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// `image/png;base64,...` to an image.
fn data_uri(rest: &str) -> Option<Image> {
    let (meta, data) = rest.split_once(',')?;
    let mime = meta.split(';').next().unwrap_or("");
    let bytes = if meta.contains(";base64") { base64(data)? } else { percent_decode(data).into_bytes() };
    let format = match mime {
        "image/png" => ImageFormat::Png,
        "image/jpeg" | "image/jpg" => ImageFormat::Jpeg,
        "image/gif" => ImageFormat::Gif,
        "image/webp" => ImageFormat::Webp,
        "image/svg+xml" => ImageFormat::Svg,
        "image/bmp" => ImageFormat::Bmp,
        _ => sniff(&bytes)?,
    };
    Some(Image::from_bytes(format, bytes))
}

fn base64(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b'\n' | b'\r' | b' ' => continue,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// The format of image bytes, by their magic number.
pub fn sniff(b: &[u8]) -> Option<ImageFormat> {
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some(ImageFormat::Png)
    } else if b.starts_with(&[0xff, 0xd8]) {
        Some(ImageFormat::Jpeg)
    } else if b.starts_with(b"GIF8") {
        Some(ImageFormat::Gif)
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some(ImageFormat::Webp)
    } else if b.starts_with(b"BM") {
        Some(ImageFormat::Bmp)
    } else if b.starts_with(b"II*\0") || b.starts_with(b"MM\0*") {
        Some(ImageFormat::Tiff)
    } else {
        let head = String::from_utf8_lossy(&b[..b.len().min(512)]).to_ascii_lowercase();
        (head.contains("<svg") || head.starts_with("<?xml")).then_some(ImageFormat::Svg)
    }
}

/// Fetch a remote picture (on a background thread), with the same caps
/// a browser would hit sooner or later: 20 MB and 15 seconds.
/// A remote picture, from the on-disk cache when it was fetched in the last
/// week (Electron gets this from Chromium's HTTP cache). The cache lives in
/// Markie RS's own data folder.
pub fn fetch(url: &str) -> Option<Image> {
    fetch_cached(url, &markie_core::paths::data_dir().join("Cache").join("pictures"))
}

const CACHE_AGE: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 3600);
const CACHE_MAX_FILES: usize = 2000;

fn cache_name(url: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut h);
    format!("{:016x}-{}", h.finish(), url.len())
}

pub fn fetch_cached(url: &str, dir: &Path) -> Option<Image> {
    let file = dir.join(cache_name(url));
    if let Ok(meta) = std::fs::metadata(&file) {
        let fresh = meta.modified().ok().and_then(|m| m.elapsed().ok()).is_some_and(|age| age < CACHE_AGE);
        if fresh {
            if let Ok(bytes) = std::fs::read(&file) {
                if let Some(format) = sniff(&bytes) {
                    return Some(Image::from_bytes(format, bytes));
                }
            }
        }
    }
    let img = fetch_remote(url)?;
    if std::fs::create_dir_all(dir).is_ok() {
        if std::fs::read_dir(dir).map(|d| d.count()).unwrap_or(0) >= CACHE_MAX_FILES {
            // Simple bound: start again rather than grow without limit.
            let _ = std::fs::remove_dir_all(dir);
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&file, img.bytes());
    }
    Some(img)
}

fn fetch_remote(url: &str) -> Option<Image> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Markie RS")
        .build()
        .ok()?;
    let resp = client.get(url).send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().ok()?;
    if bytes.len() > 20 * 1024 * 1024 {
        return None;
    }
    let format = sniff(&bytes)?;
    Some(Image::from_bytes(format, bytes.to_vec()))
}

/// A YouTube video's id, for its thumbnail.
pub fn youtube_id(url: &str) -> Option<String> {
    let lower = url.trim();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"))?;
    let (host, tail) = rest.split_once(['/', '?']).unwrap_or((rest, ""));
    let host = host.to_ascii_lowercase();
    if host == "youtu.be" {
        return Some(tail.split(['?', '#', '/']).next()?.to_string()).filter(|s| s.len() == 11);
    }
    if !host.ends_with("youtube.com") && !host.ends_with("youtube-nocookie.com") {
        return None;
    }
    if let Some(q) = tail.split_once('?').map(|(_, q)| q).or(tail.strip_prefix("watch?")) {
        for kv in q.split('&') {
            if let Some(v) = kv.strip_prefix("v=") {
                return Some(v.chars().take(11).collect());
            }
        }
    }
    let parts: Vec<&str> = tail.split(['/', '?', '#']).filter(|p| !p.is_empty()).collect();
    match parts.as_slice() {
        ["shorts" | "embed" | "live" | "v", id, ..] => Some(id.to_string()),
        _ => None,
    }
}

/// A CSS colour as TipTap's marks write it: `#rgb`, `#rrggbb`, `rgb(…)`,
/// `rgba(…)` or a few names.
pub fn css_color(s: &str) -> Option<Hsla> {
    let s = s.trim().to_ascii_lowercase();
    if let Some(hex) = s.strip_prefix('#') {
        let v = match hex.len() {
            3 => {
                let c: Vec<u32> = hex.chars().filter_map(|c| c.to_digit(16)).collect();
                if c.len() != 3 {
                    return None;
                }
                (c[0] * 17) << 16 | (c[1] * 17) << 8 | (c[2] * 17)
            }
            6 => u32::from_str_radix(hex, 16).ok()?,
            8 => u32::from_str_radix(&hex[..6], 16).ok()?,
            _ => return None,
        };
        return Some(rgb(v).into());
    }
    if let Some(inner) = s.strip_prefix("rgba(").or_else(|| s.strip_prefix("rgb(")) {
        let nums: Vec<f32> = inner.trim_end_matches(')').split([',', ' ', '/']).filter(|p| !p.is_empty()).filter_map(|p| p.trim_end_matches('%').parse().ok()).collect();
        if nums.len() >= 3 {
            let a = nums.get(3).copied().unwrap_or(1.0);
            return Some(Rgba { r: nums[0] / 255., g: nums[1] / 255., b: nums[2] / 255., a }.into());
        }
        return None;
    }
    let v = match s.as_str() {
        "red" => 0xff0000,
        "green" => 0x008000,
        "blue" => 0x0000ff,
        "orange" => 0xffa500,
        "purple" => 0x800080,
        "yellow" => 0xffff00,
        "gray" | "grey" => 0x808080,
        "black" => 0x000000,
        "white" => 0xffffff,
        "pink" => 0xffc0cb,
        _ => return None,
    };
    Some(rgb(v).into())
}

/// The first family of a CSS font stack, or None for the theme's own.
pub fn font_family(stack: &str) -> Option<SharedString> {
    let first = stack.split(',').next()?.trim().trim_matches(['"', '\'']);
    if first.is_empty() || first.starts_with("var(") {
        return None;
    }
    let generic = match first {
        "serif" => "Times New Roman",
        "sans-serif" | "system-ui" => return None,
        "monospace" => "Menlo",
        other => other,
    };
    Some(SharedString::from(generic.to_string()))
}

/// `20px`, `1.2em`, `14pt` as pixels at 100% zoom.
pub fn css_size(s: &str, base: f32) -> Option<f32> {
    let t = s.trim();
    let (num, unit) = t.find(|c: char| c.is_ascii_alphabetic() || c == '%').map(|i| t.split_at(i)).unwrap_or((t, "px"));
    let n: f32 = num.trim().parse().ok()?;
    let px = match unit {
        "px" | "" => n,
        "pt" => n * 4.0 / 3.0,
        "em" | "rem" => n * base,
        "%" => n * base / 100.0,
        _ => return None,
    };
    (px > 2.0 && px < 400.0).then_some(px)
}

impl Media {
    /// A formula as a picture, drawn at `scale` times its size for a sharp
    /// raster, measured at 1x.
    pub fn math(&mut self, source: &str, display: bool, color: Hsla, size: f32, scale: f32) -> Option<MathImage> {
        let rgba: Rgba = color.into();
        let packed = ((rgba.r * 255.) as u32) << 24 | ((rgba.g * 255.) as u32) << 16 | ((rgba.b * 255.) as u32) << 8 | (rgba.a * 255.) as u32;
        let key = (source.to_string(), display, packed, (size * scale * 10.) as u32);
        if let Some(v) = self.math.get(&key) {
            return v.clone();
        }
        let tex = markie_math::strip_delimiters(source).map(|(t, _)| t).unwrap_or(source);
        let style = markie_math::MathStyle {
            color: [(rgba.r * 255.) as u8, (rgba.g * 255.) as u8, (rgba.b * 255.) as u8, (rgba.a * 255.) as u8],
            font_size_pt: size * scale,
        };
        let out = match markie_math::render(tex, display, &style) {
            Ok(r) => Some(MathImage {
                image: Arc::new(Image::from_bytes(ImageFormat::Svg, r.svg.into_bytes())),
                width: r.width_pt / scale,
                height: r.height_pt / scale,
                baseline: r.baseline_pt / scale,
            }),
            Err(_) => None,
        };
        if self.math.len() > 2000 {
            self.math.clear();
        }
        self.math.insert(key, out.clone());
        out
    }
}
