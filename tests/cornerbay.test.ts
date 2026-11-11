import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, type Id, type Scene } from '../src/core/types.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { dist, vec, type Vec } from '../src/core/geometry.ts';
import {
  cornerBayBlocker, cornerBayMoveBlocker, defaultCornerBay, nearestCorner, placeCornerBay,
} from '../src/core/cornerBay.ts';
import { expandGroups } from '../src/core/group.ts';
import { outline } from '../src/core/fixture.ts';
import { activeLevel } from '../src/core/level.ts';
import { makeOpening } from './make.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { defaultSettings } from '../src/core/store.ts';
import { sceneToSvg } from '../src/io/svg.ts';
import { sceneToDxf } from '../src/io/dxf.ts';

/**
 * L 型出窓。**角をまたぐので 1 つの `Opening` では表せない。**
 *
 * 窓 2 つ（穴だけ）＋ L 字の張り出し 1 つを置いて、1 グループに束ねる。
 */

const T = 150;

/** 原点で直角に折れる 2 本の壁。内側は第 1 象限 */
function cornerScene(): { scene: Scene; corner: Id } {
  const scene = emptyScene();
  const c = findOrCreateNode(scene, vec(0, 0));
  const east = findOrCreateNode(scene, vec(4000, 0));
  const north = findOrCreateNode(scene, vec(0, 4000));
  addWall(scene, c, east, T);
  addWall(scene, c, north, T);
  return { scene, corner: c };
}

test('壁 2 本の角でなければ断る', () => {
  const { scene, corner } = cornerScene();
  const opts = defaultCornerBay();
  assert.equal(cornerBayBlocker(scene, corner, opts), null, '直角の角に置けない');

  // 3 本目を足すと角ではなくなる
  addWall(scene, corner, findOrCreateNode(scene, vec(-4000, 0)), T);
  assert.match(cornerBayBlocker(scene, corner, opts)!, /壁 2 本の角/);
});

test('まっすぐ並んだ壁の間には置かない', () => {
  const scene = emptyScene();
  const c = findOrCreateNode(scene, vec(0, 0));
  addWall(scene, c, findOrCreateNode(scene, vec(4000, 0)), T);
  addWall(scene, c, findOrCreateNode(scene, vec(-4000, 0)), T);
  assert.match(cornerBayBlocker(scene, c, defaultCornerBay())!, /角になっていません/);
});

test('円弧壁の角には置かない', () => {
  const scene = emptyScene();
  const c = findOrCreateNode(scene, vec(0, 0));
  addWall(scene, c, findOrCreateNode(scene, vec(4000, 0)), T, undefined, 0.4);
  addWall(scene, c, findOrCreateNode(scene, vec(0, 4000)), T);
  assert.match(cornerBayBlocker(scene, c, defaultCornerBay())!, /円弧壁/);
});

test('壁に収まらない幅は断る', () => {
  const { scene, corner } = cornerScene();
  assert.match(
    cornerBayBlocker(scene, corner, { ...defaultCornerBay(), width: 9000 })!,
    /収まりません/,
  );
});

test('同じところに建具があれば断る', () => {
  // 角からの 1200mm をまるごと塞ぐ戸。逃げ場が無い
  const { scene, corner } = cornerScene();
  const wall = Object.values(scene.walls)[0];
  const op = makeOpening(wall.id, { kind: 'door', offset: 1300, width: 2400 });
  scene.openings[op.id] = op;
  assert.match(
    cornerBayBlocker(scene, corner, defaultCornerBay()) ?? '(断っていない)',
    /別の建具/,
  );
});

test('窓 2 つと L 字の張り出し 1 つを置き、1 グループにする', () => {
  const { scene, corner } = cornerScene();
  const made = placeCornerBay(scene, corner, defaultCornerBay())!;
  assert.ok(made, '置けていない');
  assert.equal(made.filter((r) => r.type === 'opening').length, 2);
  assert.equal(made.filter((r) => r.type === 'fixture').length, 1);

  // **窓は張り出しを持たない。** 箱は L 字の Fixture が 1 つで受け持つ
  for (const op of Object.values(scene.openings)) {
    assert.equal(op.bay, null, '窓が自分でも張り出しを持っている');
  }
  // 1 つ掴めば 3 つ選ばれる
  assert.equal(expandGroups(scene, [made[0]]).length, 3, 'グループになっていない');
});

test('窓は角にいちばん寄せた位置に入る（ジャムのぶんだけ残る）', () => {
  // **角にぴったりは寄らない。** `clampOpening` が壁の端から 20mm 空けるので、
  // 角には必ず小さな壁が残る——ジャムの無い建具は作れない。
  // 手で置くときと同じ規則を通すので、寄せ方が食い違わない
  const { scene, corner } = cornerScene();
  placeCornerBay(scene, corner, { ...defaultCornerBay(), width: 1200 });
  for (const op of Object.values(scene.openings)) {
    const wall = scene.walls[op.wallId];
    assert.equal(wall.a, corner, '角はどちらの壁でも a 側のはず');
    assert.equal(op.offset, 620, `窓の中心が ${op.offset}（期待 1200/2 + 20）`);
  }
});

