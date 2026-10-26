import { FIXTURE_SPECS, outline, STEP_DEPTH, toWorld, verticalRange, type Fixture, type FixtureKind } from '../core/fixture.ts';
import { isSnappable } from '../core/entity.ts';
import { levelOf, type Level } from '../core/level.ts';
import { vec, type Vec } from '../core/geometry.ts';
import { theme } from '../render/theme.ts';
import type { Id, Scene } from '../core/types.ts';
import { extrudePrism, polygonFace, type Face3, type FaceSource } from './mesh.ts';
import { vec3, type Vec3 } from './mat4.ts';

/**
 * 構造物を立体にする。
 *
 * **平面の表（`core/fixture.ts`）とは別の表にしてある。** `core/` は DOM にも
 * 描画にも触らない規則で、平面の `Primitive` は中間表現なので core に置けるが、
 * 立体の組み立ては `render3d/` の持ち物。種別を足したとき**両方**を埋めないと
 * 型検査が止まる、という性質はどちらの表でも同じように効く。
 *
 * 箱で済まないものがある:
 * - **階段は段で作る。** 箱にすると嘘になる（既存のブロックの階段が 3D で
 *   立たないのは、箱で表すくらいなら出さない方がましだと判断したため）。
 *   段が出せるなら、出す方がよい
 * - **スロープは楔。** 上り口から上端まで一定の勾配で上がる
 * - **吹抜は穴なので何も出さない。** 床を抜くのはまだ出来ていない
 */
type SolidBuilder = (f: Fixture, level: Level, src: FaceSource, out: Face3[]) => void;

/** 柱と梁は躯体なので壁と同じ色にする */
const structural: SolidBuilder = (f, level, src, out) => {
  const { z0, z1 } = verticalRange(f, level);
  extrudePrism(outline(f), z0, z1, theme.wall3d, 'wall', src, out);
};

/**
 * 段をひとつずつ押し出す。
 *
 * 長手（ローカル y）方向に等分し、i 段目は上端が `z0 + (i+1) * 蹴上`。
 * 踏面の数は平面の記号（`stepGlyph`）と同じ式で決めるので、**2D の段板の本数と
 * 3D の段数が必ず一致する**。
 */
const steps: SolidBuilder = (f, level, src, out) => {
  const { z0, z1 } = verticalRange(f, level);
  const count = Math.max(2, Math.round(f.size.h / STEP_DEPTH));
  const rise = (z1 - z0) / count;
  for (let i = 0; i < count; i++) {
    const y0 = -f.size.h / 2 + (f.size.h * i) / count;
    const y1 = -f.size.h / 2 + (f.size.h * (i + 1)) / count;
    const poly = [
      toWorld(f, vec(-f.size.w / 2, y0)),
      toWorld(f, vec(f.size.w / 2, y0)),
      toWorld(f, vec(f.size.w / 2, y1)),
      toWorld(f, vec(-f.size.w / 2, y1)),
    ];
    extrudePrism(poly, z0, z0 + rise * (i + 1), theme.furniture3d, 'furniture', src, out);
  }
};

/**
 * 楔。上り口（ローカル y の負側）が下端、上端が上端。
 *
 * `extrudePrism` は上下が平らな角柱しか作れないので、ここだけ面を直に組む。
 * 刻んで階段にすると、スロープなのに段に見える。
 */
const wedge: SolidBuilder = (f, level, src, out) => {
  const { z0, z1 } = verticalRange(f, level);
  const w = f.size.w / 2;
  const h = f.size.h / 2;
  const at = (x: number, y: number): Vec => toWorld(f, vec(x, y));
  const lo0 = at(-w, -h);
  const lo1 = at(w, -h);
  const hi1 = at(w, h);
  const hi0 = at(-w, h);
  const color = theme.furniture3d;

  // 斜めの上面
  push(out, [p3(lo0, z0), p3(lo1, z0), p3(hi1, z1), p3(hi0, z1)], color, src);
  // 下の面（裏向き）
  push(out, [p3(hi0, z0), p3(hi1, z0), p3(lo1, z0), p3(lo0, z0)], color, src);
  // 上端の立ち上がり
  push(out, [p3(hi1, z0), p3(hi0, z0), p3(hi0, z1), p3(hi1, z1)], color, src);
  // 両側の三角
  push(out, [p3(lo1, z0), p3(hi1, z0), p3(hi1, z1)], color, src);
  push(out, [p3(hi0, z0), p3(lo0, z0), p3(hi0, z1)], color, src);
};

const nothing: SolidBuilder = () => {};

const p3 = (p: Vec, z: number): Vec3 => vec3(p.x, p.y, z);

const push = (out: Face3[], points: Vec3[], color: string, src: FaceSource): void => {
  out.push(polygonFace(points, color, 'furniture', src));
};

export const FIXTURE_SOLIDS: Record<FixtureKind, SolidBuilder> = {
  column: structural,
  roundColumn: structural,
  beam: structural,
  stair: steps,
  slope: wedge,
  void: nothing,
};

/** 構造物 1 つぶん */
export function buildFixtureFaces(scene: Scene, fixtureId: Id, out: Face3[]): void {
  const f = scene.fixtures[fixtureId];
  if (!f) return;
  if (!isSnappable(scene, { type: 'fixture', id: fixtureId })) return;
  if (!FIXTURE_SPECS[f.kind].solid) return;
  const src: FaceSource = { ref: { type: 'fixture', id: fixtureId }, levelId: f.levelId };
  FIXTURE_SOLIDS[f.kind](f, levelOf(scene, f.levelId), src, out);
}

/** 構造物の指紋。押し出す側が実際に読む欄だけを並べる */
export function fixtureFingerprint(scene: Scene, id: Id): string {
  const f = scene.fixtures[id];
  if (!f) return '';
  const level = levelOf(scene, f.levelId);
  return [
    f.kind, f.x, f.y, f.angle, f.size.w, f.size.h, f.base, f.height,
    level.floorZ, level.wallHeight,
    isSnappable(scene, { type: 'fixture', id }) ? 1 : 0,
  ].join(',');
}
