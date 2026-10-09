import { test } from 'node:test';
import assert from 'node:assert/strict';
import DxfParser from 'dxf-parser';
import { sampleScene } from '../src/io/sample.ts';
import {
  ACI_COLORS,
  addLayer,
  defaultLayers,
  isBuiltinLayer,
  LAYER_IDS,
  renameLayer,
  resolveNewLayer,
  setLayerColor,
  uniqueLayerName,
} from '../src/core/layer.ts';
import { layerOfRef, removeLayer, setLayerOf } from '../src/core/entity.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { sceneToDxf } from '../src/io/dxf.ts';
import { defaultSettings } from '../src/core/store.ts';
import { DEFAULT_LAYER_FOR } from '../src/core/types.ts';

test('画層を追加しても名前が重複しない', () => {
  const layers = defaultLayers();
  const a = addLayer(layers);
  const b = addLayer(layers);
  const c = addLayer(layers);
  assert.equal(new Set([a.name, b.name, c.name]).size, 3, `重複: ${[a.name, b.name, c.name]}`);
  assert.equal(a.name, 'A-USER');
  assert.equal(b.name, 'A-USER-2');
});

test('既存と衝突する名前は連番が付く', () => {
  const layers = defaultLayers();
  assert.equal(uniqueLayerName(layers, 'A-WALL'), 'A-WALL-2');
  assert.equal(uniqueLayerName(layers, 'A-NEW'), 'A-NEW');
});

test('改名は空名と重複を受け付けない', () => {
  const layers = defaultLayers();
  assert.equal(renameLayer(layers, LAYER_IDS.wall, '  '), false);
  assert.equal(renameLayer(layers, LAYER_IDS.wall, 'A-DOOR-WIND'), false, '他の画層と同じ名前を許している');
  assert.equal(layers[LAYER_IDS.wall].name, 'A-WALL', '弾いたのに書き換わっている');
  assert.equal(renameLayer(layers, LAYER_IDS.wall, '壁'), true);
  assert.equal(layers[LAYER_IDS.wall].name, '壁');
});

test('色を変えると ACI と表示色が揃って変わる', () => {
  const layers = defaultLayers();
  assert.equal(setLayerColor(layers, LAYER_IDS.wall, 1), true);
  assert.equal(layers[LAYER_IDS.wall].aci, 1);
  assert.equal(layers[LAYER_IDS.wall].color, ACI_COLORS.find((c) => c.aci === 1)!.hex);
  assert.equal(setLayerColor(layers, LAYER_IDS.wall, 999), false, '知らない色番号を受け付けている');
});

test('組み込みの画層は消せない', () => {
  const scene = sampleScene();
  for (const id of Object.values(LAYER_IDS)) {
    assert.equal(isBuiltinLayer(id), true, `${id} が組み込み扱いになっていない`);
    assert.equal(removeLayer(scene, id), false, `${id} が消せてしまう`);
  }
  assert.equal(Object.keys(scene.layers).length, Object.keys(defaultLayers()).length);
});

test('画層を消すと中身が既定の画層へ移る', () => {
  const scene = sampleScene();
  const extra = addLayer(scene.layers, { name: 'A-TEMP' });
  const wall = Object.values(scene.walls)[0];
  const furniture = Object.values(scene.furniture)[0];
  setLayerOf(scene, [
    { type: 'wall', id: wall.id },
    { type: 'furniture', id: furniture.id },
  ], extra.id);
  assert.equal(wall.layerId, extra.id);

  assert.equal(removeLayer(scene, extra.id), true);
  assert.equal(scene.layers[extra.id], undefined);
  assert.equal(wall.layerId, DEFAULT_LAYER_FOR.wall, '壁が既定の画層に戻っていない');
  assert.equal(furniture.layerId, DEFAULT_LAYER_FOR.furniture, '家具が既定の画層に戻っていない');
});

test('選択の画層をまとめて変えられる', () => {
  const scene = sampleScene();
  const extra = addLayer(scene.layers, { name: 'A-TEMP' });
  const refs = Object.keys(scene.walls)
    .slice(0, 3)
    .map((id) => ({ type: 'wall' as const, id }));

  assert.equal(setLayerOf(scene, refs, extra.id), true);
  for (const ref of refs) assert.equal(layerOfRef(scene, ref)?.id, extra.id);
  assert.equal(setLayerOf(scene, refs, 'does-not-exist'), false);
});

test('現在の画層は未指定なら種別ごとの既定に落ちる', () => {
  const layers = defaultLayers();
  assert.equal(resolveNewLayer(layers, null, LAYER_IDS.wall), LAYER_IDS.wall);
  assert.equal(resolveNewLayer(layers, LAYER_IDS.axis, LAYER_IDS.wall), LAYER_IDS.axis);
  assert.equal(resolveNewLayer(layers, 'missing', LAYER_IDS.wall), LAYER_IDS.wall);
});

test('ロックされた画層は新規作成先にならない', () => {
  const layers = defaultLayers();
  layers[LAYER_IDS.axis].locked = true;
  // 置いた瞬間に選択できなくなるので、既定へ逃がす
  assert.equal(resolveNewLayer(layers, LAYER_IDS.axis, LAYER_IDS.wall), LAYER_IDS.wall);
});

test('追加した画層がファイルに保存され、読み戻せる', () => {
  const scene = sampleScene();
  const extra = addLayer(scene.layers, { name: 'A-SITE', aci: 3, lineType: 'dashed', printable: false });
  const wall = Object.values(scene.walls)[0];
  wall.layerId = extra.id;

  const restored = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  const back = restored.layers[extra.id];
  assert.ok(back, '追加した画層が保存されていない');
  assert.equal(back.name, 'A-SITE');
  assert.equal(back.lineType, 'dashed');
  assert.equal(back.printable, false);
  assert.equal(restored.walls[wall.id].layerId, extra.id);
});

test('追加した画層が DXF の LAYER テーブルに出る', () => {
  const scene = sampleScene();
  const extra = addLayer(scene.layers, { name: 'A-SITE' });
  Object.values(scene.walls)[0].layerId = extra.id;

  const parsed = new DxfParser().parseSync(sceneToDxf(scene, [], defaultSettings(), { escapeUnicode: false }))!;
  assert.ok(Object.keys(parsed.tables.layer.layers).includes('A-SITE'));
  assert.ok(parsed.entities.some((e) => e.layer === 'A-SITE'), 'その画層のエンティティが出ていない');
});

test('画層名が重複すると DXF のテーブルが壊れるので、重複は起きない', () => {
  const scene = sampleScene();
  for (let i = 0; i < 5; i++) addLayer(scene.layers);
  const names = Object.values(scene.layers).map((l) => l.name);
  assert.equal(new Set(names).size, names.length, `重複: ${names}`);

  const parsed = new DxfParser().parseSync(sceneToDxf(scene, [], defaultSettings(), { escapeUnicode: false }))!;
  assert.equal(Object.keys(parsed.tables.layer.layers).length, names.length);
});
