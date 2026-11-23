// taps: list the session's event taps, the process that owns each, and
// whether it only listens or can drop and delay events.
//   swiftc -O rust/scripts/screen/taps.swift -o rust/target/bench-tools/taps
//   rust/target/bench-tools/taps
// A filtering tap (listenOnly=false) on mouse events, with a large average
// latency, swallows synthetic presses and releases for every app on screen.
import CoreGraphics
import Foundation

var count: UInt32 = 0
CGGetEventTapList(0, nil, &count)
var taps = [CGEventTapInformation](repeating: CGEventTapInformation(), count: Int(count))
CGGetEventTapList(count, &taps, &count)
for t in taps {
  let ps = Process()
  ps.executableURL = URL(fileURLWithPath: "/bin/ps")
  ps.arguments = ["-o", "comm=", "-p", "\(t.tappingProcess)"]
  let pipe = Pipe()
  ps.standardOutput = pipe
  try? ps.run()
  ps.waitUntilExit()
  let name = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
    .trimmingCharacters(in: .whitespacesAndNewlines) ?? "?"
  print("pid \(t.tappingProcess) \(name) enabled=\(t.enabled) listenOnly=\(t.options == .listenOnly) mask=0x\(String(t.eventsOfInterest, radix: 16)) avgLatencyUs=\(Int(t.avgUsecLatency))")
}
