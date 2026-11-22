// postscroll: send <count> scroll-wheel events of <dy> pixels, <gap-ms>
// apart, at the current mouse position. Half go down, half come back up.
// Called by `act.sh <pid> scroll …`, which has already put the pointer over
// that PID's window and checked that it is frontmost.
//
//   postscroll <pid> <dy> <count> <gap-ms>
//
// Before every tenth event it checks that the window under the pointer still
// belongs to <pid>, and stops (exit 3) if not, so a moved mouse can never
// scroll someone else's window.
import CoreGraphics
import Foundation

let a = CommandLine.arguments
guard a.count == 5, let pid = Int32(a[1]), let dy = Int32(a[2]), let count = Int(a[3]), let gap = Double(a[4]) else {
  FileHandle.standardError.write("usage: postscroll <pid> <dy> <count> <gap-ms>\n".data(using: .utf8)!)
  exit(64)
}

func ownerUnderPointer() -> Int32? {
  guard let loc = CGEvent(source: nil)?.location,
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
  else { return nil }
  for w in list {  // front to back
    guard (w[kCGWindowLayer as String] as? Int) == 0,
          let b = w[kCGWindowBounds as String] as? [String: Double] else { continue }
    let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
    if r.contains(loc) { return w[kCGWindowOwnerPID as String] as? Int32 }
  }
  return nil
}

for i in 0..<count {
  if i % 10 == 0 && ownerUnderPointer() != pid {
    FileHandle.standardError.write("postscroll: pointer left pid \(pid)'s window; stopped\n".data(using: .utf8)!)
    exit(3)
  }
  let delta = i < count / 2 ? dy : -dy
  if let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0) {
    e.post(tap: .cghidEventTap)
  }
  usleep(useconds_t(gap * 1000))
}
