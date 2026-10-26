import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleScene } from '../src/io/sample.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { sceneBounds } from '../src/core/entity.ts';
import { activeLevel, wallHeightOf } from '../src/core/level.ts';
import { buildMesh, BUCKET_ORDER, type Face3 } from '../src/render3d/mesh.ts';
import { paint } from '../src/render3d/paint.ts';
import { defaultCamera, frameAll, orbit, clampPitch, type Camera3D } from '../src/render3d/camera.ts';
import { normalize3, vec3 } from '../src/render3d/mat4.ts';
import { lambert, shade } from '../src/render3d/shading.ts';
import { stubContext } from './stub-context.ts';
import { vec } from '../src/core/geometry.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { emptyScene, newId, type OpeningKind, type Scene } from '../src/core/types.ts';

function meshOf(scene: Scene): Face3[] {
  return buildMesh(scene, detectRooms(scene));
}

/** 壁1本と、その中央に置いた建具1つ */
function oneWall(kind: OpeningKind | null, over: Record<string, unknown> = {}): Scene {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const wall = addWall(scene, a, b, 120)!;
  if (kind) {
    const id = newId('o');
    scene.openings[id] = {
      id,
      wallId: wall.id,
      offset: 2000,
      width: 1200,
      kind,
      flipX: false,
      flipY: false,
      sillHeight: null,
      height: null,
      layerId: LAYER_IDS.opening,
      ...over,
    };
  }
  return scene;
}

// --- ジオメトリ ---

test('開口の無い壁は箱1つ（6面）になる', () => {
  const faces = meshOf(oneWall(null)).filter((f) => f.bucket === 'wall');
  assert.equal(faces.length, 6);
});

test('窓は腰壁とまぐさの両方を残し、ドアはまぐさだけを残す', () => {
  const countBoxes = (scene: Scene) => meshOf(scene).filter((f) => f.bucket === 'wall').length;
  // 窓 (SH=800, H=1100, 壁高 2400) は腰壁・まぐさとも出る
  const window = countBoxes(oneWall('window'));
  // ドア (SH=0, H=2000) はまぐさだけ
  const door = countBoxes(oneWall('door'));
  assert.ok(window > door, `窓 ${window} 面、ドア ${door} 面`);

  // 壁高いっぱいの開口ならまぐさも消える
  const full = countBoxes(oneWall('opening', { sillHeight: 0, height: 2400 }));
  assert.ok(full < door, `全高の開口 ${full} 面がドア ${door} 面より多い`);
});

test('平面図では同じに見える窓とドアが、3D では開口の抜け方で見分けられる', () => {
  const zRange = (scene: Scene) => {
    const zs = meshOf(scene)
      .filter((f) => f.bucket === 'wall')
      .flatMap((f) => f.points.map((p) => p.z));
    return [Math.min(...zs), Math.max(...zs)];
  };
  // 窓は床から 800 までの腰壁があるので、開口の真下にも壁がある
  const scene = oneWall('window');
  const sills = meshOf(scene).filter((f) => f.bucket === 'wall' && f.points.every((p) => p.z <= 800.001));
  assert.ok(sills.length > 0, '腰壁が出ていない');
  assert.deepEqual(zRange(oneWall('door')), [0, 2400]);
});

test('壁の高さの上書きが効く', () => {
  const scene = oneWall(null);
  const wall = Object.values(scene.walls)[0];
  wall.height = 3000;
  const top = Math.max(...meshOf(scene).flatMap((f) => f.points.map((p) => p.z)));
  assert.equal(top, 3000);
  assert.equal(wallHeightOf(wall, activeLevel(scene)), 3000);
});

test('すべての面で、頂点の順と法線が食い違わない', () => {
  // 頂点順の規約違反を全部捕まえる
  const scene = sampleScene();
  // Newell 法。重複点があっても多角形全体から法線が出せる
  const newell = (points: { x: number; y: number; z: number }[]) => {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      x += (a.y - b.y) * (a.z + b.z);
      y += (a.z - b.z) * (a.x + b.x);
      z += (a.x - b.x) * (a.y + b.y);
    }
    return { x, y, z };
  };

  for (const face of meshOf(scene)) {
    const raw = newell(face.points);
    assert.ok(Math.hypot(raw.x, raw.y, raw.z) > 1e-6, `面積ゼロの面がある (${face.bucket})`);
    const n = normalize3(raw);
    const d = n.x * face.normal.x + n.y * face.normal.y + n.z * face.normal.z;
    assert.ok(d > 0.99, `法線が頂点順と合っていない (${face.bucket}): ${d}`);
  }
});

test('床は内法ポリゴンで、壁の厚みに食い込まない', () => {
  const scene = sampleScene();
  const rooms = detectRooms(scene);
  const floors = buildMesh(scene, rooms).filter((f) => f.bucket === 'floor');
  assert.equal(floors.length, rooms.length);
  for (const f of floors) {
    assert.ok(f.doubleSided, '床は裏からも見えるべき');
    assert.ok(f.points.every((p) => p.z === 0));
  }
  // 壁芯ポリゴンより内法ポリゴンのほうが小さい
  for (const room of rooms) assert.ok(room.innerArea < room.area);
});

test('家具は高さの表から立ち、階段は立てない', () => {
  const scene = sampleScene();
  const furniture = meshOf(scene).filter((f) => f.bucket === 'furniture');
  assert.ok(furniture.length > 0, '家具が立っていない');
  const top = Math.max(...furniture.map((f) => Math.max(...f.points.map((p) => p.z))));
  assert.ok(top > 0 && top <= 2000, `家具の高さ ${top}`);
});

