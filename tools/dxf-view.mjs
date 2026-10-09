/**
 * 書き出した DXF を外部パーサで読み戻し、その結果「だけ」から SVG を描く。
 * MiniCAD の内部データを一切参照しないので、受け取った CAD での見え方に相当する。
 *
 * 画面と SVG が正しくても DXF だけ壊れている、という事故を目で見つけるための道具。
 * 実際にドアの開き軌跡が 270° になっていたのをこれで発見した。
 *
 *   node tools/dxf-view.mjs out.dxf out.svg
 *   qlmanage -t -s 1400 -o . out.svg     # macOS で画像化するなら
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const DxfParser = require('dxf-parser');

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('使い方: node tools/dxf-view.mjs <入力.dxf> <出力.svg>');
  process.exit(1);
}

const parsed = new (DxfParser.default ?? DxfParser)().parseSync(readFileSync(input, 'utf8'));
const layers = parsed.tables.layer.layers;
const blocks = parsed.blocks ?? {};

/**
 * INSERT を実体に展開する。
 * 受け取った CAD は定義を挿入点・尺度・回転で描くので、同じことをする。
 */
function expand(entities) {
  const out = [];
  for (const e of entities) {
    if (e.type !== 'INSERT') {
      out.push(e);
      continue;
    }
    const def = blocks[e.name];
    if (!def?.entities) continue;
    const sx = e.xScale ?? 1;
    const sy = e.yScale ?? 1;
    const rot = ((e.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const at = (p) => {
      const x = p.x * sx;
      const y = p.y * sy;
      return { x: e.position.x + x * cos - y * sin, y: e.position.y + x * sin + y * cos };
    };
    // 定義は画層 0 に置かれるので、INSERT 側の画層を継承させる
    const layer = e.layer;
    for (const inner of expand(def.entities)) {
      if (inner.type === 'LINE') {
        out.push({ ...inner, layer, vertices: inner.vertices.map(at) });
      } else if (inner.type === 'CIRCLE' || inner.type === 'ARC') {
        // 非一様尺度では楕円になるが、ここでは平均半径で近似する
        out.push({ ...inner, layer, center: at(inner.center), radius: inner.radius * (Math.abs(sx) + Math.abs(sy)) / 2 });
      } else if (inner.type === 'TEXT') {
        out.push({ ...inner, layer, startPoint: at(inner.startPoint), rotation: (inner.rotation ?? 0) + (e.rotation ?? 0) });
      }
    }
  }
  return out;
}

parsed.entities = expand(parsed.entities);

/** DXF の色番号 (ACI) をおおよその色に */
const ACI = {
  1: '#e11d48', 2: '#ca8a04', 3: '#16a34a', 4: '#0891b2',
  5: '#2563eb', 6: '#c026d3', 7: '#18181b', 8: '#52525b', 9: '#a1a1aa',
};
const aci = (name) => Math.abs(layers[name]?.colorIndex ?? 7);
const colorOf = (name) => ACI[aci(name)] ?? '#18181b';
/** R12 に線幅が無いので、色から太さを推定する（MiniCAD の「色＝線の太さ」運用に合わせる） */
const widthOf = (name) => (aci(name) === 7 ? 50 : 25);

let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
const see = (x, y) => {
  minX = Math.min(minX, x); minY = Math.min(minY, y);
  maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
};

for (const e of parsed.entities) {
  for (const v of e.vertices ?? []) see(v.x, v.y);
  if (e.type === 'ARC' || e.type === 'CIRCLE') {
    see(e.center.x - e.radius, e.center.y - e.radius);
    see(e.center.x + e.radius, e.center.y + e.radius);
  }
  if (e.type === 'TEXT') {
    // 文字幅は分からないので、高さから大まかに見積もって範囲に入れる
    const half = (e.textHeight ?? 100) * [...(e.text ?? '')].length * 0.5;
    see(e.startPoint.x - half, e.startPoint.y);
    see(e.startPoint.x + half, e.startPoint.y);
  }
}
if (!Number.isFinite(minX)) {
  console.error('描けるエンティティがありません');
  process.exit(1);
}

const pad = 500;
minX -= pad; minY -= pad; maxX += pad; maxY += pad;
const w = maxX - minX;
const h = maxY - minY;
const side = Math.max(w, h);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const parts = [];
for (const e of parsed.entities) {
  const stroke = colorOf(e.layer);
  const sw = widthOf(e.layer);
  switch (e.type) {
    case 'LINE': {
      const [a, b] = e.vertices;
      parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${stroke}" stroke-width="${sw}"/>`);
      break;
    }
    case 'CIRCLE':
      parts.push(
        `<circle cx="${e.center.x}" cy="${e.center.y}" r="${e.radius}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`,
      );
      break;
    case 'ARC': {
      const { center: c, radius: r } = e;
      const a0 = e.startAngle ?? 0;
      const a1 = e.endAngle ?? 0;
      const at = (ang) => `${c.x + r * Math.cos(ang)} ${c.y + r * Math.sin(ang)}`;
      let sweep = a1 - a0;
      while (sweep <= 0) sweep += Math.PI * 2;
      const large = sweep > Math.PI ? 1 : 0;
      parts.push(
        `<path d="M ${at(a0)} A ${r} ${r} 0 ${large} 1 ${at(a1)}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`,
      );
      break;
    }
    case 'TEXT': {
      const p = e.startPoint;
      const anchor = e.halign === 0 ? 'start' : e.halign === 2 ? 'end' : 'middle';
      parts.push(
        `<g transform="translate(${p.x} ${p.y}) scale(1 -1) rotate(${-(e.rotation ?? 0)})">` +
          `<text font-family="sans-serif" font-size="${e.textHeight}" fill="${stroke}"` +
          ` text-anchor="${anchor}" dominant-baseline="middle">${esc(e.text)}</text></g>`,
      );
      break;
    }
    default:
      break;
  }
}

const dx = (side - w) / 2;
const dy = (side - h) / 2;
writeFileSync(
  output,
  `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}">` +
    `<rect width="${side}" height="${side}" fill="#ffffff"/>` +
    `<g transform="translate(${dx - minX} ${dy + minY + h}) scale(1 -1)">${parts.join('')}</g></svg>`,
);

const counts = {};
for (const e of parsed.entities) {
  const key = `${e.layer}/${e.type}`;
  counts[key] = (counts[key] ?? 0) + 1;
}
console.log('エンティティ内訳:');
for (const [key, n] of Object.entries(counts).sort()) console.log(`  ${key}: ${n}`);
console.log(`→ ${output}`);
