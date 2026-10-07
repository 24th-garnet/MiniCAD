import { toDeg, type Vec } from '../core/geometry.ts';
import type { Layer } from '../core/layer.ts';
import type { Primitive } from '../core/primitive.ts';
import { paperToWorld, type DrawingStandard } from '../core/standard.ts';

/** DXF のエンティティ1つ。グループコードと値が交互に並ぶ */
export type DxfEntity = string[];

/** 小数は DXF が読みやすい固定表記にする（指数表記を避ける） */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0.0';
  const v = Math.abs(n) < 1e-9 ? 0 : n;
  return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');
}

/** 文字が上下逆にならないよう ±90° に畳む */
export function normalizeTextDeg(deg: number): number {
  let d = deg;
  while (d > 90) d -= 180;
  while (d < -90) d += 180;
  return d;
}

export const dxfLine = (a: Vec, b: Vec, layerName: string): DxfEntity => [
  '0', 'LINE', '8', layerName,
  '10', fmt(a.x), '20', fmt(a.y), '30', '0.0',
  '11', fmt(b.x), '21', fmt(b.y), '31', '0.0',
];

/** DXF の ARC は start から end へ反時計回りに描かれる。角度は度 */
export const dxfArc = (center: Vec, radius: number, startDeg: number, endDeg: number, layerName: string): DxfEntity => [
  '0', 'ARC', '8', layerName,
  '10', fmt(center.x), '20', fmt(center.y), '30', '0.0',
  '40', fmt(radius), '50', fmt(startDeg), '51', fmt(endDeg),
];

export const dxfCircle = (center: Vec, radius: number, layerName: string): DxfEntity => [
  '0', 'CIRCLE', '8', layerName,
  '10', fmt(center.x), '20', fmt(center.y), '30', '0.0',
  '40', fmt(radius),
];

/** 72/73 で揃えを指定するときは 11/21/31 の配置点が必須 */
export function dxfText(
  value: string,
  at: Vec,
  height: number,
  rotationDeg: number,
  layerName: string,
  align: 'left' | 'center' | 'right' = 'center',
): DxfEntity {
  const horizontal = align === 'left' ? 0 : align === 'right' ? 2 : 1;
  return [
    '0', 'TEXT', '8', layerName,
    '10', fmt(at.x), '20', fmt(at.y), '30', '0.0',
    '40', fmt(height), '1', value, '50', fmt(rotationDeg),
    '7', 'STANDARD',
    '72', String(horizontal), '73', '2',
    '11', fmt(at.x), '21', fmt(at.y), '31', '0.0',
  ];
}

/**
 * 中間表現を DXF に落とす3つのバックエンドのうちの1つ。
 *
 * R12 には LWPOLYLINE が無く、POLYLINE + VERTEX + SEQEND を組むか
 * LINE に分解するかの二択になる。読み手の互換性を優先して分解する。
 */
export function dxfPrimitives(
  prims: Primitive[],
  layer: Layer,
  std: DrawingStandard,
  escape: (s: string) => string,
): DxfEntity[] {
  const out: DxfEntity[] = [];

  for (const prim of prims) {
    switch (prim.kind) {
      case 'segments':
        for (const s of prim.segments) out.push(dxfLine(s.a, s.b, layer.name));
        break;

      case 'arc':
        out.push(dxfArc(prim.center, prim.radius, toDeg(prim.startAngle), toDeg(prim.endAngle), layer.name));
        break;

      case 'circle':
        out.push(dxfCircle(prim.center, prim.radius, layer.name));
        break;

      case 'polygon':
        for (let i = 0; i < prim.points.length; i++) {
          out.push(dxfLine(prim.points[i], prim.points[(i + 1) % prim.points.length], layer.name));
        }
        break;

      case 'text':
        out.push(
          dxfText(
            escape(prim.text),
            prim.at,
            paperToWorld(prim.paperMm, std),
            normalizeTextDeg(toDeg(prim.angle)),
            layer.name,
            prim.align,
          ),
        );
        break;
    }
  }
  return out;
}
