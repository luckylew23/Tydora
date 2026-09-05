// Generate the social-preview card (og.png, 1200x630) with the SITE NAME at
// build time, so shared links show the vault's identity instead of a generic
// image. Site name/description come from the resolved config (env contract
// with the CLI). Falls back to copying public/og-default.png if rendering
// is unavailable, so a build never fails because of the card.
import { createRequire } from 'node:module';
import { writeFileSync, copyFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const distDir = path.resolve('dist/markdown-publish/browser');
const out = path.join(distDir, 'og.png');

const name = (process.env.SITE_NAME ?? '').trim() || 'Notes';
const description = (process.env.SITE_DESCRIPTION ?? '').trim();

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Clamp the headline so long vault names still fit on one or two lines.
const title = name.length > 60 ? name.slice(0, 59) + '…' : name;
const titleSize = title.length <= 16 ? 96 : title.length <= 26 ? 72 : title.length <= 40 ? 56 : 44;
const desc = description.length > 110 ? description.slice(0, 109) + '…' : description;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <defs>
    <radialGradient id="bg" cx="78%" cy="18%" r="95%">
      <stop offset="0%" stop-color="#2a2150"/>
      <stop offset="55%" stop-color="#15131f"/>
      <stop offset="100%" stop-color="#100e18"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <g transform="translate(90,96) scale(3.4)">
    <rect width="32" height="32" rx="7" fill="#8a5cf5"/>
    <g stroke="#ffffff" stroke-width="2" stroke-linecap="round">
      <path d="M10 11 L16 21 M22 11 L16 21 M10 11 L22 11"/>
    </g>
    <g fill="#ffffff">
      <circle cx="10" cy="11" r="3"/><circle cx="22" cy="11" r="3"/><circle cx="16" cy="21" r="3"/>
    </g>
  </g>
  <text x="90" y="${desc ? 388 : 420}" font-family="Inter" font-size="${titleSize}" font-weight="600" fill="#ffffff">${esc(title)}</text>
  ${desc ? `<text x="90" y="452" font-family="Inter" font-size="32" fill="#b8b6c4">${esc(desc)}</text>` : ''}
</svg>`;

try {
  const { Resvg } = require('@resvg/resvg-js');
  const fontFile = require.resolve(
    '@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf',
  );
  const resvg = new Resvg(svg, {
    font: { fontFiles: [fontFile], loadSystemFonts: false, defaultFontFamily: 'Inter' },
  });
  writeFileSync(out, resvg.render().asPng());
  console.log(`OG: og.png rendered for "${title}"`);
} catch (err) {
  const fallback = path.join(distDir, 'og-default.png');
  if (existsSync(fallback)) {
    copyFileSync(fallback, out);
    console.warn(`OG: render failed (${err.message}); copied og-default.png`);
  } else {
    console.warn(`OG: render failed (${err.message}); no og.png emitted`);
  }
}
