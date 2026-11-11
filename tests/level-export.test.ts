import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, type Id, type Scene } from '../src/core/types.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { vec } from '../src/core/geometry.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { addLevel } from '../src/core/levelOps.ts';
import { detectRooms, nestingOf } from '../src/core/rooms.ts';
import { defaultSettings } from '../src/core/store.ts';
import { sceneToSvg } from '../src/io/svg.ts';
import { exportLossReport, sceneToDxf } from '../src/io/dxf.ts';
import { sceneToMeasures } from '../src/io/measures.ts';
import { makeFixture } from './make.ts';

/**
 * 書き出しと数量を階ごとに。
 *
 * **平面図は 1 枚の紙なので、出すのは作業中の階だけ。** 全部の階を重ねたものは
 * 平面図ではない。出していない階があることは報告に書く——2 階建ての図面を
 * 書き出して、1 階しか入っていないことに後で気づくのがいちばん困る。
 *
 * **数量は逆で、全部の階を出す。** 積算は建物ぜんぶの話。ただし部屋が
 * どの階かを名乗らないと、1 階と 2 階の「洋室」が区別できない。
 */

/** 1 階に 4m 角の部屋、2 階に同じ形の部屋。**平面では完全に重なる** */
function twoFloorRooms(): { scene: Scene; upper: Id } {
  const scene = emptyScene();
  const square = (levelId: Id) => {
    scene.activeLevelId = levelId;
    const c = [vec(0, 0), vec(4000, 0), vec(4000, 4000), vec(0, 4000)].map((p) =>
      findOrCreateNode(scene, p),
    );
    for (let i = 0; i < 4; i++) addWall(scene, c[i], c[(i + 1) % 4], 120);
  };
  square(DEFAULT_LEVEL_ID);
  const upper = addLevel(scene, 'above').id;
  square(upper);
  scene.activeLevelId = DEFAULT_LEVEL_ID;
  return { scene, upper };
}

const settings = () => defaultSettings();
const dxfOf = (scene: Scene) =>
  sceneToDxf(scene, detectRooms(scene), settings(), { escapeUnicode: false, trueDimension: true });

test('部屋は階ごとに分かれる（前提）', () => {
  const { scene, upper } = twoFloorRooms();
  const rooms = detectRooms(scene);
  assert.equal(rooms.length, 2, `検出された部屋 ${rooms.length} 室`);
  assert.deepEqual(rooms.map((r) => r.levelId).sort(), [DEFAULT_LEVEL_ID, upper].sort());
});

test('SVG も DXF も作業中の階だけを出す', () => {
  const { scene, upper } = twoFloorRooms();
  // **数を数える。** 1 階と 2 階は同じ座標なので、比べ合うだけでは
  // 「両方出ている」ときも一致してしまう。絶対の数で押さえる
  const roomLabels = (s: string) => (s.match(/m²/g) ?? []).length;
  const dxfLines = (s: string) => (s.match(/\r\nLINE\r\n/g) ?? []).length;

  scene.activeLevelId = DEFAULT_LEVEL_ID;
  const first = sceneToSvg(scene, detectRooms(scene), settings());
  assert.equal(roomLabels(first), 1, `1 階の SVG に ${roomLabels(first)} 室出ている`);
  // 4 面の壁の輪郭 = 8 本
  assert.equal(dxfLines(dxfOf(scene)), 8, '1 階の DXF に 2 階の壁まで入っている');

  scene.activeLevelId = upper;
  const second = sceneToSvg(scene, detectRooms(scene), settings());
  assert.equal(roomLabels(second), 1, '2 階の SVG に 1 階の部屋まで出ている');
  assert.equal(dxfLines(dxfOf(scene)), 8, '2 階の DXF に 1 階の壁まで入っている');
});

