import UIKit
import UniformTypeIdentifiers
import Capacitor

/// The page's door to files on this device (src/lib/local-files.ts).
///
/// It shows the system's own pickers and passes everything else to
/// LocalFilesStore, which holds the rules. The page never names a path on
/// disk: it names a grant by its id, and for a folder a path inside it.
@objc(MarkieLocalFilesPlugin)
public class MarkieLocalFilesPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "MarkieLocalFilesPlugin"
    public let jsName = "MarkieLocalFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickDocument", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "grants", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "adopt", returnType: CAPPluginReturnPromise),
    ]

    private let store = LocalFilesStore.shared
    /// File work waits on other apps and on iCloud, so it stays off the main thread.
    private let work = DispatchQueue(label: "com.zvn.markie.mobile.local-files", qos: .userInitiated)
    private var picking: (call: CAPPluginCall, kind: String)?

    // MARK: Pickers

    /// The kinds the app reads: text of every sort, and the documents it turns into text.
    private static let documentTypes: [UTType] = {
        var types: [UTType] = [.text, .plainText, .json, .xml, .yaml, .commaSeparatedText, .tabSeparatedText, .html, .rtf]
        let identifiers = ["net.daringfireball.markdown", "com.zvn.markie.darkmown", "org.openxmlformats.wordprocessingml.document", "org.oasis-open.opendocument.text"]
        types += identifiers.compactMap { UTType($0) }
        types += ["md", "markdown", "mdx", "wd", "log", "toml", "ini", "yml"].compactMap { UTType(filenameExtension: $0) }
        return types
    }()

    @objc func pickDocument(_ call: CAPPluginCall) { present(kind: "file", types: Self.documentTypes, call) }

    @objc func pickFolder(_ call: CAPPluginCall) { present(kind: "folder", types: [.folder], call) }

    private func present(kind: String, types: [UTType], _ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.picking == nil, let host = self.bridge?.viewController else {
                call.reject("Another file chooser is already open.", "failed")
                return
            }
            // asCopy false: the URL is the person's own file, to edit where it is.
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: false)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            self.picking = (call, kind)
            host.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let picking else { return }
        self.picking = nil
        guard let url = urls.first else { picking.call.resolve([:]); return }
        // The bookmark is made at once: this URL object is the only thing
        // that carries the permission, and it does not outlive the app.
        work.async {
            do {
                let grant = try self.store.add(url: url, kind: picking.kind)
                picking.call.resolve(["grant": Self.json(grant, reachable: true)])
            } catch {
                Self.reject(picking.call, error)
            }
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        picking?.call.resolve([:])
        picking = nil
    }

    // MARK: Grants

    @objc func grants(_ call: CAPPluginCall) {
        work.async {
            call.resolve(["grants": self.store.all().map { Self.json($0.grant, reachable: $0.reachable) }])
        }
    }

    @objc func forget(_ call: CAPPluginCall) {
        guard let id = call.getString("grantId") else { call.reject("No grant named.", "failed"); return }
        store.forget(id)
        call.resolve()
    }

    /// A file URL another app opened in Markie. In place: the grant the scene
    /// delegate made for it. A copy in the app's Inbox: nothing, and the page
    /// reads the copy as before.
    @objc func adopt(_ call: CAPPluginCall) {
        guard let url = call.getString("url"), let grant = store.takeIncoming(urlString: url) else { call.resolve([:]); return }
        call.resolve(["grant": Self.json(grant, reachable: true)])
    }

    // MARK: Files

    @objc func list(_ call: CAPPluginCall) {
        guard let id = call.getString("grantId") else { call.reject("No grant named.", "failed"); return }
        let entry = call.getString("entry")
        work.async {
            do {
                let entries = try self.store.list(grantId: id, entry: entry)
                call.resolve(["entries": entries.map(Self.json)])
            } catch {
                Self.reject(call, error)
            }
        }
    }

    @objc func read(_ call: CAPPluginCall) {
        guard let id = call.getString("grantId") else { call.reject("No grant named.", "failed"); return }
        let entry = call.getString("entry")
        work.async {
            do {
                let file = try self.store.read(grantId: id, entry: entry)
                var result: [String: Any] = ["name": file.name, "data": file.data.base64EncodedString(), "hash": file.hash, "writable": file.writable]
                if let modified = file.modified { result["modified"] = modified }
                call.resolve(result)
            } catch {
                Self.reject(call, error)
            }
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let id = call.getString("grantId"), let encoded = call.getString("data"), let data = Data(base64Encoded: encoded) else {
            call.reject("Nothing to save.", "failed")
            return
        }
        let entry = call.getString("entry")
        let baseHash = call.getString("baseHash")
        work.async {
            do {
                let saved = try self.store.write(grantId: id, entry: entry, data: data, baseHash: baseHash)
                var result: [String: Any] = ["hash": saved.hash]
                if let modified = saved.modified { result["modified"] = modified }
                call.resolve(result)
            } catch {
                Self.reject(call, error)
            }
        }
    }

    @objc func create(_ call: CAPPluginCall) {
        guard let id = call.getString("grantId"), let name = call.getString("name"), let encoded = call.getString("data"), let data = Data(base64Encoded: encoded) else {
            call.reject("Nothing to save.", "failed")
            return
        }
        let parent = call.getString("parent")
        work.async {
            do {
                call.resolve(["entry": Self.json(try self.store.create(grantId: id, parent: parent, name: name, data: data))])
            } catch {
                Self.reject(call, error)
            }
        }
    }

    // MARK: Shapes

    private static func reject(_ call: CAPPluginCall, _ error: Error) {
        let known = error as? LocalFilesError ?? .failed("That didn't work. Try again.")
        call.reject(known.message, known.code)
    }

    private static func json(_ grant: LocalGrant, reachable: Bool) -> [String: Any] {
        ["id": grant.id, "kind": grant.kind, "name": grant.name, "usedAt": grant.usedAt, "reachable": reachable, "persisted": true]
    }

    private static func json(_ entry: LocalEntry) -> [String: Any] {
        var result: [String: Any] = ["id": entry.id, "name": entry.name, "folder": entry.folder]
        if let size = entry.size { result["size"] = size }
        if let modified = entry.modified { result["modified"] = modified }
        return result
    }
}
