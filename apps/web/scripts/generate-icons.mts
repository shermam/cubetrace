// Generates the app icons in public/icons/ from one drawing: a flat isometric cube in the WCA
// orientation (white up, green front, red right) on the theme's background colour. Run it with
// `npm run icons -w @cubetrace/web` after changing the drawing; Playwright's Chromium rasterises
// the SVG into the PNG sizes the manifest lists.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Vector = readonly [number, number];

const outDir = resolve(import.meta.dirname, '../public/icons');
const background = '#0d1117'; // --bg in src/styles.scss, theme_color in the manifest
const size = 512;
// The cube's outline is a regular hexagon of this circumradius, which keeps it inside the
// maskable icon's safe zone (a circle of radius 0.4 * size).
const radius = 176;
const gap = 0.08; // between stickers, as a fraction of a sticker cell

const centre: Vector = [size / 2, size / 2];
const across = radius * Math.cos(Math.PI / 6);
const faces: readonly { colour: string; u: Vector; v: Vector }[] = [
  { colour: '#f5f7fa', u: [-across, -radius / 2], v: [across, -radius / 2] }, // U, on top
  { colour: '#22a55b', u: [-across, -radius / 2], v: [0, radius] }, // F, on the left
  { colour: '#e0443e', u: [across, -radius / 2], v: [0, radius] }, // R, on the right
];

function point(u: Vector, v: Vector, x: number, y: number): string {
  const px = centre[0] + (x * u[0] + y * v[0]) / 3;
  const py = centre[1] + (x * u[1] + y * v[1]) / 3;
  return `${px.toFixed(1)} ${py.toFixed(1)}`;
}

function face({ colour, u, v }: (typeof faces)[number]): string {
  const stickers: string[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const [x0, x1, y0, y1] = [i + gap, i + 1 - gap, j + gap, j + 1 - gap];
      const corners = [
        point(u, v, x0, y0),
        point(u, v, x1, y0),
        point(u, v, x1, y1),
        point(u, v, x0, y1),
      ];
      stickers.push(`M${corners.join('L')}Z`);
    }
  }
  return `<path fill="${colour}" d="${stickers.join('')}"/>`;
}

/** The icon; `cornerRadius` 0 is the full-bleed square that maskable icons need. */
function svg(cornerRadius: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(size)} ${String(size)}">` +
    `<rect width="${String(size)}" height="${String(size)}" rx="${String(cornerRadius)}" fill="${background}"/>` +
    faces.map(face).join('') +
    '</svg>\n'
  );
}

const rounded = svg(96);
const square = svg(0);
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'icon.svg'), rounded);

const browser = await chromium.launch();
try {
  for (const [name, drawing] of [
    ['icon', rounded],
    ['maskable', square],
  ] as const) {
    for (const pixels of [192, 512]) {
      const page = await browser.newPage({ viewport: { width: pixels, height: pixels } });
      await page.setContent(
        `<style>html,body{margin:0}svg{display:block;width:${String(pixels)}px;height:${String(pixels)}px}</style>${drawing}`,
      );
      const png = await page.screenshot({ omitBackground: true });
      writeFileSync(resolve(outDir, `${name}-${String(pixels)}.png`), png);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
