#!/usr/bin/env node
// Single source of truth for the app's visual identity.
//
// The mark is a phone in front of a home server: the phone's amber display is
// copyparty's colour, the server is deliberately muted so the phone reads as
// the subject (this is a phone app). Everything downstream — launcher icon,
// adaptive layers, the Android themed-icon silhouette, splash, favicon, the
// notification status glyph and the store assets — is derived from the one
// geometry below, so the slots can never drift apart.
//
// Running this writes BOTH the .svg sources under assets/brand/ and the .png
// slots that app.json and fastlane reference. Commit both: the SVGs are the
// reviewable artifact, the PNGs are what actually ships.
//
// Requires `magick` (ImageMagick, with the librsvg delegate) — already in the
// devShell via flake.nix. This is a design-time tool; nothing in the release
// build shells out to it.
//
// Usage:
//   npm run gen-brand            # regenerate every brand asset
//   npm run gen-brand -- --check # verify committed PNGs match their dimensions
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = join(root, 'assets/brand');
const IMAGES = join(root, 'assets/images');
const FASTLANE = join(root, 'fastlane/metadata/android/en-US/images');
const DOCS = join(root, 'docs/brand');
const NOTIFY_RES = join(root, 'modules/copyparty-notify/android/src/main/res/drawable');
const SYNC_RES = join(root, 'modules/copyparty-sync/android/src/main/res/drawable');

// --- palette -----------------------------------------------------------------
// GROUND is both the icon tile and the splash background, so the mark always
// sits on its own colour rather than fighting a white or black system default.
const GROUND = '#1b1f23';
const AMBER = ['#ffcc55', '#ffcc00', '#ff8800']; // upstream copyparty's label gradient
const PALETTE = {
  phonebody: '#343b41',
  screen: 'url(#amber)',
  box: '#3a4149',
  bay: '#272d33',
  led: '#ffcc00',
  chrome: '#7d848b',
  sep: GROUND, // knockout outline that separates the phone from the box behind it
};
// Android themed icons are a flat single-colour silhouette: white is kept, black
// is punched out. No gradients, no second tone.
const SILHOUETTE = {
  phonebody: '#fff', screen: '#000', box: '#fff', bay: '#000',
  led: '#000', chrome: '#000', sep: '#000',
};

// --- geometry ----------------------------------------------------------------
// Authored in a 300x300 box; every slot scales this. Phone is deliberately the
// larger of the two objects.
const PHONE = { x: 28, y: 90, w: 132, h: 214 };
const BOX = { x: 136, y: 72, w: 158, h: 178, bays: 3, bayH: 40 };
const FOCUS = { x: 160, y: 189 }; // optical centre of the pair

// Two scales, because the slots are masked differently and a single one gets
// visibly clipped in the launcher.
//
// Android composites an adaptive icon from a 108dp canvas but only ever SHOWS
// the central 72dp, then applies a mask inside that — so a circle mask is a
// 683px circle on a 1024px canvas, not a 1024px one. Google's guaranteed-safe
// region is smaller still: a 66dp (626px) circle. The mark is a wide rectangle,
// so it is the CORNERS that have to fit — the largest fraction whose measured
// half-diagonal stays inside that circle is 0.498. Anything larger and the
// launcher's circle mask shears the server's right edge off; verified by
// trimming the rendered foreground and comparing its half-diagonal to 66/108/2.
const ADAPTIVE_FRACTION = 0.498; // launcher foreground + themed-icon silhouette
// icon.png, the favicon and the store icon are presented as rounded squares,
// never circle-masked, so they can carry the mark noticeably larger.
const TILE_FRACTION = 0.66;

