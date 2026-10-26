import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleScene } from '../src/io/sample.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { buildMesh, type Face3 } from '../src/render3d/mesh.ts';
import { MeshCache } from '../src/render3d/meshCache.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import type { Scene } from '../src/core/types.ts';

function cached(cache: MeshCache, scene: Scene): Face3[] {
  return cache.faces(scene, detectRooms(scene));
}

function plain(scene: Scene): Face3[] {
  return buildMesh(scene, detectRooms(scene));
}

/** 面を比べるための、位置と色と出どころだけの表現 */
const shapeOf = (f: Face3): string =>
  [
    f.points.map((p) => `${p.x.toFixed(4)}/${p.y.toFixed(4)}/${p.z.toFixed(4)}`).join(' '),
    f.normal.x.toFixed(6), f.normal.y.toFixed(6), f.normal.z.toFixed(6),
    f.color, f.bucket, f.doubleSided ? 1 : 0,
    f.ref ? `${f.ref.type}:${f.ref.id}` : '-',
    f.levelId,
  ].join('|');

const sameMesh = (a: Face3[], b: Face3[]): boolean =>
  a.length === b.length && a.every((f, i) => shapeOf(f) === shapeOf(b[i]));

test('キャッシュを通した結果は buildMesh と一致する', () => {
  // **オラクル。** 自前の思い込みで通らないように、素の組み立てと突き合わせる
  const scene = sampleScene();
  const cache = new MeshCache();
  assert.ok(sameMesh(cached(cache, scene), plain(scene)), '初回が一致しない');
  assert.ok(sameMesh(cached(cache, scene), plain(scene)), '2 回目が一致しない');
});

test('編集を重ねてもキャッシュと buildMesh が一致し続ける', () => {
  // 実際の操作に近い順番で揺さぶる。どれか 1 つでも指紋から漏れていれば、
  // 古い面が残って一致しなくなる
  const scene = sampleScene();
  const cache = new MeshCache();
  const wallIds = Object.keys(scene.walls);
  const instIds = Object.keys(scene.instances);
  const openingIds = Object.keys(scene.openings);

  const steps: [string, () => void][] = [
    ['壁を動かす', () => void (scene.nodes[scene.walls[wallIds[0]].a].x += 250)],
    ['壁厚を変える', () => void (scene.walls[wallIds[1]].thickness = 200)],
    ['壁の高さを変える', () => void (scene.walls[wallIds[1]].height = 3000)],
    ['壁の高さを既定に戻す', () => void (scene.walls[wallIds[1]].height = null)],
    ['家具を動かす', () => void (scene.instances[instIds[0]].x += 300)],
    ['家具を回す', () => void (scene.instances[instIds[0]].angle += 0.4)],
    ['家具の大きさを変える', () => void (scene.instances[instIds[1]].scaleX *= 1.3)],
    ['建具を動かす', () => void (scene.openings[openingIds[0]].offset += 150)],
    ['建具の幅を変える', () => void (scene.openings[openingIds[0]].width = 1200)],
    ['建具の開き勝手を反転', () => void (scene.openings[openingIds[0]].flipX = true)],
    ['窓台の高さを変える', () => void (scene.openings[openingIds[1]].sillHeight = 400)],
    ['階高を変える', () => void (scene.levels[scene.activeLevelId].wallHeight = 2700)],
    ['床の高さを変える', () => void (scene.levels[scene.activeLevelId].floorZ = 500)],
    ['画層を隠す', () => void (scene.layers[LAYER_IDS.furniture].visible = false)],
    ['画層を戻す', () => void (scene.layers[LAYER_IDS.furniture].visible = true)],
    ['建具を消す', () => void delete scene.openings[openingIds[0]]],
    ['家具を消す', () => void delete scene.instances[instIds[0]]],
    ['壁を消す', () => void delete scene.walls[wallIds[2]]],
  ];

  for (const [name, apply] of steps) {
    apply();
    assert.ok(sameMesh(cached(cache, scene), plain(scene)), `${name} のあとで一致しない`);
  }
});

test('同じシーンを 2 回渡しても何も作り直さない', () => {
  const scene = sampleScene();
  const cache = new MeshCache();
  cached(cache, scene);
  cached(cache, scene);
  assert.deepEqual(cache.stats, { walls: 0, fixtures: 0, instances: 0, floors: 0 });
});

test('家具を 1 つ動かしても壁は作り直さない', () => {
  // **ドラッグの本命。** 家具を引きずっている間、壁を組み直す理由はない
  const scene = sampleScene();
  const cache = new MeshCache();
  cached(cache, scene);

  scene.instances[Object.keys(scene.instances)[0]].x += 100;
  cached(cache, scene);
  assert.equal(cache.stats.walls, 0, '壁を作り直している');
  assert.equal(cache.stats.instances, 1, '作り直した家具の数が違う');
  assert.equal(cache.stats.floors, 0, '床を作り直している');
});

test('壁厚を変えるとその壁だけ作り直す', () => {
  const scene = sampleScene();
  const cache = new MeshCache();
  cached(cache, scene);

  scene.walls[Object.keys(scene.walls)[0]].thickness = 150;
  cached(cache, scene);
  assert.equal(cache.stats.walls, 1, `作り直した壁が ${cache.stats.walls} 本`);
  assert.equal(cache.stats.instances, 0);
  // 壁厚は内法ポリゴンを変えるので、床は作り直されるのが正しい
  assert.equal(cache.stats.floors, 1, '床が追従していない');
});

test('建具を動かすとその建具の載る壁も作り直す', () => {
  // 開口の面は壁の押し出しの中で出るので、壁ごと作り直さないと古い穴が残る
  const scene = sampleScene();
  const cache = new MeshCache();
  cached(cache, scene);

  scene.openings[Object.keys(scene.openings)[0]].offset += 200;
  cached(cache, scene);
  assert.equal(cache.stats.walls, 1, `作り直した壁が ${cache.stats.walls} 本`);
});

test('壁を 1 本動かしても他の壁は作り直さない', () => {
  const scene = sampleScene();
  const cache = new MeshCache();
  cached(cache, scene);

  const wall = scene.walls[Object.keys(scene.walls)[0]];
  scene.nodes[wall.a].x += 50;
  cached(cache, scene);
  // 動かしたノードを共有する壁だけが作り直される（角は 2 本で共有している）
  assert.ok(cache.stats.walls <= 2, `${cache.stats.walls} 本も作り直している`);
});

test('消えた実体のぶんを抱え込まない', () => {
  const scene = sampleScene();
  const cache = new MeshCache();
  cached(cache, scene);

  for (const id of Object.keys(scene.instances)) delete scene.instances[id];
  const faces = cached(cache, scene);
  assert.equal(faces.filter((f) => f.ref?.type === 'blockInstance').length, 0,
    '消した家具の面が残っている');
  assert.ok(sameMesh(faces, plain(scene)));
});

test('シーンを丸ごと差し替えても正しい（undo の形）', () => {
  // **フラグ方式ならここで腐る。** 指紋は内容から出るので、
  // 別のシーンに差し替わっても古い面が残らない
  const cache = new MeshCache();
  const before = sampleScene();
  cached(cache, before);

  const after = sampleScene();
  after.walls[Object.keys(after.walls)[0]].thickness = 400;
  assert.ok(sameMesh(cached(cache, after), plain(after)), '差し替え後が一致しない');

  // 戻す（undo に相当）
  assert.ok(sameMesh(cached(cache, before), plain(before)), 'undo 相当のあとで一致しない');
});
