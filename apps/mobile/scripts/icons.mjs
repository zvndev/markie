#!/usr/bin/env node
// Rasterizes the Markie launch screens for iOS and Android: the red underline
// (src/lib/brand.ts) centered on the theme's background. Uses the repo root's
// sharp, which the desktop's own icon script already depends on, so the app
// adds nothing.
//
// The app icons themselves are not drawn here. They are the brand pack's own
// exports, committed as they came: ios/App/App/Assets.xcassets/AppIcon.appiconset
// (default, dark and tinted) and the Android mipmaps plus the adaptive
// drawable/ic_launcher_foreground.xml and ic_launcher_monochrome.xml.
//
// Run after `npm ci` at the repo root: node scripts/icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const sharp = createRequire(path.resolve(app, "../../package.json"))("sharp");

const brand = readFileSync(path.resolve(app, "../../src/lib/brand.ts"), "utf8");
const UNDERLINE = JSON.parse(brand.match(/UNDERLINE_PATH =\s*("[^"]+")/)[1]);
const RED = brand.match(/red: "(#[0-9A-Fa-f]{6})"/)[1];

// A launch screen: the underline, 18% of the longer side wide, centered.
const splash = (background, size) => {
  const width = Math.round(size * 0.18);
  const height = Math.round((width * 109) / 364);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${background}"/><svg x="${(size - width) / 2}" y="${(size - height) / 2}" width="${width}" height="${height}" viewBox="0 0 364 109" overflow="visible"><g transform="translate(-558 -641)"><path fill="${RED}" fill-rule="evenodd" d="${UNDERLINE}"/></g></svg></svg>`;
};

async function png(svg, size, file, { opaque = false, height = size } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  let image = sharp(Buffer.from(svg), { density: 384 }).resize(size, height, { fit: "cover" });
  if (opaque) image = image.flatten({ background: "#101012" }).removeAlpha();
  writeFileSync(file, await image.png({ compressionLevel: 9 }).toBuffer());
}

const LIGHT = "#f8fafc";
const DARK = "#09090b";

// iOS
const iosAssets = path.join(app, "ios/App/App/Assets.xcassets");
await png(splash(LIGHT, 2732), 2732, path.join(iosAssets, "Splash.imageset/splash-2732x2732.png"), { opaque: true });
await png(splash(DARK, 2732), 2732, path.join(iosAssets, "Splash.imageset/splash-2732x2732-dark.png"), { opaque: true });
writeFileSync(path.join(iosAssets, "Splash.imageset/Contents.json"), JSON.stringify({
  images: [
    { idiom: "universal", filename: "splash-2732x2732.png", scale: "1x" },
    { idiom: "universal", filename: "splash-2732x2732-dark.png", scale: "1x", appearances: [{ appearance: "luminosity", value: "dark" }] },
    { idiom: "universal", scale: "2x" },
    { idiom: "universal", scale: "3x" },
  ],
  info: { version: 1, author: "xcode" },
}, null, 2) + "\n");

// Android
const res = path.join(app, "android/app/src/main/res");
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [density, scale] of Object.entries(densities)) {
  for (const orientation of ["port", "land"]) {
    const [w, h] = orientation === "port" ? [320, 480] : [480, 320];
    const side = Math.round(Math.max(w, h) * scale);
    for (const [suffix, color] of [["", LIGHT], ["-night", DARK]]) {
      await png(splash(color, side), Math.round(w * scale), path.join(res, `drawable-${orientation}${suffix}-${density}/splash.png`), { opaque: true, height: Math.round(h * scale) });
    }
  }
}
await png(splash(LIGHT, 480), 480, path.join(res, "drawable/splash.png"), { opaque: true });
await png(splash(DARK, 480), 480, path.join(res, "drawable-night/splash.png"), { opaque: true });
console.log("Launch screens written.");