function mark(P) {
  const o = [];
  const { x, y, w, h, bays, bayH } = BOX;
  o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="17" fill="${P.box}" stroke="${P.sep}" stroke-width="6"/>`);
  const gap = (h - 40 - bays * bayH) / (bays - 1);
  for (let i = 0; i < bays; i++) {
    const by = y + 22 + i * (bayH + gap);
    o.push(`<rect x="${x + 18}" y="${by}" width="${w - 36}" height="${bayH}" rx="8" fill="${P.bay}"/>`);
    o.push(`<rect x="${x + 30}" y="${by + bayH / 2 - 3}" width="${Math.round(w * 0.3)}" height="6" rx="3" fill="${P.chrome}"/>`);
    o.push(`<circle cx="${x + w - 34}" cy="${by + bayH / 2}" r="6" fill="${P.led}"/>`);
  }
  const p = PHONE;
  o.push(`<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${Math.round(p.w * 0.19)}" fill="${P.phonebody}" stroke="${P.sep}" stroke-width="9"/>`);
  o.push(`<rect x="${p.x + 11}" y="${p.y + 21}" width="${p.w - 22}" height="${p.h - 42}" rx="12" fill="${P.screen}"/>`);
  o.push(`<rect x="${p.x + p.w / 2 - 18}" y="${p.y + 9}" width="36" height="6" rx="3" fill="${P.chrome}"/>`);
  return o;
}

const DEFS = `<defs><linearGradient id="amber" x1="0" y1="0" x2="0" y2="1">`
  + `<stop offset="0" stop-color="${AMBER[0]}"/><stop offset="0.2" stop-color="${AMBER[1]}"/>`
  + `<stop offset="1" stop-color="${AMBER[2]}"/></linearGradient></defs>`;

/** Place the 300-unit mark into a square canvas, optionally on the ground colour. */
function tile({ size = 1024, ground = null, mono = false, fraction = TILE_FRACTION } = {}) {
  const s = (size * fraction) / 300;
  const tf = `translate(${(size / 2 - FOCUS.x * s).toFixed(2)},${(size / 2 - FOCUS.y * s).toFixed(2)}) scale(${s.toFixed(5)})`;
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;
  if (mono) {
    // White-is-kept / black-is-punched mask — the only way to get real holes
    // (the screen, the drive bays) in a single-colour layer.
    return `${head}\n<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${size}" height="${size}">\n`
      + `  <rect width="${size}" height="${size}" fill="#000"/>\n`
      + `  <g transform="${tf}">\n    ${mark(SILHOUETTE).join('\n    ')}\n  </g>\n</mask>\n`
      + `<rect width="${size}" height="${size}" fill="#fff" mask="url(#m)"/>\n</svg>\n`;
  }
  return `${head}\n${DEFS}\n`
    + (ground ? `<rect width="${size}" height="${size}" fill="${ground}"/>\n` : '')
    + `<g transform="${tf}">\n  ${mark(PALETTE).join('\n  ')}\n</g>\n</svg>\n`;
}

/** Mark on the left, name on the right. Used for the README banner and Play's
 *  feature graphic — which have very different aspect ratios, so the type scale
 *  is a parameter rather than a fixed share of height. A 1024x500 graphic using
 *  the 1200x300 banner's ratios overflows its own canvas. */
const TITLE = 'Party Sync';
const TAGLINE = 'Back up your phone to your own server';
const FONT = 'DejaVu Sans, Liberation Sans, sans-serif';

