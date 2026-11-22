// firstframe: watch ONE process's window and report when it first showed
// its final content. App-agnostic, so Markie RS and Electron Markie are timed
// the same way.
//
//   firstframe <pid> <t0-epoch-ms> [--timeout s] [--settle s] [--png out.png]
//
// It polls the largest normal window owned by <pid> with
// CGWindowListCreateImage (no focus, no input), keeps a 96x60 grayscale
// thumbnail of the document region of each capture, and stops once the
// thumbnails have been stable for --settle seconds. The first frame is the
// first capture that already matches the final one. Prints one JSON line:
//   {"window_ms":…, "content_ms":…, "captures":…, "interval_ms":…}
// times in ms after <t0>. Exit 2 if no window appeared.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 3, let pid = Int32(args[1]), let t0 = Double(args[2]) else {
  FileHandle.standardError.write("usage: firstframe <pid> <t0-epoch-ms> [--timeout s] [--settle s] [--png out.png]\n".data(using: .utf8)!)
  exit(64)
}
var timeout = 20.0
var settle = 2.0
var pngOut: String? = nil
var i = 3
while i < args.count {
  switch args[i] {
  case "--timeout": timeout = Double(args[i + 1])!; i += 2
  case "--settle": settle = Double(args[i + 1])!; i += 2
  case "--png": pngOut = args[i + 1]; i += 2
  default: i += 1
  }
}

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

func windowId() -> CGWindowID? {
  guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return nil }
  var best: (CGWindowID, Double)? = nil
  for w in list {
    guard (w[kCGWindowOwnerPID as String] as? Int32) == pid,
          (w[kCGWindowLayer as String] as? Int) == 0,
          let b = w[kCGWindowBounds as String] as? [String: Double],
          let id = w[kCGWindowNumber as String] as? CGWindowID else { continue }
    let area = (b["Width"] ?? 0) * (b["Height"] ?? 0)
    if (b["Width"] ?? 0) < 300 || (b["Height"] ?? 0) < 200 { continue }
    if best == nil || area > best!.1 { best = (id, area) }
  }
  return best?.0
}

let TW = 96, TH = 60
// The document region: right of the library, below the title bar, above the
// status bar. Fractions of the window.
let region = (x0: 0.30, y0: 0.12, x1: 0.97, y1: 0.88)

func thumbnail(_ img: CGImage) -> [UInt8] {
  let w = img.width, h = img.height
  let crop = CGRect(x: Double(w) * region.x0, y: Double(h) * region.y0,
                    width: Double(w) * (region.x1 - region.x0), height: Double(h) * (region.y1 - region.y0))
  guard let cut = img.cropping(to: crop.integral) else { return [] }
  var px = [UInt8](repeating: 0, count: TW * TH)
  let ctx = CGContext(data: &px, width: TW, height: TH, bitsPerComponent: 8, bytesPerRow: TW,
                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
  ctx.interpolationQuality = .medium
  ctx.draw(cut, in: CGRect(x: 0, y: 0, width: TW, height: TH))
  return px
}

func diff(_ a: [UInt8], _ b: [UInt8]) -> Double {
  if a.count != b.count || a.isEmpty { return 1 }
  var changed = 0
  for k in 0..<a.count where abs(Int(a[k]) - Int(b[k])) > 24 { changed += 1 }
  return Double(changed) / Double(a.count)
}

/// Variance of the thumbnail: a blank or single-colour window has none.
func hasContent(_ a: [UInt8]) -> Bool {
  guard !a.isEmpty else { return false }
  let mean = a.reduce(0.0) { $0 + Double($1) } / Double(a.count)
  let v = a.reduce(0.0) { $0 + (Double($1) - mean) * (Double($1) - mean) } / Double(a.count)
  return v > 30
}

var frames: [(t: Double, thumb: [UInt8])] = []
var windowMs: Double? = nil
var lastChange = nowMs()
var lastImage: CGImage? = nil
let deadline = nowMs() + timeout * 1000
while nowMs() < deadline {
  guard let id = windowId() else { usleep(2000); continue }
  let t = nowMs()
  guard let img = CGWindowListCreateImage(.null, .optionIncludingWindow, id, [.boundsIgnoreFraming, .nominalResolution]) else {
    usleep(2000); continue
  }
  if windowMs == nil { windowMs = t - t0 }
  let th = thumbnail(img)
  if let prev = frames.last, diff(prev.thumb, th) > 0.004 { lastChange = t }
  frames.append((t, th))
  lastImage = img
  if hasContent(th) && t - lastChange > settle * 1000 { break }
}
guard let w = windowMs, let final = frames.last else {
  print("{\"error\":\"no window\"}")
  exit(2)
}
var content: Double? = nil
for f in frames where hasContent(f.thumb) && diff(f.thumb, final.thumb) < 0.01 {
  content = f.t - t0
  break
}
if let out = pngOut, let img = lastImage,
   let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil) {
  CGImageDestinationAddImage(dest, img, nil)
  CGImageDestinationFinalize(dest)
}
let span = frames.count > 1 ? (frames.last!.t - frames.first!.t) / Double(frames.count - 1) : 0
let c = content.map { String(format: "%.1f", $0) } ?? "null"
print(String(format: "{\"window_ms\":%.1f,\"content_ms\":%@,\"captures\":%d,\"interval_ms\":%.1f}", w, c, frames.count, span))
