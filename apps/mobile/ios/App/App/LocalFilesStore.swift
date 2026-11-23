import Foundation
import CryptoKit

/// Files and folders on this device that the person let Markie use.
///
/// A file outside the app's container can only be touched through a URL the
/// system handed over (the document picker, or "Open in Markie" from Files).
/// That permission ends with the app unless it is turned into a
/// security-scoped bookmark, so each one is kept here as a grant: a bookmark,
/// a name, and whether it is one file or a folder. A folder's bookmark covers
/// everything inside it.
///
/// The rules this file keeps, every time:
///   - A grant is opened only for the length of one operation, and always
///     closed again (`withAccess`).
///   - A path inside a folder is checked to still be inside it once links are
///     followed, so nothing reaches outside what was granted (`child`).
///   - Every read and write goes through NSFileCoordinator, because the file
///     may be an iCloud placeholder or open in another app.
///   - A save writes the whole new text to a scratch file first and swaps it
///     in. The original is never cut short and never half written.
///   - A save says which bytes it started from. If the file holds anything
///     else by then, nothing is written.
///
/// Nothing here goes to a server. The JavaScript side is src/lib/local-files.ts.
enum LocalFilesError: Error {
    case unreachable   // the grant no longer opens: revoked, moved, deleted
    case missing       // the file itself is gone
    case changed       // the file holds different bytes than the save started from
    case tooLarge
    case exists
    case outside       // a path that leaves the granted folder
    case failed(String)

    var code: String {
        switch self {
        case .unreachable: return "unreachable"
        case .missing: return "missing"
        case .changed: return "changed"
        case .tooLarge: return "too-large"
        case .exists: return "exists"
        case .outside: return "outside"
        case .failed: return "failed"
        }
    }

    var message: String {
        switch self {
        case .unreachable: return "Markie can't reach this any more."
        case .missing: return "This file was moved or deleted."
        case .changed: return "This file changed since it was opened."
        case .tooLarge: return "This file is too large to open on a phone."
        case .exists: return "A file with that name is already there."
        case .outside: return "That is outside the folder Markie was given."
        case .failed(let why): return why
        }
    }
}

struct LocalGrant: Codable {
    var id: String
    /// "file" or "folder".
    var kind: String
    var name: String
    var bookmark: Data
    /// Milliseconds since 1970, for "most recent first" and for eviction.
    var usedAt: Double
}

struct LocalEntry {
    let id: String
    let name: String
    let folder: Bool
    let size: Int?
    let modified: Double?
}

struct LocalRead {
    let name: String
    let data: Data
    let hash: String
    let modified: Double?
    let writable: Bool
}

final class LocalFilesStore {
    static let shared = LocalFilesStore()

    /// The same cap the page applies to a file from another app.
    static let maxBytes = 16 * 1024 * 1024
    /// Single files are remembered as recents; the oldest go first. Folders are never evicted.
    static let maxFileGrants = 50

    private let lock = NSRecursiveLock()
    private var grants: [LocalGrant] = []
    /// Files the system opened in place this launch, by path, until the page asks for them.
    private var incoming: [String: String] = [:]
    private let storeURL: URL

