import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, type Id, type Scene } from '../src/core/types.ts';
import { addWall, findOrCreateNode, splitWall, wallArc, wallLength } from '../src/core/ops.ts';
import { dist, vec } from '../src/core/geometry.ts';
import { CONSTRAINT_SPECS } from '../src/core/constraints.ts';
import { joinWalls } from '../src/core/join.ts';
import { extendWall, offsetWall, trimWall, wallCurve } from '../src/core/modify.ts';
import { makeOpening } from './make.ts';

/**
 * 円弧壁に効かないものを、黙って壊れさせずに断る。
 *
 * **いちばん危ないのは「それらしく動いて、数字だけが違う」こと。**
 * 弦の上で割る・弦の長さで開口をずらす・膨らみを落として繋ぐ——どれも
 * エラーにならず、図面だけが静かにずれる。
 */

const R = 3000;
const QUARTER = Math.tan(Math.PI / 8);

function arcScene(bulge = QUARTER): { scene: Scene; wall: Id } {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(R, R));
  return { scene, wall: addWall(scene, a, b, 200, undefined, bulge)!.id };
}

test('円弧壁には拘束を付けられない', () => {
  const { scene, wall } = arcScene();
  const straight = addWall(
    scene,
    findOrCreateNode(scene, vec(0, -5000)),
    findOrCreateNode(scene, vec(4000, -5000)),
    200,
  )!.id;

  for (const [kind, spec] of Object.entries(CONSTRAINT_SPECS)) {
    const walls = spec.arity === 1 ? [wall] : [wall, straight];
    assert.ok(!spec.applicable(scene, walls), `${kind} が円弧壁に付いてしまう`);
  }
  // 直線どうしには今までどおり付く
  const another = addWall(
    scene,
    findOrCreateNode(scene, vec(0, -7000)),
    findOrCreateNode(scene, vec(4000, -7000)),
    200,
  )!.id;
  for (const [kind, spec] of Object.entries(CONSTRAINT_SPECS)) {
    const walls = spec.arity === 1 ? [straight] : [straight, another];
    assert.ok(spec.applicable(scene, walls), `${kind} が直線にも付かなくなった`);
  }
});

test('円弧の分割は弧の上で割り、掃過角も割る', () => {
  const { scene, wall } = arcScene();
  const arc = wallArc(scene, scene.walls[wall])!;
  const total = wallLength(scene, scene.walls[wall]);

  // 弧の真ん中あたりを指す
  const mid = vec(
    arc.center.x + Math.cos(arc.from + arc.sweep / 2) * arc.radius,
    arc.center.y + Math.sin(arc.from + arc.sweep / 2) * arc.radius,
  );
  const node = splitWall(scene, wall, mid)!;
  assert.ok(node, '割れていない');

  // 新しい節点は弧の上（中心からの距離が半径）
  const p = scene.nodes[node];
  assert.ok(
    Math.abs(dist(vec(p.x, p.y), arc.center) - arc.radius) < 1e-6,
    `節点が弧から外れている（${dist(vec(p.x, p.y), arc.center)}）`,
  );

  // 2 本とも円弧のまま、半径が変わらず、長さの合計が元と同じ
  const walls = Object.values(scene.walls);
  assert.equal(walls.length, 2);
  let sum = 0;
  for (const w of walls) {
    const a = wallArc(scene, w);
    assert.ok(a, `${w.id} が直線になっている`);
    assert.ok(Math.abs(a!.radius - R) < 1e-6, `半径が ${a!.radius} に変わった`);
    sum += wallLength(scene, w);
  }
  assert.ok(Math.abs(sum - total) < 1e-6, `弧長の合計が ${sum}（元 ${total}）`);
});

