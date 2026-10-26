import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionAlong, sectionToSvg, SECTION_DISCLAIMER } from '../src/io/section.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { vec } from '../src/core/geometry.ts';
import { emptyScene, type Scene } from '../src/core/types.ts';
import { makeOpening } from './make.ts';
import { activeLevel } from '../src/core/level.ts';

/** 縦 2 枚の壁を、横切る線で切る */
function twoWalls(): Scene {
  const scene = emptyScene();
  for (const x of [1000, 4000]) {
    const a = findOrCreateNode(scene, vec(x, 0));
    const b = findOrCreateNode(scene, vec(x, 3000));
    addWall(scene, a, b, 150);
  }
  return scene;
}

test('切断線を横切った壁だけが切り口になる', () => {
  const scene = twoWalls();
  // 1000 と 4000 を通る横線
  const got = sectionAlong(scene, vec(0, 1500), vec(6000, 1500))!;
  assert.ok(got);
  assert.equal(got.cuts.length, 2);
  // 切断線の始点からの距離で並ぶ
  assert.deepEqual(got.cuts.map((c) => Math.round(c.along)), [1000, 4000]);
  assert.deepEqual(got.cuts.map((c) => c.thickness), [150, 150]);
});

test('横切らない線では断面にならない', () => {
  const scene = twoWalls();
  assert.equal(sectionAlong(scene, vec(0, 5000), vec(6000, 5000)), null, '壁の外を通る線で切れた');
  assert.equal(sectionAlong(scene, vec(0, 0), vec(0, 0)), null, '長さ 0 の線で切れた');
});

test('壁の端より先は切らない', () => {
  // 切断線の範囲外にある交点は数えない
  const scene = twoWalls();
  const got = sectionAlong(scene, vec(0, 1500), vec(2000, 1500))!;
  assert.equal(got.cuts.length, 1, `${got.cuts.length} 枚切れた`);
  assert.equal(Math.round(got.cuts[0].along), 1000);
});

test('切った位置に開口があれば、その上下端が出る', () => {
  const scene = twoWalls();
  const wallId = Object.keys(scene.walls)[0];
  // 壁の始点 (1000,0) から 1500 の位置、幅 900 → 1050〜1950 を覆う
  const op = makeOpening(wallId, { kind: 'door', offset: 1500, width: 900 });
  scene.openings[op.id] = op;

  const through = sectionAlong(scene, vec(0, 1500), vec(6000, 1500))!;
  const cut = through.cuts.find((c) => c.wallId === wallId)!;
  assert.ok(cut.opening, '開口の上に切ったのに拾えていない');
  assert.equal(cut.opening.sill, 0, 'ドアなのに床から始まっていない');
  assert.ok(cut.opening.head > 1500, `頭が ${cut.opening.head}`);

  // 開口を外した位置で切ると拾わない
  const beside = sectionAlong(scene, vec(0, 500), vec(6000, 500))!;
  assert.equal(beside.cuts.find((c) => c.wallId === wallId)!.opening, null);
});

test('垂れ壁は宙に浮いた切り口になる', () => {
  // **断面はまさにこれを見るための図**
  const scene = twoWalls();
  const wallId = Object.keys(scene.walls)[0];
  scene.walls[wallId].base = 1900;

  const got = sectionAlong(scene, vec(0, 1500), vec(6000, 1500))!;
  const cut = got.cuts.find((c) => c.wallId === wallId)!;
  assert.equal(cut.base, 1900, '下端が床のまま');
  assert.equal(cut.top, activeLevel(scene).wallHeight, '天井に届いていない');
});

test('断面の SVG が 1 枚の正しい形になり、但し書きが入る', () => {
  const scene = twoWalls();
  const got = sectionAlong(scene, vec(0, 1500), vec(6000, 1500))!;
  const svg = sectionToSvg(got);
  assert.equal(svg.match(/<svg/g)?.length, 1);
  assert.ok(svg.trimEnd().endsWith('</svg>'));
  // **切った先を描いていないことを書く**
  assert.ok(svg.includes(SECTION_DISCLAIMER.slice(0, 10)), '但し書きが無い');
  assert.ok(svg.includes('class="cut"'), '切り口が無い');
  assert.ok(svg.includes('class="ceiling"'), '天井線が無い');
});

test('斜めの切断線でも切れる', () => {
  const scene = twoWalls();
  const got = sectionAlong(scene, vec(0, 0), vec(6000, 3000))!;
  assert.equal(got.cuts.length, 2);
  // 斜めなので、切断線に沿った距離は平面の距離より長い
  assert.ok(got.cuts[0].along > 1000, `${got.cuts[0].along}`);
});
