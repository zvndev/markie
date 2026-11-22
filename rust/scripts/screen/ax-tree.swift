// Print the accessibility tree of one running app, by PID, without
// VoiceOver: `swift rust/scripts/screen/ax-tree.swift <pid>`.
// The first request turns AccessKit on in Markie RS; the tree follows a
// frame later. Needs the Accessibility permission for the calling app and
// an unlocked session (on a locked screen every query answers with the
// application element itself). With MARKIE_RS_A11Y_DUMP=<file> set, a debug
// build of Markie RS also writes GPUI's own copy of the tree as JSON.
import ApplicationServices
import Foundation

let pid = pid_t(CommandLine.arguments[1])!
let app = AXUIElementCreateApplication(pid)

func attr(_ e: AXUIElement, _ a: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil
}

var seen = Set<UInt>()
func dump(_ e: AXUIElement, _ depth: Int) {
    if depth > 40 || !seen.insert(UInt(CFHash(e))).inserted { return }
    let role = attr(e, kAXRoleAttribute) as? String ?? "?"
    if role == "AXMenuBar" { return }
    let sub = attr(e, kAXSubroleAttribute) as? String ?? ""
    let desc = attr(e, kAXRoleDescriptionAttribute) as? String ?? ""
    var value = ""
    if let v = attr(e, kAXValueAttribute) {
        value = String(String(describing: v).prefix(48)).replacingOccurrences(of: "\n", with: " ")
    }
    print(String(repeating: "  ", count: depth) + "\(role) \(sub) [\(desc)] \(value)")
    for k in attr(e, kAXChildrenAttribute) as? [AXUIElement] ?? [] { dump(k, depth + 1) }
}

_ = attr(app, kAXWindowsAttribute)
Thread.sleep(forTimeInterval: 1.5)
for w in attr(app, kAXWindowsAttribute) as? [AXUIElement] ?? [] { dump(w, 0) }
