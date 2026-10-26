import { defaultAttrs } from '../src/core/attrs.ts';
import { makeOpening } from './make.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene } from '../src/core/types.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { vec } from '../src/core/geometry.ts';
import { newId } from '../src/core/id.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { elevationOf, sceneToElevations, elevationToSvg, DISCLAIMER } from '../src/io/elevation.ts';

type Scene = ReturnType<typeof emptyScene>;

function wallWith(openings: [number, number, 'door' | 'window'][]): Scene {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const w = addWall(scene, a, b, 100)!;
  for (const [offset, width, kind] of openings) {
    const id = newId('o');
    scene.openings[id] = makeOpening(w.id, { id, offset, width, kind });
  }
  return scene;
}

const first = (scene: Scene) => elevationOf(scene, Object.values(scene.walls)[0])!;

test('壁の長さと高さを持つ', () => {
  const e = first(wallWith([]));
  assert.equal(e.length, 4000);
  assert.equal(e.height, 2400);   // 階の既定
});

test('開口の無い壁は床から天井までひと続き', () => {
  const e = first(wallWith([]));
  assert.deepEqual(e.solid, [{ lo: 0, hi: 4000 }]);
  assert.deepEqual(e.openings, []);
});

test('開口の位置と上下端を出す', () => {
  const e = first(wallWith([[2000, 1700, 'window']]));
  assert.equal(e.openings.length, 1);
  const o = e.openings[0];
  // 窓は窓台 800、高さ 1100 が既定 → 上端 1900
  assert.equal(o.sill, 800);
  assert.equal(o.head, 1900);
  assert.equal(o.hi - o.lo, 1700);
});

test('床まで届く建具は窓台が0', () => {
  const o = first(wallWith([[2000, 800, 'door']])).openings[0];
  assert.equal(o.sill, 0);
  assert.equal(o.head, 2000);
});

test('壁の実体は開口に食われた分だけ切れる', () => {
  const e = first(wallWith([[2000, 800, 'door']]));
  const total = e.solid.reduce((s, x) => s + (x.hi - x.lo), 0);
  assert.equal(total, 4000 - 800);
});

test('建具の種別の名前を運ぶ', () => {
  assert.equal(first(wallWith([[2000, 1700, 'window']])).openings[0].label, '窓');
  assert.equal(first(wallWith([[2000, 800, 'door']])).openings[0].label, '片開き戸');
});

test('開口のある壁だけを立面にする', () => {
  const scene = emptyScene();
  const ids = [vec(0, 0), vec(4000, 0), vec(4000, 3000), vec(0, 3000)]
    .map((p) => findOrCreateNode(scene, p));
  const walls = [];
  for (let i = 0; i < 4; i++) walls.push(addWall(scene, ids[i], ids[(i + 1) % 4], 100)!);
  const id = newId('o');
  scene.openings[id] = { id, wallId: walls[0].id, offset: 2000, width: 800,
    kind: 'door', flipX: false, flipY: false, sillHeight: null, height: null,
    layerId: LAYER_IDS.opening, attrs: defaultAttrs() };
  const got = sceneToElevations(scene);
  assert.equal(got.length, 1);
  assert.equal(got[0].wallId, walls[0].id);
});

// --- SVG ------------------------------------------------------------------

test('腰壁とまぐさを描く', () => {
  const svg = elevationToSvg([first(wallWith([[2000, 1700, 'window']]))]);
  // 壁の矩形が、実体の区間 2 つ ＋ 腰壁 ＋ まぐさ の 4 つ
  assert.equal((svg.match(/class="wall"/g) || []).length, 4);
  assert.equal((svg.match(/class="opening"/g) || []).length, 1);
});

test('床まで届く建具には腰壁を描かない', () => {
  const svg = elevationToSvg([first(wallWith([[2000, 800, 'door']]))]);
  // 実体 2 つ ＋ まぐさ のみ
  assert.equal((svg.match(/class="wall"/g) || []).length, 3);
});

test('高さ方向の寸法を入れる', () => {
  // 平面図の寸法はすべて水平方向。立面で初めて縦が入る
  const svg = elevationToSvg([first(wallWith([[2000, 1700, 'window']]))]);
  assert.ok(svg.includes('class="dim"'));
  assert.ok(svg.includes('>1100<'), '開口の高さが出ていない');
  assert.ok(svg.includes('>2400<'), '階高が出ていない');
});

test('寸法を切れる', () => {
  const svg = elevationToSvg([first(wallWith([[2000, 1700, 'window']]))],
    { scale: 50, dimensions: false });
  assert.ok(!svg.includes('class="dim"'));
});

test('持っていないものは但し書きにする', () => {
  // 建具の割付も開き勝手も寸法として持っていない。描かずにそう書く
  const svg = elevationToSvg([first(wallWith([[2000, 1700, 'window']]))]);
  assert.ok(svg.includes(DISCLAIMER));
});

test('建具の名前を html として埋め込まない', () => {
  const scene = wallWith([[2000, 1700, 'window']]);
  const e = first(scene);
  e.openings[0].label = '<script>x</script>';
  const svg = elevationToSvg([e]);
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;script&gt;'));
});

test('実寸と尺度から紙の大きさを出す', () => {
  const svg = elevationToSvg([first(wallWith([]))], { scale: 50, dimensions: false });
  // 幅 4000 + 余白 1200 = 5200mm → 1:50 で 104mm
  assert.ok(svg.includes('width="104mm"'), svg.slice(0, 200));
});
