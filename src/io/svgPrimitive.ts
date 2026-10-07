import { arcPointAt } from '../core/shapes.ts';
import type { Vec } from '../core/geometry.ts';
import { layerDashWorld, layerWeight, type Layer } from '../core/layer.ts';
import type { Primitive } from '../core/primitive.ts';
import { paperToWorld, type DrawingStandard } from '../core/standard.ts';
import { FONT_FAMILY, theme } from '../render/theme.ts';

export const round = (n: number): number => Math.round(n * 100) / 100;

export const pointsAttr = (pts: Vec[]): string => pts.map((p) => `${round(p.x)},${round(p.y)}`).join(' ');

export const lineTag = (a: Vec, b: Vec, stroke: string, width: number, extra = ''): string =>
  `<line x1="${round(a.x)}" y1="${round(a.y)}" x2="${round(b.x)}" y2="${round(b.y)}" stroke="${stroke}" stroke-width="${round(width)}"${extra}/>`;

/** y 反転した座標系の中に置くので、文字は個別に反転し直す */
export function textTag(
  text: string,
  at: Vec,
  rotateDeg: number,
  size: number,
  fill: string,
  weight = 400,
  anchor: 'start' | 'middle' | 'end' = 'middle',
): string {
  let angle = rotateDeg;
  while (angle > 90) angle -= 180;
  while (angle < -90) angle += 180;
  return (
    `<g transform="translate(${round(at.x)} ${round(at.y)}) scale(1 -1) rotate(${round(-angle)})">` +
    `<text x="0" y="0" font-family="${escapeXml(FONT_FAMILY)}" font-size="${round(size)}" font-weight="${weight}"` +
    ` fill="${fill}" text-anchor="${anchor}" dominant-baseline="middle">${escapeXml(text)}</text></g>`
  );
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

/** 中間表現を SVG に落とす3つのバックエンドのうちの1つ */
export function svgPrimitives(prims: Primitive[], layer: Layer, std: DrawingStandard): string[] {
  const width = paperToWorld(layerWeight(layer, std), std);
  const dash = layerDashWorld(layer, std);
  const dashAttr = dash.length === 0 ? '' : ` stroke-dasharray="${dash.map(round).join(' ')}"`;
  const out: string[] = [];

  for (const prim of prims) {
    switch (prim.kind) {
      case 'segments':
        for (const s of prim.segments) out.push(lineTag(s.a, s.b, layer.color, width, dashAttr));
        break;

      case 'arc': {
        const from = arcPointAt(prim.center, prim.radius, prim.startAngle);
        const to = arcPointAt(prim.center, prim.radius, prim.endAngle);
        let sweep = prim.endAngle - prim.startAngle;
        while (sweep <= 0) sweep += Math.PI * 2;
        const large = sweep > Math.PI ? 1 : 0;
        // y 反転したグループの中なので、反時計回りは sweep-flag 0 になる
        out.push(
          `<path d="M ${round(from.x)} ${round(from.y)} A ${round(prim.radius)} ${round(prim.radius)} 0 ${large} 0 ${round(to.x)} ${round(to.y)}"` +
            ` fill="none" stroke="${layer.color}" stroke-width="${round(width)}"${dashAttr}/>`,
        );
        break;
      }

      case 'circle':
        out.push(
          `<circle cx="${round(prim.center.x)}" cy="${round(prim.center.y)}" r="${round(prim.radius)}"` +
            ` fill="none" stroke="${layer.color}" stroke-width="${round(width)}"${dashAttr}/>`,
        );
        break;

      case 'polygon': {
        const fill = prim.fill === 'none' ? 'none' : prim.fill === 'paper' ? theme.paper : layer.color;
        out.push(
          `<polygon points="${pointsAttr(prim.points)}" fill="${fill}" stroke="${layer.color}" stroke-width="${round(width)}"${dashAttr}/>`,
        );
        break;
      }

      case 'text': {
        const anchor = prim.align === 'left' ? 'start' : prim.align === 'right' ? 'end' : 'middle';
        out.push(
          textTag(
            prim.text,
            prim.at,
            (prim.angle * 180) / Math.PI,
            paperToWorld(prim.paperMm, std),
            prim.color ?? layer.color,
            400,
            anchor,
          ),
        );
        break;
      }
    }
  }
  return out;
}
