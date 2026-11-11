import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, type Scene } from '../src/core/types.ts';
import { addWall, findOrCreateNode, setWallRadius, wallArc } from '../src/core/ops.ts';
import { dist, pointOnBulgeArc, vec, type Vec } from '../src/core/geometry.ts';
import { pickAt, pickInRect } from '../src/core/pick.ts';
import { snapPoint } from '../src/core/snap.ts';
import { defaultSettings } from '../src/core/store.ts';
import { WallTool } from '../src/tools/wall.ts';
import type { Editor } from '../src/ui/editor.ts';
import type { PointerInfo } from '../src/tools/tool.ts';

/**
 * 円弧壁を描き、掴み、半径で直す。
 *
 * **掴めないものは直せない。** 弦で当たり判定を取ると、壁の上を叩いても
 * 拾えず、壁から離れた弦の上でだけ拾える——曲げた瞬間に触れなくなる。
 */

const R = 3000;
/** 四分円 */
const QUARTER = Math.tan(Math.PI / 8);

function arcScene(bulge = QUARTER): { scene: Scene; id: string } {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(R, R));
  return { scene, id: addWall(scene, a, b, 200, undefined, bulge)!.id };
}

const onArc = (scene: Scene, id: string, t: number): Vec =>
  pointOnBulgeArc(wallArc(scene, scene.walls[id])!, t);

test('円弧壁は弧の上で掴める（弦の上では掴めない）', () => {
  const { scene, id } = arcScene();
  const mid = onArc(scene, id, 0.5);
  assert.deepEqual(pickAt(scene, mid, 50), { type: 'wall', id }, '弧の上で拾えない');

  // 弦の中点。四分円なら弧から 500mm 以上離れている
  const chord = vec(R / 2, R / 2);
  assert.ok(dist(chord, mid) > 400, '弦と弧が近すぎて識別しない');
  assert.equal(pickAt(scene, chord, 50), null, '壁の無いところ（弦の上）で拾えてしまう');
});

test('範囲選択も弧で見る', () => {
  const { scene, id } = arcScene();
  const mid = onArc(scene, id, 0.5);
  // 弧の真ん中だけを跨ぐ細い枠。端点はどちらも外
  const box = { min: vec(mid.x - 100, mid.y - 100), max: vec(mid.x + 100, mid.y + 100) };
  assert.deepEqual(
    pickInRect(scene, box.min, box.max, true),
    [{ type: 'wall', id }],
    '弧を横切る枠で拾えない',
  );
});

test('スナップも弧の上に乗る', () => {
  const { scene, id } = arcScene();
  const st = { ...defaultSettings(), snapGrid: false, snapNode: false };
  const mid = onArc(scene, id, 0.5);

  // 弧のすぐそば
  const near = vec(mid.x + 30, mid.y + 30);
  const got = snapPoint(scene, st, near, { radius: 200 });
  assert.ok(got.kind === 'wall' || got.kind === 'midpoint', `吸い付かない: ${got.kind}`);
  const arc = wallArc(scene, scene.walls[id])!;
  assert.ok(
    Math.abs(dist(got.point, arc.center) - arc.radius) < 1e-6,
    `吸い付いた点が弧の上に無い（${dist(got.point, arc.center)}）`,
  );
});

test('半径を変えても端点は動かず、優弧かどうかも変わらない', () => {
  const { scene, id } = arcScene();
  const wall = scene.walls[id];
  const before = [scene.nodes[wall.a], scene.nodes[wall.b]].map((n) => ({ x: n.x, y: n.y }));

  assert.ok(setWallRadius(scene, wall, 5000));
  assert.ok(Math.abs(wallArc(scene, wall)!.radius - 5000) < 1e-6, '半径が変わっていない');
  const after = [scene.nodes[wall.a], scene.nodes[wall.b]].map((n) => ({ x: n.x, y: n.y }));
  assert.deepEqual(after, before, '端点が動いた');
  assert.ok(Math.abs(wallArc(scene, wall)!.sweep) < Math.PI, '劣弧が優弧に化けた');

  // 優弧は優弧のまま（膨らみ 2 は掃過角 4·atan(2) ≒ 4.43 rad > π）
  const big = arcScene(2);
  const bigWall = big.scene.walls[big.id];
  assert.ok(Math.abs(wallArc(big.scene, bigWall)!.sweep) > Math.PI, '前提が優弧でない');
  setWallRadius(big.scene, bigWall, 4000);
  assert.ok(Math.abs(wallArc(big.scene, bigWall)!.sweep) > Math.PI, '優弧が劣弧に化けた');
});

