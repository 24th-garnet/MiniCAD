import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csgOperate, type BooleanOp } from '../src/render3d/csg.ts';
import { extrudePrism, type Face3, type FaceSource } from '../src/render3d/mesh.ts';
import { vec } from '../src/core/geometry.ts';
import type { Vec3 } from '../src/render3d/mat4.ts';
import { buildFixtureFaces } from '../src/render3d/fixture3d.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { emptyScene } from '../src/core/types.ts';

/**
 * ブーリアン（23 段）。**22 段の面を割る木をそのまま使う。**
 *
 * 見るのは体積と水密性。**体積は嘘をつけない**——面が 1 枚余れば増え、
 * 1 枚足りなければ減る。稜線の数は、切り口がちゃんと閉じたかを見る。
 */

const SRC: FaceSource = { ref: null, levelId: 'L1' };

/** 中心と大きさから直方体の面を作る */
function box(cx: number, cy: number, cz: number, w: number, h: number, d: number): Face3[] {
  const out: Face3[] = [];
  extrudePrism(
    [vec(cx - w / 2, cy - h / 2), vec(cx + w / 2, cy - h / 2),
      vec(cx + w / 2, cy + h / 2), vec(cx - w / 2, cy + h / 2)],
    cz - d / 2, cz + d / 2, '#888', 'wall', SRC, out,
  );
  return out;
}

/**
 * 閉じた面の集まりの体積。**外向きの法線なら正。**
 *
 * 各面を扇状に三角形へ割り、原点との四面体の符号付き体積を足す。
 * 面が余っていれば増え、足りなければ減るので、**ブーリアンの正しさが
 * 1 つの数字に出る**。
 */
function volume(faces: readonly Face3[]): number {
  let v = 0;
  for (const f of faces) {
    const p = f.points;
    for (let i = 1; i + 1 < p.length; i++) {
      v += det(p[0], p[i], p[i + 1]) / 6;
    }
  }
  return v;
}

const det = (a: Vec3, b: Vec3, c: Vec3): number =>
  a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.y - b.y * c.x);

/**
 * 閉じているか。**面積ベクトルの総和が 0 なら閉じている。**
 *
 * 有向の稜線を数える方法（`tests/solid.test.ts`）はここでは使えない。
 * ブーリアンは片側だけ割れた辺（T 字の継ぎ目）を必ず作るので、
 * 稜線は 1 対 1 にならない。**面積ベクトルの総和は T 字があっても 0 のまま**で、
 * 面が 1 枚でも欠けたり余ったりすれば残る。
 */
function closureResidual(faces: readonly Face3[]): number {
  let x = 0;
  let y = 0;
  let z = 0;
  let total = 0;
  for (const f of faces) {
    const p = f.points;
    let ax = 0;
    let ay = 0;
    let az = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      ax += a.y * b.z - a.z * b.y;
      ay += a.z * b.x - a.x * b.z;
      az += a.x * b.y - a.y * b.x;
    }
    x += ax;
    y += ay;
    z += az;
    total += Math.hypot(ax, ay, az);
  }
  return total === 0 ? 0 : Math.hypot(x, y, z) / total;
}

const closed = (faces: readonly Face3[]): boolean => closureResidual(faces) < 1e-9;

const near = (a: number, b: number, rel = 1e-6): boolean => Math.abs(a - b) <= Math.abs(b) * rel + 1e-6;

test('離れた 2 つを合成すると、体積が足し算になる', () => {
  const a = box(0, 0, 0, 1000, 1000, 1000);
  const b = box(5000, 0, 0, 1000, 1000, 1000);
  const got = csgOperate(a, b, 'unite');
  assert.ok(near(volume(got), 2e9), `体積 ${volume(got)}`);
  assert.ok(closed(got), `合成した結果が閉じていない（残差 ${closureResidual(got)}）`);
});

test('貼り合わせた箱の継ぎ目が消える', () => {
  // **接した面は、向きが逆のものどうしで打ち消し合う。**
  // 残ると中に壁が 1 枚挟まった立体になり、体積は合っていても見た目が嘘になる
  const a = box(0, 0, 0, 1000, 1000, 1000);
  const b = box(1000, 0, 0, 1000, 1000, 1000); // x = 500 でぴたりと接する
  const got = csgOperate(a, b, 'unite');
  assert.ok(near(volume(got), 2e9), `体積 ${volume(got)}`);
  // 継ぎ目の面（x = 500 の平面に乗る面）が 1 枚も残っていない
  const seam = got.filter((f) => f.points.every((p) => Math.abs(p.x - 500) < 1e-6));
  assert.equal(seam.length, 0, `継ぎ目が ${seam.length} 枚残っている`);
  assert.ok(closed(got), `貼り合わせた結果が閉じていない（残差 ${closureResidual(got)}）`);
});

test('重なった部分は 2 度数えない', () => {
  const a = box(0, 0, 0, 1000, 1000, 1000);
  const b = box(500, 0, 0, 1000, 1000, 1000); // 半分重なる
  const got = csgOperate(a, b, 'unite');
  // 1000×1000×1000 が 2 つ、重なりは 500×1000×1000
  assert.ok(near(volume(got), 2e9 - 0.5e9), `体積 ${volume(got)}`);
  assert.ok(closed(got), `閉じていない（残差 ${closureResidual(got)}）`);
});

test('切り欠きは引いた体積になる', () => {
  const a = box(0, 0, 0, 1000, 1000, 1000);
  const b = box(500, 0, 0, 1000, 1000, 1000);
  const got = csgOperate(a, b, 'subtract');
  assert.ok(near(volume(got), 0.5e9), `体積 ${volume(got)}`);
  assert.ok(closed(got), `切り欠いた結果が閉じていない（残差 ${closureResidual(got)}）`);
});

