#!/usr/bin/env node
// Rasterizes the Markie mark (src/components/markie-mark.tsx) into the iOS and
// Android app icons and launch screens. Uses the repo root's sharp, which the
// desktop's own icon script already depends on, so the app adds nothing.
//
// Run after `npm ci` at the repo root: node scripts/icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const sharp = createRequire(path.resolve(app, "../../package.json"))("sharp");

const M = `<path d="M300 712V318l212 262 212-262v394" fill="none" stroke="url(#m)" stroke-width="112" stroke-linecap="round" stroke-linejoin="round"/><circle cx="512" cy="742" r="50" fill="#60a5fa"/>`;
const DEFS = `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#232327"/><stop offset="1" stop-color="#101012"/></linearGradient><linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fcd34d"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs>`;

// Full-bleed square: iOS applies its own corner mask.
const square = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${DEFS}<rect width="1024" height="1024" fill="url(#bg)"/>${M}</svg>`;
// Android legacy icons carry their own shape.
const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${DEFS}<rect x="48" y="48" width="928" height="928" rx="208" fill="url(#bg)"/>${M}</svg>`;
const circle = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${DEFS}<circle cx="512" cy="512" r="464" fill="url(#bg)"/>${M}</svg>`;
// Adaptive foreground: 108dp canvas, the mark inside the 66dp safe zone.
const foreground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${DEFS}<g transform="translate(512 512) scale(0.6) translate(-512 -512)">${M}</g></svg>`;
// A launch screen: the mark, rounded, centered on the theme's background.
const splash = (background, size) => {
  const mark = Math.round(size * 0.12);
  const offset = (size - mark) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${background}"/><svg x="${offset}" y="${offset}" width="${mark}" height="${mark}" viewBox="0 0 1024 1024">${DEFS}<rect width="1024" height="1024" rx="229" fill="url(#bg)"/>${M}</svg></svg>`;
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
await png(square, 1024, path.join(iosAssets, "AppIcon.appiconset/AppIcon-512@2x.png"), { opaque: true });
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
  await png(rounded, Math.round(48 * scale), path.join(res, `mipmap-${density}/ic_launcher.png`));
  await png(circle, Math.round(48 * scale), path.join(res, `mipmap-${density}/ic_launcher_round.png`));
  await png(foreground, Math.round(108 * scale), path.join(res, `mipmap-${density}/ic_launcher_foreground.png`));
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
console.log("Icons and launch screens written.");