function banner({ w, h, ground, fg, sub, markH = 0.62, titleF = 0.155, subF = 0.082,
  padF = 0.20, tagline = true }) {
  const s = (h * markH) / 300;
  const mx = h * padF * 1.5;
  const tf = `translate(${(mx - FOCUS.x * s + 150 * s).toFixed(2)},${(h / 2 - FOCUS.y * s).toFixed(2)}) scale(${s.toFixed(5)})`;
  const tx = (mx + 300 * s + h * padF).toFixed(0);
  // With no tagline the title carries the block alone, so centre it optically
  // rather than leaving it sitting on the two-line baseline.
  const ty = tagline ? h * 0.50 : h * 0.50 + h * titleF * 0.35;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n${DEFS}\n`
    + `<rect width="${w}" height="${h}" fill="${ground}"/>\n`
    + `<g transform="${tf}">\n  ${mark(PALETTE).join('\n  ')}\n</g>\n`
    + `<text x="${tx}" y="${ty.toFixed(0)}" font-family="${FONT}" font-weight="bold" `
    + `font-size="${(h * titleF).toFixed(0)}" fill="${fg}">${TITLE}</text>\n`
    + (tagline
      ? `<text x="${tx}" y="${(h * 0.50 + h * titleF * 0.98).toFixed(0)}" font-family="${FONT}" `
        + `font-size="${(h * subF).toFixed(0)}" fill="${sub}">${TAGLINE}</text>\n`
      : '')
    + `</svg>\n`;
}

// --- Android notification status icon ----------------------------------------
// 24dp, alpha-only: the framework tints it, so shape is all that survives. The
// full mark is far too fine at this size, so this is a deliberately reduced
// two-shape version — solid phone, server with its bays punched through.
function roundRect(x, y, w, h, r) {
  // n() keeps binary-float noise (2.2 - 2*0.6 = 1.0000000000000002) out of the
  // committed path data.
  const n = (v) => String(Number(v.toFixed(3)));
  const hx = n(w - 2 * r), vy = n(h - 2 * r);
  return `M${n(x + r)},${n(y)} h${hx} a${n(r)},${n(r)} 0 0 1 ${n(r)},${n(r)} v${vy} `
    + `a${n(r)},${n(r)} 0 0 1 ${n(-r)},${n(r)} h${n(-(w - 2 * r))} `
    + `a${n(r)},${n(r)} 0 0 1 ${n(-r)},${n(-r)} v${n(-(h - 2 * r))} `
    + `a${n(r)},${n(r)} 0 0 1 ${n(r)},${n(-r)} z`;
}
const STAT_PHONE = roundRect(2, 3.4, 9.4, 17.2, 2);
const STAT_BOX = [roundRect(13, 6, 9, 12, 1.6),
  roundRect(14.6, 8, 5.8, 2.2, 0.6),
  roundRect(14.6, 11.4, 5.8, 2.2, 0.6),
  roundRect(14.6, 14.8, 5.8, 2.2, 0.6)].join(' ');

const IC_STAT_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by scripts/gen-brand.mjs — do not edit by hand.
     Status-bar icon: alpha-only, the system applies its own tint. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
  <path android:fillColor="#FFFFFFFF" android:pathData="${STAT_PHONE}"/>
  <path android:fillColor="#FFFFFFFF" android:fillType="evenOdd" android:pathData="${STAT_BOX}"/>
</vector>
`;

const IC_STAT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
<path fill="#fff" d="${STAT_PHONE}"/>
<path fill="#fff" fill-rule="evenodd" d="${STAT_BOX}"/>
</svg>
`;

// --- emit ---------------------------------------------------------------------
const magick = (...args) => execFileSync('magick', args.map(String), { stdio: 'inherit' });
const svgs = {};
const write = (dir, name, body) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
  return join(dir, name);
};

for (const d of [BRAND, IMAGES, FASTLANE, DOCS, NOTIFY_RES, SYNC_RES]) mkdirSync(d, { recursive: true });

svgs.icon = write(BRAND, 'icon.svg', tile({ ground: GROUND }));
// mark.svg feeds the adaptive foreground (circle-masked by the launcher) and
// the splash, so it uses the smaller, mask-safe fraction.
svgs.mark = write(BRAND, 'mark.svg', tile({ fraction: ADAPTIVE_FRACTION }));
svgs.mono = write(BRAND, 'monochrome.svg', tile({ mono: true, fraction: ADAPTIVE_FRACTION }));
svgs.ground = write(BRAND, 'icon-background.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="${GROUND}"/></svg>\n`);
// README banner: name only. The tagline already appears as prose directly
// beneath it, and repeating it inside the image reads as a stutter.
// Width is sized to the rendered content so the banner sits centred when the
// README centres it — retighten this if TITLE ever changes length.
const WORDMARK = { w: 650, h: 260, markH: 0.68, titleF: 0.19, padF: 0.16, tagline: false };
svgs.wordLight = write(BRAND, 'wordmark-light.svg',
  banner({ ...WORDMARK, ground: '#ffffff', fg: '#11181C', sub: '#5b646c' }));