test('出していない階があることを書き出しの報告に出す', () => {
  // **持っていないものは、持っていないと書く**
  const scene = emptyScene();
  assert.ok(
    exportLossReport(scene).every((l) => !l.includes('階は')),
    '1 階しか無いのに階の断りが出ている',
  );

  addLevel(scene, 'above');
  const notes = exportLossReport(scene);
  const line = notes.find((l) => l.includes('階は'));
  assert.ok(line, `階の断りが出ていない: ${notes.join(' / ')}`);
  assert.match(line!, /2 階ありますが/);
  assert.match(line!, /「1階」だけです/);
});

test('数量は全部の階を出し、部屋がどの階かを名乗る', () => {
  const { scene, upper } = twoFloorRooms();
  const file = sceneToMeasures(scene, detectRooms(scene), { planId: 'p-1' });
  assert.equal(file.rooms.length, 2, '数量が作業中の階だけになっている');
  assert.deepEqual(
    file.rooms.map((r) => r.level.id).sort(),
    [DEFAULT_LEVEL_ID, upper].sort(),
  );
  const second = file.rooms.find((r) => r.level.id === upper)!;
  assert.equal(second.level.name, '2階');
  assert.equal(second.level.floor_z, 2400, '床の高さが出ていない');
});

test('2 階の吹抜が 1 階の床から引かれない', () => {
  // 平面では真上に重なるので、階を見ないと 1 階の床が黙って足りなくなる
  const { scene, upper } = twoFloorRooms();
  const area = (levelId: Id) =>
    detectRooms(scene).find((r) => r.levelId === levelId)!.floorArea;
  const before = area(DEFAULT_LEVEL_ID);

  scene.fixtures['f-void'] = makeFixture('void', {
    id: 'f-void', x: 2000, y: 2000, size: { w: 2000, h: 2000 }, levelId: upper,
  });

  assert.equal(area(DEFAULT_LEVEL_ID), before, '2 階の吹抜が 1 階の床を削っている');
  assert.ok(area(upper) < before - 3.9, `2 階の床から吹抜が引かれていない: ${area(upper)}`);
});

test('2 階の家具が 1 階の部屋に数えられない', () => {
  const { scene, upper } = twoFloorRooms();
  scene.blocks['b-1'] = {
    id: 'b-1', name: 'いす', code: 'CH', category: 'furniture', shapes: {},
  } as never;
  scene.instances['i-1'] = {
    id: 'i-1', blockId: 'b-1', x: 2000, y: 2000, angle: 0, scaleX: 1, scaleY: 1,
    layerId: 'A-FURN', levelId: upper, attrs: { takeoff: null, materialRef: null, color: null },
  } as never;

  const file = sceneToMeasures(scene, detectRooms(scene), { planId: 'p-1' });
  const first = file.rooms.find((r) => r.level.id === DEFAULT_LEVEL_ID)!;
  const second = file.rooms.find((r) => r.level.id === upper)!;
  assert.deepEqual(first.furniture, [], '2 階のいすが 1 階に数えられている');
  assert.equal(second.furniture.length, 1, '2 階のいすが 2 階に数えられていない');
});

test('入れ子は階を跨がない', () => {
  // **1 階に大きな部屋、2 階にその中に収まる小さな部屋。**
  // 階を見ないと「2 階の部屋は 1 階の部屋の中」と判定され、1 階の床が削られる
  const scene = emptyScene();
  const upper = addLevel(scene, 'above').id;

  const square = (levelId: Id, size: number, at: number) => {
    scene.activeLevelId = levelId;
    const c = [
      vec(at, at), vec(at + size, at), vec(at + size, at + size), vec(at, at + size),
    ].map((p) => findOrCreateNode(scene, p));
    for (let i = 0; i < 4; i++) addWall(scene, c[i], c[(i + 1) % 4], 120);
  };
  square(DEFAULT_LEVEL_ID, 8000, 0);
  square(upper, 2000, 3000);

  const rooms = detectRooms(scene);
  assert.equal(rooms.length, 2);
  assert.equal(nestingOf(rooms).size, 0, '階を跨いで入れ子にしている');
});
