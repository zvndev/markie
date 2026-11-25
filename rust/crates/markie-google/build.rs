// The Desktop OAuth client is compiled in (src/config.rs). Rebuild when it changes.
fn main() {
    println!("cargo:rerun-if-env-changed=MARKIE_GOOGLE_DESKTOP_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=MARKIE_GOOGLE_DESKTOP_CLIENT_SECRET");
}