test('交差は重なった部分だけになる', () => {
  const a = box(0, 0, 0, 1000, 1000, 1000);
  const b = box(500, 0, 0, 1000, 1000, 1000);
  const got = csgOperate(a, b, 'intersect');
  assert.ok(near(volume(got), 0.5e9), `体積 ${volume(got)}`);
  assert.ok(closed(got), `交差の結果が閉じていない（残差 ${closureResidual(got)}）`);
});

test('真ん中をくり抜くと、穴の体積だけ減る', () => {
  // **貫通しない穴。** 内側に面が増えるので、水密かどうかがいちばん効く
  // a は z が -1000〜1000、b は z が -500〜1500。重なるのは 1500 ぶん
  const a = box(0, 0, 0, 2000, 2000, 2000);
  const b = box(0, 0, 500, 600, 600, 2000);
  const got = csgOperate(a, b, 'subtract');
  assert.ok(near(volume(got), 8e9 - 600 * 600 * 1500), `体積 ${volume(got)}`);
});

test('離れたものを切り欠いても、交差させても、嘘をつかない', () => {
  const a = box(0, 0, 0, 1000, 1000, 1000);
  const b = box(9000, 0, 0, 1000, 1000, 1000);
  assert.ok(near(volume(csgOperate(a, b, 'subtract')), 1e9), '離れたものを引いたら減った');
  assert.equal(csgOperate(a, b, 'intersect').length, 0, '離れたものが交差した');
});

test('空を相手にしても落ちない', () => {
  const a = box(0, 0, 0, 1000, 1000, 1000);
  for (const op of ['unite', 'subtract', 'intersect'] as BooleanOp[]) {
    assert.doesNotThrow(() => csgOperate(a, [], op));
    assert.doesNotThrow(() => csgOperate([], a, op));
  }
  assert.ok(near(volume(csgOperate(a, [], 'subtract')), 1e9), '空で引いたら減った');
  assert.equal(csgOperate(a, [], 'intersect').length, 0, '空と交差して残った');
});

test('面がぴたりと重なったまま切り欠いても、体積が合う', () => {
  // **接した面の向きで内と外が分かれる。** 同じ向きなら表、逆向きなら裏に振り分けないと、
  // 境目の面が残ったり余計に消えたりする
  const a = box(0, 0, 0, 1000, 1000, 1000);
  for (const b of [
    box(0, 0, 500, 400, 400, 1000),      // 上面と面一のポケット
    box(500, 0, 0, 400, 400, 1000),      // 側面と面一の欠き込み
    box(0, 0, 0, 1000, 400, 400),        // 左右の面が両方とも面一の溝
  ]) {
    const got = csgOperate(a, b, 'subtract');
    const overlap = volume(csgOperate(a, b, 'intersect'));
    assert.ok(closed(got), `閉じていない（残差 ${closureResidual(got)}）`);
    assert.ok(near(volume(got), 1e9 - overlap),
      `体積 ${Math.round(volume(got))} / 期待 ${Math.round(1e9 - overlap)}`);
  }
});

test('面がぴたりと重なったまま合成しても、体積が合う', () => {
  const a = box(0, 0, 0, 1000, 1000, 1000);
  for (const b of [
    box(0, 0, 1000, 400, 400, 1000),     // 上に乗る（底が a の上面と面一）
    box(1000, 0, 0, 400, 400, 1000),     // 横に付く
  ]) {
    const got = csgOperate(a, b, 'unite');
    assert.ok(closed(got), `閉じていない（残差 ${closureResidual(got)}）`);
    assert.ok(near(volume(got), 1e9 + volume(b)),
      `体積 ${Math.round(volume(got))} / 期待 ${Math.round(1e9 + volume(b))}`);
  }
});

test('立方体から球を抜くと、理論値に近い体積になる', () => {
  // **軸に揃っていない面が 288 枚**入る。平面が斜めでも切り口が閉じるか。
  // 球は 24 × 12 の帯の近似なので、理論値（4/3 π r³）より少し小さい
  const cube = box(0, 0, 0, 2000, 2000, 2000);
  const ball = sphereFaces(600);
  const got = csgOperate(cube, ball, 'subtract');
  assert.ok(closed(got), `閉じていない（残差 ${closureResidual(got)}）`);

  // **抜けた体積は、球そのものの体積とぴたり同じ**でなければならない
  // （球は立方体の中に完全に入っている）。ここは近似の話ではなく、
  // ブーリアンが余計に削ったり削り残したりしていないか
  const removed = 8e9 - volume(got);
  assert.ok(near(removed, volume(ball), 1e-9),
    `抜けた体積 ${Math.round(removed)} / 球の体積 ${Math.round(volume(ball))}`);

  // 球は 24 × 12 の帯の近似なので、理論値より数 % 小さい。**そういうものだと書いておく**
  const ideal = (4 / 3) * Math.PI * 600 ** 3;
  assert.ok(volume(ball) < ideal && volume(ball) > ideal * 0.95,
    `球の近似が粗すぎる（${Math.round(volume(ball))} / ${Math.round(ideal)}）`);
});

/** 原点を中心にした球の面。構造の表から本物を借りる */
function sphereFaces(radius: number): Face3[] {
  const scene = emptyScene();
  scene.fixtures.s = {
    id: 's', kind: 'sphere', x: 0, y: 0, angle: 0,
    size: { w: radius * 2, h: radius * 2 }, outline: null, combine: null,
    base: -radius, height: radius * 2, label: '',
    layerId: LAYER_IDS.shape, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(),
  };
  const out: Face3[] = [];
  buildFixtureFaces(scene, 's', out);
  return out;
}
