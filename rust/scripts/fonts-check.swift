// Which template faces CoreText finds by family name, the way GPUI (font-kit
// select_family_by_name) asks: `swift rust/scripts/fonts-check.swift`.
// A family with 0 faces would fall back to the system sans in Markie RS.
import CoreText
import AppKit
// font-kit's select_family_by_name: a collection of descriptors matching the family name attribute.
func family(_ name: String) -> [String] {
  let d = CTFontDescriptorCreateWithAttributes([kCTFontFamilyNameAttribute: name] as CFDictionary)
  let c = CTFontCollectionCreateWithFontDescriptors([d] as CFArray, nil)
  let m = CTFontCollectionCreateMatchingFontDescriptors(c) as? [CTFontDescriptor] ?? []
  return m.map { (CTFontDescriptorCopyAttribute($0, kCTFontNameAttribute) as? String) ?? "?" }
}
for n in [".AppleSystemUIFontSerif", ".SystemUIFont", "Charter", "Iowan Old Style", "New York", ".New York", "Georgia", "Avenir Next", "Helvetica Neue", "Optima", "SF Mono", ".AppleSystemUIFontMonospaced", ".AppleSystemUIFont", "Palatino"] {
  let f = family(n)
  print("\(n): \(f.count) faces \(f.prefix(4))")
}
let serif = NSFont.systemFont(ofSize: 16).fontDescriptor.withDesign(.serif).flatMap { NSFont(descriptor: $0, size: 16) }
print("system serif (ui-serif):", serif?.familyName ?? "nil", serif?.fontName ?? "")
let mono = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
print("system mono (ui-monospace):", mono.familyName ?? "nil", mono.fontName)