    private init() {
        let files = FileManager.default
        let support = (try? files.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? files.temporaryDirectory
        var folder = support.appendingPathComponent("LocalFiles", isDirectory: true)
        try? files.createDirectory(at: folder, withIntermediateDirectories: true)
        // A bookmark only works on the device that made it.
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? folder.setResourceValues(values)
        storeURL = folder.appendingPathComponent("grants.json")
        if let data = try? Data(contentsOf: storeURL), let saved = try? JSONDecoder().decode([LocalGrant].self, from: data) {
            grants = saved
        }
    }

    // MARK: Grants

    /// Remembers a URL the system just handed over. Call it while the URL is
    /// still the system's own object: only that one carries the permission.
    func add(url: URL, kind: String) throws -> LocalGrant {
        let started = url.startAccessingSecurityScopedResource()
        defer { if started { url.stopAccessingSecurityScopedResource() } }
        let bookmark: Data
        do {
            bookmark = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
        } catch {
            throw LocalFilesError.failed("Markie couldn't keep access to that. Try choosing it again.")
        }
        lock.lock()
        defer { lock.unlock() }
        let path = url.standardizedFileURL.path
        let now = Date().timeIntervalSince1970 * 1000
        // The same file or folder chosen twice is one grant, not two.
        if let index = grants.firstIndex(where: { $0.kind == kind && self.resolve($0)?.url.standardizedFileURL.path == path }) {
            grants[index].bookmark = bookmark
            grants[index].name = url.lastPathComponent
            grants[index].usedAt = now
            persist()
            return grants[index]
        }
        let grant = LocalGrant(id: UUID().uuidString, kind: kind, name: url.lastPathComponent, bookmark: bookmark, usedAt: now)
        grants.append(grant)
        let fileGrants = grants.filter { $0.kind == "file" }.sorted { $0.usedAt < $1.usedAt }
        if fileGrants.count > Self.maxFileGrants {
            let drop = Set(fileGrants.prefix(fileGrants.count - Self.maxFileGrants).map(\.id))
            grants.removeAll { drop.contains($0.id) }
        }
        persist()
        return grant
    }

    /// Every grant, and whether it still opens.
    func all() -> [(grant: LocalGrant, reachable: Bool)] {
        lock.lock()
        let snapshot = grants
        lock.unlock()
        return snapshot.map { grant in
            let reachable = (try? withAccess(grant.id, entry: nil, touch: false) { url in
                (try? url.checkResourceIsReachable()) == true
            }) ?? false
            return (grant, reachable)
        }
    }

    func forget(_ id: String) {
        lock.lock()
        grants.removeAll { $0.id == id }
        incoming = incoming.filter { $0.value != id }
        persist()
        lock.unlock()
    }

    /// A file the system opened in place ("Open in Markie" from Files). The
    /// page only ever sees the URL as text, which carries no permission, so
    /// the grant is made here, while the system's own URL is in hand.
    func noteIncoming(url: URL) {
        guard url.isFileURL, let grant = try? add(url: url, kind: "file") else { return }
        lock.lock()
        incoming[url.standardizedFileURL.path] = grant.id
        lock.unlock()
    }

    /// The grant made for a file opened in place, once. Nil when the system
    /// handed over a copy instead (Mail, AirDrop), which the page reads itself.
    func takeIncoming(urlString: String) -> LocalGrant? {
        guard let url = URL(string: urlString), url.isFileURL else { return nil }
        lock.lock()
        defer { lock.unlock() }
        guard let id = incoming.removeValue(forKey: url.standardizedFileURL.path) else { return nil }
        return grants.first { $0.id == id }
    }

    // MARK: Reading and writing

    func list(grantId: String, entry: String?) throws -> [LocalEntry] {
        try withAccess(grantId, entry: entry) { folder in
            let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey]
            let items: [URL] = try self.coordinatedRead(folder) { target in
                do {
                    return try FileManager.default.contentsOfDirectory(at: target, includingPropertiesForKeys: keys, options: [])
                } catch {
                    throw LocalFilesError.unreachable
                }
            }
            var entries: [LocalEntry] = []
            for item in items {
                var name = item.lastPathComponent
                // A file iCloud has not downloaded yet is listed as ".Plan.md.icloud".
                // Reading it by its real name brings it down.
                if name.hasPrefix("."), name.hasSuffix(".icloud"), name.count > 8 {
                    name = String(name.dropFirst().dropLast(7))
                } else if name.hasPrefix(".") {
                    continue
                }
                let values = try? item.resourceValues(forKeys: Set(keys))
                // A link may point anywhere. It is not followed, so it is not shown.
                if values?.isSymbolicLink == true { continue }
                entries.append(LocalEntry(
                    id: (entry.map { $0 + "/" } ?? "") + name,
                    name: name,
                    folder: values?.isDirectory == true,
                    size: values?.fileSize,
                    modified: values?.contentModificationDate.map { $0.timeIntervalSince1970 * 1000 }
                ))
            }
            return entries
        }
    }

