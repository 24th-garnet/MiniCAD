import { dxfOpts } from './dxf-oracle.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import DxfParser from 'dxf-parser';
import { sampleScene } from '../src/io/sample.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { sceneToDxf } from '../src/io/dxf.ts';
import { sceneToSvg } from '../src/io/svg.ts';
import { defaultSettings } from '../src/core/store.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { LAYER_IDS, defaultLayers, layerWeight } from '../src/core/layer.ts';
import { LINE_GROUPS, jisStandard, lineGroupById, paperToWorld } from '../src/core/standard.ts';

test('線群を替えると全画層の線の太さが連動する', () => {
  const layers = defaultLayers();
  const std = jisStandard();

  std.lineGroupId = '1.0'; // 0.25 / 0.5 / 1.0
  assert.equal(layerWeight(layers[LAYER_IDS.wall], std), 0.5, '壁は太線');
  assert.equal(layerWeight(layers[LAYER_IDS.opening], std), 0.25, '建具は細線');

  std.lineGroupId = '1.4'; // 0.35 / 0.7 / 1.4
  assert.equal(layerWeight(layers[LAYER_IDS.wall], std), 0.7);
  assert.equal(layerWeight(layers[LAYER_IDS.opening], std), 0.35);
});

test('線群はすべて 1:2:4 の比になっている (JIS Z 8312)', () => {
  const series = [0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1.0, 1.4, 2.0];
  for (const g of LINE_GROUPS) {
    for (const w of [g.thin, g.thick, g.extraThick]) {
      assert.ok(series.includes(w), `${w} は JIS の線の太さ系列にない`);
    }
    // 系列は公比 √2 なので、1:2:4 は「2段飛ばし」に相当する
    assert.equal(series.indexOf(g.thick) - series.indexOf(g.thin), 2, `${g.id}: 細→太`);
    assert.equal(series.indexOf(g.extraThick) - series.indexOf(g.thick), 2, `${g.id}: 太→極太`);
  }
});

test('画層の太さ上書きが線群より優先される', () => {
  const layers = defaultLayers();
  const std = jisStandard();
  layers[LAYER_IDS.wall].lineWeightOverride = 0.18;
  assert.equal(layerWeight(layers[LAYER_IDS.wall], std), 0.18);
});

test('尺度を替えると SVG の線幅と文字高が比例して変わる', () => {
  const scene = sampleScene();
  const rooms = detectRooms(scene);
  const settings = defaultSettings();

  scene.standard.scale = 100;
  const at100 = sceneToSvg(scene, rooms, settings);
  scene.standard.scale = 50;
  const at50 = sceneToSvg(scene, rooms, settings);

  // 1:100 で 0.25mm の細線はワールド 25mm、1:50 なら 12.5mm
  assert.ok(at100.includes('stroke-width="25"'), '1:100 の細線が 25 になっていない');
  assert.ok(at50.includes('stroke-width="12.5"'), '1:50 の細線が 12.5 になっていない');
  // 室名 5mm は 1:100 で 500
  assert.ok(at100.includes('font-size="500"'));
  assert.ok(at50.includes('font-size="250"'));
});

test('紙の mm とワールドの mm の換算が尺度どおり', () => {
  const std = jisStandard();
  std.scale = 100;
  assert.equal(paperToWorld(0.5, std), 50);
  std.scale = 50;
  assert.equal(paperToWorld(0.5, std), 25);
});

test('画層の表示を切ると DXF からもそのエンティティが消える', () => {
  const scene = sampleScene();
  const rooms = detectRooms(scene);
  const settings = defaultSettings();
  const parse = (dxf: string) => new DxfParser().parseSync(dxf)!;

  const before = parse(sceneToDxf(scene, rooms, settings, dxfOpts()));
  const furnitureName = scene.layers[LAYER_IDS.furniture].name;
  assert.ok(before.entities.some((e) => e.layer === furnitureName));

  scene.layers[LAYER_IDS.furniture].printable = false;
  const after = parse(sceneToDxf(scene, rooms, settings, dxfOpts()));
  assert.ok(!after.entities.some((e) => e.layer === furnitureName), '非印刷の画層が書き出されている');
  // 画層テーブル自体は残る
  assert.ok(Object.keys(after.tables.layer.layers).includes(furnitureName));
});

test('画層と規格がファイルに保存され、読み戻せる', () => {
  const scene = sampleScene();
  scene.standard.scale = 50;
  scene.standard.lineGroupId = '1.4';
  scene.layers[LAYER_IDS.wall].weightRole = 'extraThick';
  scene.layers[LAYER_IDS.draft].visible = false;

  const restored = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.equal(restored.standard.scale, 50);
  assert.equal(restored.standard.lineGroupId, '1.4');
  assert.equal(restored.layers[LAYER_IDS.wall].weightRole, 'extraThick');
  assert.equal(restored.layers[LAYER_IDS.draft].visible, false);
  assert.equal(layerWeight(restored.layers[LAYER_IDS.wall], restored.standard), 1.4);
});

test('画層を持たない旧ファイルも既定値で読み込める', () => {
  // version 1 相当。layers も standard も無い
  const legacy = {
    format: 'minicad',
    version: 1,
    scene: {
      nodes: { n1: { x: 0, y: 0 }, n2: { x: 4000, y: 0 } },
      walls: { w1: { a: 'n1', b: 'n2', thickness: 120 } },
      openings: {},
      furniture: { f1: { kind: 'sofa', name: 'ソファ', x: 1000, y: 500, w: 1800, h: 850, angle: 0 } },
      roomLabels: {},
    },
  };
  const scene = deserialize(legacy);
  assert.equal(Object.keys(scene.walls).length, 1);
  assert.equal(scene.walls['w1'].layerId, LAYER_IDS.wall, '壁に既定の画層が割り当たるべき');
  assert.equal(scene.instances['f1'].layerId, LAYER_IDS.furniture, '家具がブロックに変換されていない');
  assert.equal(scene.standard.scale, jisStandard().scale);
  assert.equal(Object.keys(scene.layers).length, Object.keys(defaultLayers()).length);
});

test('知らない画層IDを指すエンティティは既定の画層に落ちる', () => {
  const scene = deserialize({
    nodes: { n1: { x: 0, y: 0 }, n2: { x: 1000, y: 0 } },
    walls: { w1: { a: 'n1', b: 'n2', thickness: 120, layerId: 'does-not-exist' } },
  });
  assert.equal(scene.walls['w1'].layerId, LAYER_IDS.wall);
});

test('不正な線群・用紙の指定は既定値に丸められる', () => {
  const scene = deserialize({ nodes: {}, walls: {}, standard: { lineGroupId: 'bogus', paperId: 'A9', scale: -5 } });
  assert.equal(scene.standard.lineGroupId, lineGroupById('bogus').id);
  assert.equal(scene.standard.paperId, 'A3');
  assert.ok(scene.standard.scale > 0);
});