test('L 字の輪郭が角の外側を回る', () => {
  // 原点の角、内側は第 1 象限。張り出しは第 3 象限へ出る
  const { scene, corner } = cornerScene();
  const made = placeCornerBay(scene, corner, {
    ...defaultCornerBay(), width: 1200, depth: 450,
  })!;
  const fixture = scene.fixtures[made.find((r) => r.type === 'fixture')!.id];
  const pts = outline(fixture, activeLevel(scene));
  assert.equal(pts.length, 6, `輪郭が ${pts.length} 点（L 字は 6 点）`);

  const has = (want: Vec) => pts.some((p: Vec) => dist(p, want) < 1e-6);
  // 壁の面 75、張り出しの先 75+450 = 525。
  // 窓の遠い端は角から 620 + 600 = 1220（ジャムの 20mm を含む）
  assert.ok(has(vec(1220, -75)), '壁 1 の面、窓の遠い端が無い');
  assert.ok(has(vec(1220, -525)), '壁 1 の張り出しの先が無い');
  assert.ok(has(vec(-525, -525)), '外側の角が無い');
  assert.ok(has(vec(-525, 1220)), '壁 2 の張り出しの先が無い');
  assert.ok(has(vec(-75, 1220)), '壁 2 の面、窓の遠い端が無い');
  assert.ok(has(vec(-75, -75)), '面どうしの角が無い');
});

test('張り出しの高さは窓に合う', () => {
  const { scene, corner } = cornerScene();
  const made = placeCornerBay(scene, corner, {
    ...defaultCornerBay(), sillHeight: 800, height: 1100,
  })!;
  const fixture = scene.fixtures[made.find((r) => r.type === 'fixture')!.id];
  assert.equal(fixture.base, 800, '窓台に合っていない');
  assert.equal(fixture.height, 1100, '窓の高さに合っていない');
});

test('角を探すのは壁 2 本のところだけ', () => {
  const { scene, corner } = cornerScene();
  assert.equal(nearestCorner(scene, vec(60, 60), 200), corner);
  // 壁の遠い端は 1 本しか付いていないので角ではない
  assert.equal(nearestCorner(scene, vec(4000, 0), 200), null);
  assert.equal(nearestCorner(scene, vec(2000, 2000), 200), null, '遠すぎるのに拾った');
});

test('断られたときは何も変えない', () => {
  const { scene, corner } = cornerScene();
  const before = JSON.stringify(scene);
  assert.equal(placeCornerBay(scene, corner, { ...defaultCornerBay(), width: 9000 }), null);
  assert.equal(JSON.stringify(scene), before, '断ったのに図面が変わった');
});

test('L 型出窓は動かせない（三者がばらけるため）', () => {
  // 窓は壁の上の 1 次元の座標、張り出しは平面の座標。まとめて動かすと
  // 2 つの窓がそれぞれの壁で別々に丸められて、L 字だけが素直に動く
  const { scene, corner } = cornerScene();
  const made = placeCornerBay(scene, corner, defaultCornerBay())!;
  for (const ref of made) {
    assert.match(
      cornerBayMoveBlocker(scene, [ref]) ?? '(断っていない)',
      /動かせません/,
      `${ref.type} を掴んで動かせてしまう`,
    );
  }
  // 関係ないものは動かせる
  const other = addWall(scene, findOrCreateNode(scene, vec(0, 9000)),
    findOrCreateNode(scene, vec(4000, 9000)), T)!;
  assert.equal(cornerBayMoveBlocker(scene, [{ type: 'wall', id: other.id }]), null);

  // 普通の出窓は動かせる（L 型だけの話）
  const plain = makeOpening(other.id, {
    kind: 'window', offset: 2000, width: 1600,
    bay: { shape: 'box', depth: 450, side: 1 },
  });
  scene.openings[plain.id] = plain;
  assert.equal(
    cornerBayMoveBlocker(scene, [{ type: 'opening', id: plain.id }]), null,
    '普通の出窓まで動かせなくなっている',
  );
});

// --- 張り出しが紙に出るか ---

test('出窓の張り出しが SVG と DXF にも出る', () => {
  // **以前は画面と 3D にだけ出ていた。** 紙に落ちた瞬間に、出窓が普通の窓に
  // なっていた——受け取った側に理由の分からない違いとして出る
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const wall = addWall(scene, a, b, T)!;
  const op = makeOpening(wall.id, {
    kind: 'window', offset: 2000, width: 1600,
    bay: { shape: 'box', depth: 450, side: 1 },
  });
  scene.openings[op.id] = op;

  const rooms = detectRooms(scene);
  // 張り出しの先は壁芯から 75 + 450 = 525。壁だけなら 75 までしか無い
  const svg = sceneToSvg(scene, rooms, defaultSettings());
  assert.ok(/525/.test(svg), 'SVG に張り出しが出ていない');

  const dxf = sceneToDxf(scene, rooms, defaultSettings(), {
    escapeUnicode: false, trueDimension: true,
  });
  assert.ok(/\r\n525\.0\r\n/.test(dxf), 'DXF に張り出しが出ていない');
});

test('張り出しを持たない窓では何も増えない', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const wall = addWall(scene, a, b, T)!;
  const op = makeOpening(wall.id, { kind: 'window', offset: 2000, width: 1600 });
  scene.openings[op.id] = op;
  const svg = sceneToSvg(scene, detectRooms(scene), defaultSettings());
  assert.ok(!/525/.test(svg), '張り出しが無いのに出ている');
});
