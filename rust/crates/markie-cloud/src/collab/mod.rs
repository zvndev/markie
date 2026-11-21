//! Live text rooms: plain-text documents edited together over y-websocket.
//! Port of src/lib/collab.ts, text-collab.ts and the text half of
//! live-snapshot.ts. Rich rooms (the TipTap XmlFragment) are out of scope here.
pub mod room;
pub mod snapshot;
pub mod text;
pub mod ticket;

/// The newest room schema this build reads and writes. Sent with each ticket request.
pub const COLLAB_SCHEMA_VERSION: i64 = 2;
/// Plain text rooms (Y.Text) are byte-faithful to every build.
pub const TEXT_ROOM_SCHEMA: i64 = 1;
/// Shared-type name for the text body. The server's seed lock knows it too.
pub const TEXT_COLLAB_KEY: &str = "content";
pub const META_MAP: &str = "meta";
pub const SCHEMA_KEY: &str = "schemaVersion";
pub const MODEL_KEY: &str = "editorModel";
pub const EDITOR_MODEL: i64 = 2;
pub const CONTENT_KIND_KEY: &str = "contentKind";
/// Access to the document went away mid-session.
pub const CLOSE_ACCESS_REVOKED: u16 = 4403;
/// The room needs a newer client than this one.
pub const CLOSE_ROOM_TOO_NEW: u16 = 4426;
/// Wait after the first sync before seeding an empty room.
pub const SEED_SETTLE_MS: u64 = 150;

/// A peer's presence identity, as the server stamps it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PeerUser {
    pub name: String,
    pub color: String,
}

const PEER_COLORS: [&str; 8] = ["#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#ef4444", "#14b8a6", "#eab308"];

/// The same colour every client and the server pick for a name.
pub fn color_for_name(name: &str) -> &'static str {
    let mut hash: i32 = 0;
    for unit in name.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    PEER_COLORS[((hash as i64).abs() % PEER_COLORS.len() as i64) as usize]
}

/// Two-letter initials for an avatar.
pub fn initials(name: &str) -> String {
    let parts: Vec<&str> = name.trim().split(|c: char| c.is_whitespace() || c == '@' || c == '.').filter(|s| !s.is_empty()).collect();
    match parts.as_slice() {
        [] => "?".into(),
        [one] => one.chars().take(2).collect::<String>().to_uppercase(),
        [a, b, ..] => format!("{}{}", a.chars().next().unwrap(), b.chars().next().unwrap()).to_uppercase(),
    }
}

/// `wss://<server>/collab` for an https server, `ws://` for http.
pub fn collab_ws_base(origin: &str) -> String {
    let o = origin.trim_end_matches('/');
    let ws = if let Some(rest) = o.strip_prefix("https://") { format!("wss://{rest}") } else if let Some(rest) = o.strip_prefix("http://") { format!("ws://{rest}") } else { o.to_string() };
    format!("{ws}/collab")
}

/// The socket address for a room, with its ticket.
pub fn room_url(ws_base: &str, doc_id: &str, ticket: &str) -> String {
    format!("{ws_base}/{}?ticket={}", crate::client::seg(doc_id), crate::client::seg(ticket))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_match_the_js_hash() {
        // Reference values computed with src/lib/collab.ts colorForName.
        assert_eq!(color_for_name("Alice"), "#f59e0b");
        assert_eq!(color_for_name("bob@example.com"), "#3b82f6");
        assert_eq!(color_for_name("Someone"), "#14b8a6");
        assert_eq!(color_for_name("Zoë 🎉 long name for overflow testing"), "#ef4444");
    }

    #[test]
    fn initials_and_urls() {
        assert_eq!(initials("Ada Lovelace"), "AL");
        assert_eq!(initials("ada@example.com"), "AE");
        assert_eq!(initials("x"), "X");
        assert_eq!(initials("  "), "?");
        assert_eq!(collab_ws_base("https://api.markiedocs.com"), "wss://api.markiedocs.com/collab");
        assert_eq!(collab_ws_base("http://localhost:8787/"), "ws://localhost:8787/collab");
        assert_eq!(room_url("wss://h/collab", "abc", "t+/="), "wss://h/collab/abc?ticket=t%2B%2F%3D");
    }
}