test('半径は弦の半分より小さくできない', () => {
  const { scene, id } = arcScene();
  const wall = scene.walls[id];
  const chord = dist(scene.nodes[wall.a], scene.nodes[wall.b]);
  setWallRadius(scene, wall, 1);
  assert.ok(
    Math.abs(wallArc(scene, wall)!.radius - chord / 2) < 1e-6,
    `半径 ${wallArc(scene, wall)!.radius}（弦の半分 ${chord / 2}）`,
  );
});

// --- 壁ツール ---

/** ツールが触るところだけの、作りものの Editor */
function fakeEditor(scene: Scene): Editor {
  return {
    store: {
      scene,
      settings: defaultSettings(),
      commit: (fn: () => void | boolean) => void fn(),
      clearSelection: () => {},
    },
    viewport: { toWorldLength: () => 6 },
    snapContext: {},
    snapAt: (p: Vec) => ({ kind: 'free', point: p }),
    pointerWorld: () => vec(0, 0),
    requestRender: () => {},
  } as unknown as Editor;
}

const click = (tool: WallTool, editor: Editor, world: Vec): void =>
  tool.onPointerDown(editor, { button: 0, world, raw: world } as unknown as PointerInfo);

test('壁ツールは「種類」で直線と円弧を切り替える', () => {
  const tool = new WallTool();
  const field = (tool.options?.(fakeEditor(emptyScene())) ?? []).find(
    (f): f is Extract<typeof f, { kind: 'select' }> => f.kind === 'select' && f.label === '種類',
  );
  assert.ok(field, '「種類」が出ていない');
  assert.deepEqual(field.options.map((o) => o.value), ['line', 'arc']);
  assert.equal(field.value, 'line', '既定が直線でない');
});

test('直線は 2 クリック、円弧は 3 クリックで置く', () => {
  const scene = emptyScene();
  const editor = fakeEditor(scene);
  const tool = new WallTool();

  click(tool, editor, vec(0, 0));
  click(tool, editor, vec(4000, 0));
  assert.equal(Object.keys(scene.walls).length, 1, '直線が 2 クリックで置けない');
  assert.equal(Object.values(scene.walls)[0].bulge, 0);
  tool.cancel(editor);

  tool.kind = 'arc';
  click(tool, editor, vec(0, 4000));
  click(tool, editor, vec(4000, 4000));
  assert.equal(Object.keys(scene.walls).length, 1, '2 クリック目で置いてしまっている');
  // 通る点。弦から 1000 上
  click(tool, editor, vec(2000, 5000));
  assert.equal(Object.keys(scene.walls).length, 2, '3 クリック目で置けていない');

  const arcWall = Object.values(scene.walls).find((w) => w.bulge !== 0)!;
  assert.ok(arcWall, '円弧になっていない');
  const arc = wallArc(scene, arcWall)!;
  // 3 点（0,4000）（2000,5000）（4000,4000）を通る円の半径は 2500
  assert.ok(Math.abs(arc.radius - 2500) < 1e-6, `半径 ${arc.radius}（期待 2500）`);
  // 通る点がちゃんと弧の上に乗る
  const via = vec(2000, 5000);
  assert.ok(Math.abs(dist(via, arc.center) - arc.radius) < 1e-6, '通る点が弧から外れている');
});

test('通る点が弦の上なら直線になる', () => {
  const scene = emptyScene();
  const editor = fakeEditor(scene);
  const tool = new WallTool();
  tool.kind = 'arc';
  click(tool, editor, vec(0, 0));
  click(tool, editor, vec(4000, 0));
  click(tool, editor, vec(2000, 0));
  assert.equal(Object.keys(scene.walls).length, 1);
  assert.equal(Object.values(scene.walls)[0].bulge, 0, '弦の上を指したのに曲がった');
});