svgs.wordDark = write(BRAND, 'wordmark-dark.svg',
  banner({ ...WORDMARK, ground: GROUND, fg: '#ECEDEE', sub: '#9BA1A6' }));
// Play's feature graphic is far squarer than the README banner, so the mark and
// type both shrink relative to height or the title runs off the canvas.
svgs.feature = write(BRAND, 'feature-graphic.svg',
  banner({ w: 1024, h: 500, ground: GROUND, fg: '#ECEDEE', sub: '#9BA1A6',
    markH: 0.46, titleF: 0.105, subF: 0.055, padF: 0.10 }));
svgs.icStat = write(BRAND, 'ic-stat.svg', IC_STAT_SVG);

// The notification drawable is duplicated into both native modules rather than
// shared: each has its own R class, and a cross-module Gradle dependency to
// share one file would be a worse trade than one generated copy each.
for (const d of [NOTIFY_RES, SYNC_RES]) write(d, 'ic_stat_copyparty.xml', IC_STAT_XML);

// slot -> [source svg, width, height, opaque?]
const SLOTS = [
  [join(IMAGES, 'icon.png'), svgs.icon, 1024, 1024, true],
  [join(IMAGES, 'android-icon-foreground.png'), svgs.mark, 512, 512, false],
  [join(IMAGES, 'android-icon-background.png'), svgs.ground, 512, 512, false],
  [join(IMAGES, 'android-icon-monochrome.png'), svgs.mono, 432, 432, false],
  [join(IMAGES, 'splash-icon.png'), svgs.mark, 1024, 1024, false],
  [join(IMAGES, 'favicon.png'), svgs.icon, 48, 48, false],
  [join(FASTLANE, 'icon.png'), svgs.icon, 512, 512, true],
  [join(FASTLANE, 'featureGraphic.png'), svgs.feature, 1024, 500, true],
  [join(DOCS, "wordmark-light.png"), svgs.wordLight, 650, 260, true],
  [join(DOCS, "wordmark-dark.png"), svgs.wordDark, 650, 260, true],
];

if (process.argv.includes('--check')) {
  let bad = 0;
  for (const [out, , w, h] of SLOTS) {
    const got = execFileSync('magick', ['identify', '-format', '%wx%h', out], { encoding: 'utf8' });
    const want = `${w}x${h}`;
    if (got !== want) (bad++, console.error(`✗ ${out}: ${got}, expected ${want}`));
  }
  console.log(bad ? `${bad} slot(s) wrong` : `✓ all ${SLOTS.length} slots match`);
  process.exit(bad ? 1 : 0);
}

for (const [out, src, w, h, opaque] of SLOTS) {
  // Render at the SVG's intrinsic size then downsample with Lanczos — librsvg
  // rasterises crisply and the filter keeps small sizes from going mushy.
  // -colorspace sRGB keeps the monochrome layer from being written as a
  // grayscale PNG, which some Android tooling handles less predictably.
  const args = opaque
    ? ['-background', GROUND, src, '-filter', 'Lanczos', '-resize', `${w}x${h}!`,
      '-alpha', 'remove', '-alpha', 'off', '-colorspace', 'sRGB', out]
    : ['-background', 'none', src, '-filter', 'Lanczos', '-resize', `${w}x${h}!`,
      '-colorspace', 'sRGB', '-define', 'png:color-type=6', out];
  magick(...args);
}

console.log(`\nwrote ${Object.keys(svgs).length} svg sources, ${SLOTS.length} png slots, `
  + `2 notification drawables`);
for (const [out, , w, h] of SLOTS) console.log(`  ${w}x${h}\t${out.replace(root + '/', '')}`);
