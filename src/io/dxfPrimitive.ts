import { toDeg, type Vec } from '../core/geometry.ts';
import type { Layer } from '../core/layer.ts';
import type { Primitive } from '../core/primitive.ts';
import { paperToWorld, type DrawingStandard, type LineType } from '../core/standard.ts';

/** DXF のエンティティ1つ。グループコードと値が交互に並ぶ */
export type DxfEntity = string[];

/** R12 が持てる線種。MiniCAD の線種をこの名前に対応させる */
export const LTYPE_NAMES: Record<LineType, string> = {
  continuous: 'CONTINUOUS',
  dashed: 'DASHED',
  hidden: 'HIDDEN',
  center: 'CENTER',
  phantom: 'PHANTOM',
};

/**
 * エンティティ単位の線種（グループコード 6）。
 * 省略すると画層の線種に従う。記号自身が線種を持つとき（ドアの開き軌跡など）に使う。
 */
const ltypeTag = (lineType: LineType | undefined): string[] =>
  lineType ? ['6', LTYPE_NAMES[lineType]] : [];

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

export const dxfLine = (a: Vec, b: Vec, layerName: string, lineType?: LineType): DxfEntity => [
  '0', 'LINE', '8', layerName, ...ltypeTag(lineType),
  '10', fmt(a.x), '20', fmt(a.y), '30', '0.0',
  '11', fmt(b.x), '21', fmt(b.y), '31', '0.0',
];

/** DXF の ARC は start から end へ反時計回りに描かれる。角度は度 */
export const dxfArc = (
  center: Vec,
  radius: number,
  startDeg: number,
  endDeg: number,
  layerName: string,
  lineType?: LineType,
): DxfEntity => [
  '0', 'ARC', '8', layerName, ...ltypeTag(lineType),
  '10', fmt(center.x), '20', fmt(center.y), '30', '0.0',
  '40', fmt(radius), '50', fmt(startDeg), '51', fmt(endDeg),
];

export const dxfCircle = (center: Vec, radius: number, layerName: string, lineType?: LineType): DxfEntity => [
  '0', 'CIRCLE', '8', layerName, ...ltypeTag(lineType),
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
        for (const s of prim.segments) out.push(dxfLine(s.a, s.b, layer.name, prim.lineType));
        break;

      case 'arc':
        out.push(
          dxfArc(prim.center, prim.radius, toDeg(prim.startAngle), toDeg(prim.endAngle), layer.name, prim.lineType),
        );
        break;

      case 'circle':
        out.push(dxfCircle(prim.center, prim.radius, layer.name, prim.lineType));
        break;

      case 'polygon':
        for (let i = 0; i < prim.points.length; i++) {
          out.push(dxfLine(prim.points[i], prim.points[(i + 1) % prim.points.length], layer.name, prim.lineType));
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

/**
 * ブロック定義。中身は画層 `0` に置く。
 * DXF の約束で、画層 0 のエンティティは INSERT 側の画層を継承する。
 */
export function dxfBlock(name: string, base: Vec, body: DxfEntity[]): string[] {
  const out: string[] = [
    '0', 'BLOCK', '8', '0', '2', name, '70', '0',
    '10', fmt(base.x), '20', fmt(base.y), '30', '0.0',
    '3', name, '1', '',
  ];
  for (const e of body) out.push(...e);
  out.push('0', 'ENDBLK', '8', '0');
  return out;
}

export function dxfInsert(
  name: string,
  at: Vec,
  scaleX: number,
  scaleY: number,
  rotationDeg: number,
  layerName: string,
): DxfEntity {
  return [
    '0', 'INSERT', '8', layerName, '2', name,
    '10', fmt(at.x), '20', fmt(at.y), '30', '0.0',
    '41', fmt(scaleX), '42', fmt(scaleY), '43', '1.0',
    '50', fmt(rotationDeg),
  ];
}