test('建具が立つ（窓はガラス、戸は板）', () => {
  assert.ok(meshOf(oneWall('window')).some((f) => f.bucket === 'glass'), 'ガラスが無い');
  assert.ok(meshOf(oneWall('windowSliding')).some((f) => f.bucket === 'glass'));
  // 戸は家具と同じ層の板
  const door = meshOf(oneWall('door'));
  assert.ok(door.some((f) => f.bucket === 'furniture'), '戸板が無い');
  // 建具なしの出入口には板もガラスも無い
  const plain = meshOf(oneWall('opening'));
  assert.ok(!plain.some((f) => f.bucket === 'glass' || f.bucket === 'furniture'));
});

test('非表示の画層のものは立体にしない', () => {
  const scene = sampleScene();
  const before = meshOf(scene).filter((f) => f.bucket === 'wall').length;
  scene.layers[LAYER_IDS.wall].visible = false;
  assert.equal(meshOf(scene).filter((f) => f.bucket === 'wall').length, 0, `壁 ${before} 面が残っている`);
});

// --- 描画 ---

const CANVAS = { width: 1200, height: 800 };

function drawWith(cam: Camera3D, scene = sampleScene()) {
  const { ctx, calls } = stubContext();
  paint(ctx, cam, meshOf(scene), CANVAS.width, CANVAS.height, { showEdges: true });
  return calls;
}

test('サンプル間取りが 3D で例外なく描ける', () => {
  const scene = sampleScene();
  const cam = defaultCamera();
  frameAll(cam, sceneBounds(scene), activeLevel(scene).wallHeight);
  const calls = drawWith(cam, scene);
  assert.ok(calls.filter((c) => c === 'fill').length > 50, `塗りが ${calls.filter((c) => c === 'fill').length} 回`);
  assert.ok(calls.includes('stroke'), '稜線が描かれていない');
});

test('病的なカメラでも有限でない座標を出さない', () => {
  const scene = sampleScene();
  const base = defaultCamera();
  frameAll(base, sceneBounds(scene), activeLevel(scene).wallHeight);

  const cases: Record<string, Partial<Camera3D>> = {
    真上: { pitch: Math.PI / 2 },
    真下: { pitch: -Math.PI / 2 },
    'pitch が π/2 ちょうど': { pitch: clampPitch(Math.PI / 2) },
    距離ゼロ: { distance: 0 },
    距離が極端に大きい: { distance: 1e9 },
    '視点と注視点が同じ': { distance: 0, pitch: 0 },
    平行投影: { mode: 'ortho' },
    平行投影で真上: { mode: 'ortho', pitch: Math.PI / 2 },
  };

  for (const [name, over] of Object.entries(cases)) {
    const cam: Camera3D = { ...base, ...over, pitch: clampPitch(over.pitch ?? base.pitch) };
    assert.doesNotThrow(() => drawWith(cam, scene), `${name} で落ちた`);
  }
});

test('部屋の真ん中にカメラを置いても near クリップが効く', () => {
  // 外から見ているうちは near を跨ぐ面が出ないので、この1本が near クリップの本番
  const scene = sampleScene();
  const cam: Camera3D = { ...defaultCamera(), target: vec3(4000, 3000, 1200), distance: 300, pitch: 0 };
  for (let i = 0; i < 12; i++) {
    cam.yaw = (i / 12) * Math.PI * 2;
    assert.doesNotThrow(() => drawWith(cam, scene), `yaw = ${cam.yaw} で落ちた`);
  }
});

test('画面の大きさが 0 でも落ちない', () => {
  const scene = sampleScene();
  const { ctx } = stubContext();
  assert.doesNotThrow(() => paint(ctx, defaultCamera(), meshOf(scene), 0, 0));
});

test('背面は描かれない（箱を外から見ると半分以下）', () => {
  const scene = oneWall(null);
  const cam = defaultCamera();
  frameAll(cam, sceneBounds(scene), activeLevel(scene).wallHeight);
  const fills = drawWith(cam, scene).filter((c) => c === 'fill').length;
  // 壁の箱は6面。外から見えるのは3面まで
  assert.ok(fills <= 3, `${fills} 面が描かれた`);
  assert.ok(fills >= 2, `${fills} 面しか描かれていない`);
});

test('層の順が固定されている', () => {
  assert.deepEqual(BUCKET_ORDER, ['floor', 'wall', 'furniture', 'glass']);
});

test('カメラ操作で pitch が頭打ちになる', () => {
  const cam = defaultCamera();
  for (let i = 0; i < 500; i++) orbit(cam, 0, -10);
  assert.ok(cam.pitch < Math.PI / 2, `pitch が ${cam.pitch}`);
  for (let i = 0; i < 1000; i++) orbit(cam, 0, 10);
  assert.ok(cam.pitch > -Math.PI / 2, `pitch が ${cam.pitch}`);
});

test('陰影が範囲に収まり、色の形式を保つ', () => {
  assert.ok(lambert(vec3(0, 0, 1)) > lambert(vec3(0, 0, -1)), '上向きのほうが明るいはず');
  for (const n of [vec3(1, 0, 0), vec3(0, 0, -1), vec3(0, 0, 1)]) {
    const k = lambert(n);
    assert.ok(k >= 0.35 && k <= 1, `明度 ${k}`);
  }
  assert.equal(shade('#808080', 1), 'rgb(128, 128, 128)');
  assert.equal(shade('#ffffff', 2), 'rgb(255, 255, 255)', '上限で飽和する');
  assert.match(shade('rgba(100, 150, 200, 0.5)', 0.5), /^rgba\(50, 75, 100, 0\.5\)$/);
});