    func read(grantId: String, entry: String?) throws -> LocalRead {
        try withAccess(grantId, entry: entry) { url in
            let data: Data = try self.coordinatedRead(url) { target in
                let size = (try? target.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                if size > Self.maxBytes { throw LocalFilesError.tooLarge }
                guard FileManager.default.fileExists(atPath: target.path) else { throw LocalFilesError.missing }
                do { return try Data(contentsOf: target) } catch { throw LocalFilesError.unreachable }
            }
            if data.count > Self.maxBytes { throw LocalFilesError.tooLarge }
            return LocalRead(
                name: url.lastPathComponent,
                data: data,
                hash: Self.sha256(data),
                modified: Self.modified(url),
                writable: FileManager.default.isWritableFile(atPath: url.path)
            )
        }
    }

    /// Saves `data` over the file. `baseHash` is the SHA-256 of the bytes the
    /// edit started from: when the file holds anything else, nothing is
    /// written and `.changed` is thrown. Pass nil only after the person chose
    /// to write over the other version.
    func write(grantId: String, entry: String?, data: Data, baseHash: String?) throws -> (hash: String, modified: Double?) {
        try withAccess(grantId, entry: entry) { url in
            // forMerging: another app holding this file open is asked to save
            // its own changes first, so the check below sees them.
            try self.coordinatedWrite(url, options: .forMerging) { target in
                let files = FileManager.default
                let present = files.fileExists(atPath: target.path)
                if let baseHash {
                    guard present else { throw LocalFilesError.missing }
                    guard let current = try? Data(contentsOf: target) else { throw LocalFilesError.unreachable }
                    guard Self.sha256(current) == baseHash else { throw LocalFilesError.changed }
                }
                try Self.replace(target, with: data, wasPresent: present)
            }
            // The swap gives the file a new identity on disk. A single file's
            // bookmark is made again now, while access is still open.
            if entry == nil { self.refreshBookmark(grantId, url: url) }
            return (Self.sha256(data), Self.modified(url))
        }
    }

    /// Makes a new file in a granted folder. Never replaces one that is there.
    func create(grantId: String, parent: String?, name: String, data: Data) throws -> LocalEntry {
        guard !name.isEmpty, !name.contains("/"), name != ".", name != ".." else { throw LocalFilesError.outside }
        let entry = (parent.map { $0 + "/" } ?? "") + name
        return try withAccess(grantId, entry: entry) { url in
            try self.coordinatedWrite(url, options: []) { target in
                do {
                    // withoutOverwriting fails rather than replace. A new file
                    // has no earlier bytes to protect.
                    try data.write(to: target, options: .withoutOverwriting)
                } catch let error as CocoaError where error.code == .fileWriteFileExists {
                    throw LocalFilesError.exists
                } catch {
                    throw LocalFilesError.failed("Markie couldn't make that file.")
                }
            }
            return LocalEntry(id: entry, name: name, folder: false, size: data.count, modified: Self.modified(url))
        }
    }

    // MARK: The pieces

    /// The new bytes go to a scratch file, in full, and are then swapped in
    /// for the original in one step. Until the swap the original is whole.
    private static func replace(_ target: URL, with data: Data, wasPresent: Bool) throws {
        let files = FileManager.default
        var swapped = false
        if let scratchFolder = try? files.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: target, create: true) {
            defer { try? files.removeItem(at: scratchFolder) }
            let scratch = scratchFolder.appendingPathComponent(target.lastPathComponent)
            if (try? data.write(to: scratch, options: [])) != nil {
                swapped = (try? files.replaceItemAt(target, withItemAt: scratch, backupItemName: nil, options: [])) != nil
            }
        }
        if !swapped {
            // Some storage providers give no place to swap from. The swap did
            // not happen, so the original is still whole. Writing straight
            // into it is the only way left to save there at all.
            do { try data.write(to: target, options: []) } catch {
                throw LocalFilesError.failed("Markie couldn't save this file. Your text is still here.")
            }
        }
        // Read back what is there now. A save that did not land is an error
        // the person sees, with their text still on screen.
        guard let written = try? Data(contentsOf: target), written == data else {
            throw LocalFilesError.failed("The file didn't save correctly. Your text is still here. Try again.")
        }
    }