test('分割しても開口の位置が動かない', () => {
  const { scene, wall } = arcScene();
  const total = wallLength(scene, scene.walls[wall]);
  const op = makeOpening(wall, { kind: 'window', offset: total * 0.75, width: 900 });
  scene.openings[op.id] = op;

  const arc = wallArc(scene, scene.walls[wall])!;
  const at = (t: number) =>
    vec(
      arc.center.x + Math.cos(arc.from + arc.sweep * t) * arc.radius,
      arc.center.y + Math.sin(arc.from + arc.sweep * t) * arc.radius,
    );
  const before = at(0.75);
  splitWall(scene, wall, at(0.4));

  // 窓は後半の壁へ移り、その壁の始点から測り直されている
  const host = scene.walls[scene.openings[op.id].wallId];
  const hostArc = wallArc(scene, host)!;
  const moved = scene.openings[op.id].offset / wallLength(scene, host);
  const after = vec(
    hostArc.center.x + Math.cos(hostArc.from + hostArc.sweep * moved) * hostArc.radius,
    hostArc.center.y + Math.sin(hostArc.from + hostArc.sweep * moved) * hostArc.radius,
  );
  assert.ok(dist(before, after) < 1e-6, `窓が ${Math.round(dist(before, after))}mm 動いた`);
});

test('同じ円の 2 本は繋げるが、円弧と直線は繋がない', () => {
  const { scene, wall } = arcScene();
  const total = wallLength(scene, scene.walls[wall]);
  const arc = wallArc(scene, scene.walls[wall])!;
  const at = (t: number) =>
    vec(
      arc.center.x + Math.cos(arc.from + arc.sweep * t) * arc.radius,
      arc.center.y + Math.sin(arc.from + arc.sweep * t) * arc.radius,
    );
  splitWall(scene, wall, at(0.5));
  const [x, y] = Object.keys(scene.walls);
  assert.ok(joinWalls(scene, x, y), '同じ円の 2 本が繋がらない');
  assert.equal(Object.keys(scene.walls).length, 1);
  const back = Object.values(scene.walls)[0];
  assert.ok(Math.abs(wallLength(scene, back) - total) < 1e-6, '繋いだら長さが変わった');
  assert.ok(Math.abs(wallArc(scene, back)!.radius - R) < 1e-6, '繋いだら半径が変わった');
});

test('円弧と直線は繋がない——残った膨らみが相手まで曲げる', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const c = findOrCreateNode(scene, vec(8000, 0));
  const arcWall = addWall(scene, a, b, 200, undefined, 0.3)!;
  const line = addWall(scene, b, c, 200)!;
  assert.ok(!joinWalls(scene, arcWall.id, line.id), '円弧と直線が繋がってしまう');
  assert.equal(Object.keys(scene.walls).length, 2);
});

test('円弧壁は切らない・伸ばさない', () => {
  const { scene, wall } = arcScene();
  // 刃になる壁を 1 本置く
  addWall(scene, findOrCreateNode(scene, vec(0, 2000)), findOrCreateNode(scene, vec(6000, 2000)), 200);
  assert.ok(!trimWall(scene, wall, vec(100, 100)), '円弧壁が切れてしまう');
  assert.ok(!extendWall(scene, wall, vec(100, 100)), '円弧壁が伸びてしまう');
  assert.equal(Object.keys(scene.walls).length, 2, '壁の本数が変わった');
});

test('円弧壁のオフセットは同心円弧——曲がりが落ちない', () => {
  const { scene, wall } = arcScene();
  const arc = wallArc(scene, scene.walls[wall])!;
  // 中心から遠い側を指す＝外へ 300mm
  const outside = vec(arc.center.x - 9000, arc.center.y - 9000);
  const made = offsetWall(scene, wall, 300, outside)!;
  assert.ok(made, 'オフセットできていない');
  const copy = wallArc(scene, scene.walls[made]);
  assert.ok(copy, '写した壁が直線になっている');
  assert.ok(Math.abs(copy!.radius - (R + 300)) < 1e-6, `半径 ${copy!.radius}（期待 ${R + 300}）`);
  assert.ok(dist(copy!.center, arc.center) < 1e-6, '中心がずれている');
});

test('トリムの刃としても円弧で扱う', () => {
  const { scene, wall } = arcScene();
  const curve = wallCurve(scene, scene.walls[wall]);
  assert.equal(curve.kind, 'arc', '円弧壁が線分として扱われている');
});
