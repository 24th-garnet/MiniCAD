import { dist, toDeg, toRad } from '../core/geometry.ts';
import { JIS_TEXT_HEIGHTS } from '../core/standard.ts';
import type { Shape, ShapeKind } from '../core/shapes.ts';
import { checkboxField, numberField, readonlyField, selectField, textField } from './dom.ts';

type Edit = (fn: () => void | boolean) => void;
type Fields<S> = (s: S, edit: Edit) => HTMLElement[];

const MM = { suffix: 'mm', step: 50 } as const;

/**
 * 図形のプロパティ欄。
 * core は DOM に触らない規約なので、幾何の表（SHAPE_GEOMETRY）とは別に持つ。
 * 種別を足すとここが型エラーになる。
 */
export const SHAPE_FIELDS: { [K in ShapeKind]: Fields<Extract<Shape, { shape: K }>> } = {
  line: (s, edit) => [
    readonlyField('種類', '線'),
    readonlyField('長さ', `${Math.round(dist(s.a, s.b))} mm`),
    numberField('始点 X', s.a.x, (v) => edit(() => void (s.a = { ...s.a, x: v })), MM),
    numberField('始点 Y', s.a.y, (v) => edit(() => void (s.a = { ...s.a, y: v })), MM),
    numberField('終点 X', s.b.x, (v) => edit(() => void (s.b = { ...s.b, x: v })), MM),
    numberField('終点 Y', s.b.y, (v) => edit(() => void (s.b = { ...s.b, y: v })), MM),
  ],

  polyline: (s, edit) => [
    readonlyField('種類', 'ポリライン'),
    readonlyField('頂点', `${s.points.length} 点`),
    readonlyField('全長', `${Math.round(polylineLength(s.points, s.closed))} mm`),
    checkboxField('閉じる', s.closed, (v) => edit(() => void (s.closed = v))),
  ],

  arc: (s, edit) => [
    readonlyField('種類', '円弧'),
    numberField('中心 X', s.center.x, (v) => edit(() => void (s.center = { ...s.center, x: v })), MM),
    numberField('中心 Y', s.center.y, (v) => edit(() => void (s.center = { ...s.center, y: v })), MM),
    numberField('半径', s.radius, (v) => edit(() => void (s.radius = Math.max(1, v))), MM),
    numberField('開始角', toDeg(s.startAngle), (v) => edit(() => void (s.startAngle = toRad(v))), {
      step: 15,
      suffix: '°',
    }),
    numberField('終了角', toDeg(s.endAngle), (v) => edit(() => void (s.endAngle = toRad(v))), {
      step: 15,
      suffix: '°',
    }),
  ],

  circle: (s, edit) => [
    readonlyField('種類', '円'),
    numberField('中心 X', s.center.x, (v) => edit(() => void (s.center = { ...s.center, x: v })), MM),
    numberField('中心 Y', s.center.y, (v) => edit(() => void (s.center = { ...s.center, y: v })), MM),
    numberField('半径', s.radius, (v) => edit(() => void (s.radius = Math.max(1, v))), MM),
  ],

  text: (s, edit) => [
    readonlyField('種類', '文字'),
    textField('内容', s.text, (v) => edit(() => void (s.text = v))),
    selectField(
      '文字高',
      String(s.height),
      JIS_TEXT_HEIGHTS.map((h) => ({ value: String(h), label: `${h} mm` })),
      (v) => edit(() => void (s.height = Number(v))),
    ),
    selectField(
      '揃え',
      s.align,
      [
        { value: 'left', label: '左' },
        { value: 'center', label: '中央' },
        { value: 'right', label: '右' },
      ],
      (v) => edit(() => void (s.align = v as typeof s.align)),
    ),
    numberField('角度', toDeg(s.angle), (v) => edit(() => void (s.angle = toRad(v))), { step: 15, suffix: '°' }),
    numberField('X', s.at.x, (v) => edit(() => void (s.at = { ...s.at, x: v })), MM),
    numberField('Y', s.at.y, (v) => edit(() => void (s.at = { ...s.at, y: v })), MM),
  ],

  point: (s, edit) => [
    readonlyField('種類', '点'),
    numberField('X', s.at.x, (v) => edit(() => void (s.at = { ...s.at, x: v })), MM),
    numberField('Y', s.at.y, (v) => edit(() => void (s.at = { ...s.at, y: v })), MM),
  ],
};

export function shapeFields(s: Shape, edit: Edit): HTMLElement[] {
  return SHAPE_FIELDS[s.shape](s as never, edit);
}

function polylineLength(points: { x: number; y: number }[], closed: boolean): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) total += dist(points[i], points[i + 1]);
  if (closed && points.length > 2) total += dist(points[points.length - 1], points[0]);
  return total;
}