    /// Opens a grant for one operation and closes it again, whatever happens.
    private func withAccess<T>(_ grantId: String, entry: String?, touch: Bool = true, _ body: (URL) throws -> T) throws -> T {
        lock.lock()
        let grant = grants.first { $0.id == grantId }
        lock.unlock()
        guard let grant, let resolved = resolve(grant) else { throw LocalFilesError.unreachable }
        let root = resolved.url
        // False for a URL that needs no permission; the work below still says
        // whether the file can really be reached.
        let started = root.startAccessingSecurityScopedResource()
        defer { if started { root.stopAccessingSecurityScopedResource() } }
        if resolved.stale { refreshBookmark(grantId, url: root) }
        if touch { markUsed(grantId) }
        if grant.kind == "file" {
            guard entry == nil || entry == "" else { throw LocalFilesError.outside }
            return try body(root)
        }
        return try body(try Self.child(of: root, entry: entry))
    }

    /// A path inside a granted folder. Refused when any part climbs out, and
    /// refused when following links lands anywhere outside the folder.
    private static func child(of root: URL, entry: String?) throws -> URL {
        guard let entry, !entry.isEmpty else { return root }
        var url = root
        for part in entry.split(separator: "/", omittingEmptySubsequences: false) {
            let name = String(part)
            if name.isEmpty || name == "." || name == ".." || name.contains("\0") { throw LocalFilesError.outside }
            url.appendPathComponent(name)
        }
        let rootPath = root.resolvingSymlinksInPath().standardizedFileURL.path
        let childPath = url.resolvingSymlinksInPath().standardizedFileURL.path
        guard childPath.hasPrefix(rootPath.hasSuffix("/") ? rootPath : rootPath + "/") else { throw LocalFilesError.outside }
        return url
    }

    private func resolve(_ grant: LocalGrant) -> (url: URL, stale: Bool)? {
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: grant.bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
        return (url, stale)
    }

    private func refreshBookmark(_ grantId: String, url: URL) {
        guard let bookmark = try? url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil) else { return }
        lock.lock()
        if let index = grants.firstIndex(where: { $0.id == grantId }) {
            grants[index].bookmark = bookmark
            persist()
        }
        lock.unlock()
    }

    private func markUsed(_ grantId: String) {
        lock.lock()
        if let index = grants.firstIndex(where: { $0.id == grantId }) {
            grants[index].usedAt = Date().timeIntervalSince1970 * 1000
            persist()
        }
        lock.unlock()
    }

    /// Call with the lock held.
    private func persist() {
        guard let data = try? JSONEncoder().encode(grants) else { return }
        try? data.write(to: storeURL, options: .atomic)
    }

    private func coordinatedRead<T>(_ url: URL, _ body: (URL) throws -> T) throws -> T {
        var coordination: NSError?
        var result: Result<T, Error>?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &coordination) { target in
            result = Result { try body(target) }
        }
        guard let result, coordination == nil else { throw LocalFilesError.unreachable }
        return try result.get()
    }

    private func coordinatedWrite(_ url: URL, options: NSFileCoordinator.WritingOptions, _ body: (URL) throws -> Void) throws {
        var coordination: NSError?
        var result: Result<Void, Error>?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: options, error: &coordination) { target in
            result = Result { try body(target) }
        }
        guard let result, coordination == nil else { throw LocalFilesError.unreachable }
        try result.get()
    }

    private static func modified(_ url: URL) -> Double? {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate.map { $0.timeIntervalSince1970 * 1000 }
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
