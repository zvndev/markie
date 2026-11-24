//! Making the bundled fonts available to this process on macOS.
//!
//! The files are Electron's woff2 files, mostly variable. CoreText reads
//! woff2 and hands out every named weight of a variable font as its own face,
//! which is what GPUI's font matching needs. GPUI's own `add_fonts` takes
//! neither (CoreGraphics does not decode woff2, and one data blob is one
//! face), so the files are registered with CoreText instead, for this process
//! only (`kCTFontManagerScopeProcess`). Nothing is installed: no system font
//! folder is touched, and no other app sees them.
//!
//! CoreText registers a font from a file, so the embedded bytes are written
//! once to a cache folder inside the app's own data folder.

use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
mod ct {
    use std::ffi::c_void;
    use std::path::Path;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFURLCreateFromFileSystemRepresentation(allocator: *const c_void, buffer: *const u8, len: isize, is_directory: u8) -> *const c_void;
        fn CFRelease(cf: *const c_void);
        fn CFArrayGetCount(array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
        fn CFStringGetCString(string: *const c_void, buffer: *mut u8, size: isize, encoding: u32) -> u8;
    }

    #[link(name = "CoreText", kind = "framework")]
    unsafe extern "C" {
        fn CTFontManagerRegisterFontsForURL(url: *const c_void, scope: u32, error: *mut *const c_void) -> u8;
        fn CTFontManagerCreateFontDescriptorsFromURL(url: *const c_void) -> *const c_void;
        fn CTFontDescriptorCopyAttribute(descriptor: *const c_void, attribute: *const c_void) -> *const c_void;
        static kCTFontFamilyNameAttribute: *const c_void;
    }

    /// `kCFStringEncodingUTF8`.
    const UTF8: u32 = 0x0800_0100;

    /// `kCTFontManagerScopeProcess`.
    const SCOPE_PROCESS: u32 = 1;

    /// Register the file, and say which family name CoreText files it
    /// under. That is the font's own family name (name ID 1), which for a
    /// variable font whose default is not Regular reads "Source Sans 3
    /// ExtraLight", not the name a stylesheet gives it.
    pub fn register(path: &Path) -> Option<String> {
        use std::os::unix::ffi::OsStrExt;
        let bytes = path.as_os_str().as_bytes();
        // SAFETY: the buffer is valid for `len` bytes; everything created or
        // copied here is released here; a null error pointer is allowed.
        unsafe {
            let url = CFURLCreateFromFileSystemRepresentation(std::ptr::null(), bytes.as_ptr(), bytes.len() as isize, 0);
            if url.is_null() {
                return None;
            }
            let ok = CTFontManagerRegisterFontsForURL(url, SCOPE_PROCESS, std::ptr::null_mut()) != 0;
            let mut family = None;
            let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url);
            if !descriptors.is_null() {
                if CFArrayGetCount(descriptors) > 0 {
                    let name = CTFontDescriptorCopyAttribute(CFArrayGetValueAtIndex(descriptors, 0), kCTFontFamilyNameAttribute);
                    if !name.is_null() {
                        let mut buffer = [0u8; 256];
                        if CFStringGetCString(name, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) != 0 {
                            let end = buffer.iter().position(|b| *b == 0).unwrap_or(0);
                            family = std::str::from_utf8(&buffer[..end]).ok().map(str::to_string);
                        }
                        CFRelease(name);
                    }
                }
                CFRelease(descriptors);
            }
            CFRelease(url);
            ok.then_some(family).flatten()
        }
    }
}

static NATIVE_NAMES: std::sync::RwLock<std::collections::BTreeMap<String, String>> = std::sync::RwLock::new(std::collections::BTreeMap::new());

/// The family name the text system knows a registered bundled family by,
/// when it is not the family's own name.
pub fn native_name(id: &str) -> Option<String> {
    NATIVE_NAMES.read().unwrap().get(id).cloned()
}

/// Write `bytes` to `path` unless a file of that size is already there.
fn ensure_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if std::fs::metadata(path).is_ok_and(|m| m.len() == bytes.len() as u64) {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// Where a bundled file is kept on disk: named by its content, so an update
/// that changes a font writes a new file and never a half-old one.
fn cache_path(cache: &Path, file: &super::FontFile) -> PathBuf {
    let name = file.file.replace('/', "-");
    cache.join(format!("{}-{name}", &file.sha256[..12]))
}

/// Register every bundled family for this process. Returns how many files
/// are registered. Safe to call more than once; later calls do nothing.
pub fn register_bundled(cache: &Path) -> usize {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static DONE: AtomicUsize = AtomicUsize::new(usize::MAX);
    let done = DONE.load(Ordering::Acquire);
    if done != usize::MAX {
        return done;
    }
    let mut count = 0;
    for family in super::bundled_families() {
        for file in &family.files {
            let Some(bytes) = super::bundled_file(&file.file) else { continue };
            let path = cache_path(cache, file);
            if ensure_file(&path, bytes).is_err() {
                continue;
            }
            #[cfg(target_os = "macos")]
            if let Some(native) = ct::register(&path) {
                count += 1;
                if native != family.family {
                    NATIVE_NAMES.write().unwrap().insert(family.id.clone(), native);
                }
            }
        }
    }
    DONE.store(count, Ordering::Release);
    count
}

/// Register one font file for this process (a document's own embedded font,
/// already written under a private family name).
pub fn register_file(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        ct::register(path).is_some()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        false
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn files_are_written_once_under_their_content_hash() {
        let dir = tempfile::tempdir().unwrap();
        let inter = super::super::bundled_family("inter").unwrap();
        let path = super::cache_path(dir.path(), &inter.files[0]);
        assert!(path.file_name().unwrap().to_str().unwrap().ends_with("-inter-Inter.woff2"));
        let bytes = super::super::bundled_file(&inter.files[0].file).unwrap();
        super::ensure_file(&path, bytes).unwrap();
        let first = std::fs::metadata(&path).unwrap().modified().unwrap();
        super::ensure_file(&path, bytes).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), first);
        assert_eq!(std::fs::read(&path).unwrap().len(), inter.files[0].bytes);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn every_bundled_file_registers_with_core_text() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(super::register_bundled(dir.path()), 54);
        assert_eq!(super::register_bundled(dir.path()), 54);
        // CoreText files a variable font under its default instance's name.
        assert_eq!(super::native_name("source-sans").as_deref(), Some("Source Sans 3 ExtraLight"));
        assert_eq!(super::native_name("inter"), None);
        assert_eq!(super::super::native_family("source-code").as_deref(), Some("Source Code Pro ExtraLight"));
        assert_eq!(super::super::native_family("inter").as_deref(), Some("Inter"));
    }
}
