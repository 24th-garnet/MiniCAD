import { dxfOpts, oracleEntities, parseDxfOracle } from './dxf-oracle.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleScene } from '../src/io/sample.ts';
import { emptyScene } from '../src/core/types.ts';
import {
  blockUsageCount,
  defineBlock,
  explodeInstance,
  instanceBounds,
  instanceSize,
  instanceToWorld,
  purgeUnusedBlocks,
  renameBlock,
  sanitizeBlockName,
  type BlockInstance,
} from '../src/core/block.ts';
import { BLOCK_PRESETS, builtinBlocks } from '../src/core/blockPresets.ts';
import { transformEntities } from '../src/core/transformOps.ts';
import { mirror, rotation } from '../src/core/transform.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { sceneToDxf } from '../src/io/dxf.ts';
import { sceneToSvg } from '../src/io/svg.ts';
import { defaultSettings } from '../src/core/store.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { boundsOf, rotate, toRad, vec, type Vec } from '../src/core/geometry.ts';
import { newId } from '../src/core/id.ts';
import type { Shape } from '../src/core/shapes.ts';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const nearPt = (a: Vec, b: Vec, eps = 1e-6) => near(a.x, b.x, eps) && near(a.y, b.y, eps);

function sceneWithLines() {
  const scene = emptyScene();
  const ids: string[] = [];
  for (const [ax, ay, bx, by] of [
    [0, 0, 1000, 0],
    [1000, 0, 1000, 500],
  ]) {
    const id = newId('s');
    const shape: Shape = { id, shape: 'line', layerId: LAYER_IDS.shape, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(), a: vec(ax, ay), b: vec(bx, by) };
    scene.shapes[id] = shape;
    ids.push(id);
  }
  return { scene, ids };
}

test('標準ブロックが全プリセットぶん用意される', () => {
  const blocks = builtinBlocks();
  assert.equal(Object.keys(blocks).length, BLOCK_PRESETS.length);
  for (const preset of BLOCK_PRESETS) {
    const def = blocks[preset.id];
    assert.ok(def, `${preset.label} が無い`);
    assert.equal(def.source, 'builtin');
    assert.ok(Object.keys(def.shapes).length >= 1, `${preset.label} に中身が無い`);
    assert.deepEqual(def.size, { w: preset.w, h: preset.h });
  }
});

test('ブロック名は DXF に出せる ASCII で一意', () => {
  const names = Object.values(builtinBlocks()).map((b) => b.name);
  assert.equal(new Set(names).size, names.length, `重複: ${names}`);
  for (const name of names) assert.match(name, /^[A-Za-z0-9_$-]+$/, name);
});

test('日本語ラベルから ASCII 名を作れて、重複しない', () => {
  const taken = new Set<string>();
  const a = sanitizeBlockName('方位記号', taken);
  taken.add(a);
  const b = sanitizeBlockName('方位記号', taken);
  assert.match(a, /^[A-Za-z0-9_$-]+$/);
  assert.notEqual(a, b, '同じラベルで同じ名前が出ている');
});

test('定義座標からワールドへの変換が尺度・回転・鏡像の合成と一致する', () => {
  const inst: BlockInstance = {
    id: 'i1',
    blockId: 'box',
    layerId: LAYER_IDS.furniture,
    levelId: DEFAULT_LEVEL_ID,
    attrs: defaultAttrs(),
    x: 1000,
    y: 2000,
    scaleX: -2,
    scaleY: 3,
    angle: toRad(30),
    label: null,
  };
  const p = vec(10, 20);
  const expected = {
    x: 1000 + rotate(vec(10 * -2, 20 * 3), toRad(30)).x,
    y: 2000 + rotate(vec(10 * -2, 20 * 3), toRad(30)).y,
  };
  assert.ok(nearPt(instanceToWorld(inst, p), expected));
});

test('尺度を掛けた見かけの寸法', () => {
  const scene = emptyScene();
  const def = scene.blocks['bed-single'];
  const inst: BlockInstance = {
    id: 'i1',
    blockId: 'bed-single',
    layerId: LAYER_IDS.furniture,
    levelId: DEFAULT_LEVEL_ID,
    attrs: defaultAttrs(),
    x: 0,
    y: 0,
    scaleX: 1.4,
    scaleY: 1,
    angle: 0,
    label: null,
  };
  assert.ok(near(instanceSize(def, inst).w, def.size.w * 1.4));
  // 鏡像でも寸法は正の値
  assert.ok(near(instanceSize(def, { ...inst, scaleX: -1.4 }).w, def.size.w * 1.4));
});

test('ブロック化の前後で見た目の範囲が変わらない', () => {
  const { scene, ids } = sceneWithLines();
  const before = boundsOf(Object.values(scene.shapes).flatMap((s) => (s.shape === 'line' ? [s.a, s.b] : [])))!;

  // 基点をどこに取っても結果は変わらないはず
  const instId = defineBlock(scene, ids, vec(500, 250), 'テスト部品')!;
  assert.ok(instId);
  assert.equal(Object.keys(scene.shapes).length, 0, '元の図形が残っている');

  const after = instanceBounds(scene, scene.instances[instId])!;
  assert.ok(nearPt(after.min, before.min), `${JSON.stringify(after.min)} vs ${JSON.stringify(before.min)}`);
  assert.ok(nearPt(after.max, before.max));
});

test('基点を変えてもブロックの見た目は変わらない', () => {
  const a = sceneWithLines();
  const b = sceneWithLines();
  const ia = defineBlock(a.scene, a.ids, vec(0, 0), '部品')!;
  const ib = defineBlock(b.scene, b.ids, vec(9999, -1234), '部品')!;
  const ba = instanceBounds(a.scene, a.scene.instances[ia])!;
  const bb = instanceBounds(b.scene, b.scene.instances[ib])!;
  assert.ok(nearPt(ba.min, bb.min) && nearPt(ba.max, bb.max));
});

test('分解はブロック化の逆になる', () => {
  const { scene, ids } = sceneWithLines();
  const before = instanceBoundsOfShapes(scene);
  const instId = defineBlock(scene, ids, vec(500, 250), '部品')!;

  const created = explodeInstance(scene, instId);
  assert.equal(created.length, 2, '中身が戻っていない');
  assert.equal(scene.instances[instId], undefined);
  const after = instanceBoundsOfShapes(scene);
  assert.ok(nearPt(before!.min, after!.min) && nearPt(before!.max, after!.max));
});

function instanceBoundsOfShapes(scene: ReturnType<typeof emptyScene>) {
  return boundsOf(Object.values(scene.shapes).flatMap((s) => (s.shape === 'line' ? [s.a, s.b] : [])));
}

test('使われていないユーザー定義ブロックだけを掃除する', () => {
  const { scene, ids } = sceneWithLines();
  const instId = defineBlock(scene, ids, vec(0, 0), '部品')!;
  const blockId = scene.instances[instId].blockId;
  assert.equal(blockUsageCount(scene, blockId), 1);

  assert.deepEqual(purgeUnusedBlocks(scene), [], '使っているのに消している');
  delete scene.instances[instId];
  assert.deepEqual(purgeUnusedBlocks(scene), [blockId]);
  // 標準ブロックは残る
  assert.equal(Object.keys(scene.blocks).length, BLOCK_PRESETS.length);
});

test('ブロックを改名すると DXF 名も付け直される', () => {
  const { scene, ids } = sceneWithLines();
  const instId = defineBlock(scene, ids, vec(0, 0), '部品')!;
  const blockId = scene.instances[instId].blockId;
  assert.equal(renameBlock(scene, blockId, '方位記号'), true);
  assert.equal(scene.blocks[blockId].label, '方位記号');
  assert.match(scene.blocks[blockId].name, /^[A-Za-z0-9_$-]+$/);
  assert.equal(renameBlock(scene, blockId, '  '), false);
});

test('鏡像でブロックの尺度の符号が反転する', () => {
  const scene = sampleScene();
  const inst = Object.values(scene.instances)[0];
  const before = inst.scaleX;
  transformEntities(scene, [{ type: 'blockInstance', id: inst.id }], mirror(vec(0, 0), vec(0, 1)), { copy: false });
  assert.equal(scene.instances[inst.id].scaleX, -before, '左右が反転していない');
});

test('回転では尺度の符号が変わらない', () => {
  const scene = sampleScene();
  const inst = Object.values(scene.instances)[0];
  const before = inst.scaleX;
  transformEntities(scene, [{ type: 'blockInstance', id: inst.id }], rotation(vec(0, 0), toRad(90)), { copy: false });
  assert.equal(scene.instances[inst.id].scaleX, before);
});

test('ブロックとインスタンスが JSON 往復で保たれる', () => {
  const { scene, ids } = sceneWithLines();
  defineBlock(scene, ids, vec(100, 200), '部品');
  const restored = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.deepEqual(restored.instances, scene.instances);
  assert.deepEqual(Object.keys(restored.blocks).sort(), Object.keys(scene.blocks).sort());
});

test('定義の無いインスタンスは読み込み時に捨てられる', () => {
  const scene = deserialize({
    instances: { i1: { blockId: 'does-not-exist', x: 0, y: 0 } },
  });
  assert.equal(Object.keys(scene.instances).length, 0);
});

test('家具が専用エンティティだった頃のファイルがブロックに変換される', () => {
  const legacy = {
    format: 'minicad',
    version: 5,
    scene: {
      nodes: {},
      walls: {},
      furniture: {
        f1: { kind: 'bed', name: 'ベッドS', x: 1000, y: 2000, w: 1000, h: 1950, angle: 0 },
        f2: { kind: 'sofa', name: 'ソファ', x: 0, y: 0, w: 2700, h: 850, angle: 1 },
      },
    },
  };
  const scene = deserialize(legacy);
  assert.equal(Object.keys(scene.instances).length, 2);

  const bed = scene.instances['f1'];
  assert.equal(bed.blockId, 'bed-single');
  assert.ok(near(instanceSize(scene.blocks[bed.blockId], bed).w, 1000), '寸法が保たれていない');

  // 幅を変えてあった家具は、尺度として引き継がれる
  const sofa = scene.instances['f2'];
  assert.ok(near(instanceSize(scene.blocks[sofa.blockId], sofa).w, 2700), '幅が引き継がれていない');
  assert.equal(sofa.angle, 1);
});

test('DXF に BLOCK と INSERT が出る', () => {
  const scene = sampleScene();
  const dxf = sceneToDxf(scene, [], defaultSettings(), dxfOpts());
  assert.ok(dxf.includes('\r\nBLOCK\r\n'), 'BLOCK が出ていない');
  assert.ok(dxf.includes('\r\nINSERT\r\n'), 'INSERT が出ていない');

  const parsed = parseDxfOracle(dxf);
  const inserts = oracleEntities(parsed).filter((e) => e.type === 'INSERT');
  assert.equal(inserts.length, Object.keys(scene.instances).length, 'INSERT の本数が合わない');
  assert.ok(parsed.blocks && Object.keys(parsed.blocks).length > 0, 'ブロック定義が読めない');
});

test('同じブロックを何個置いても定義は1つ', () => {
  const scene = sampleScene();
  const first = Object.values(scene.instances)[0];
  for (let i = 0; i < 5; i++) {
    const id = newId('i');
    scene.instances[id] = { ...first, id, x: first.x + i * 3000 };
  }
  const parsed = parseDxfOracle(sceneToDxf(scene, [], defaultSettings(), dxfOpts()))!;
  const names = Object.keys(parsed.blocks ?? {});
  assert.equal(new Set(names).size, names.length, 'ブロック定義が重複している');
});

test('INSERT の挿入点と回転が元のインスタンスと一致する', () => {
  const scene = sampleScene();
  const inst = Object.values(scene.instances).find((i) => i.angle !== 0) ?? Object.values(scene.instances)[0];
  const parsed = parseDxfOracle(sceneToDxf(scene, [], defaultSettings(), dxfOpts()))!;
  const def = scene.blocks[inst.blockId];
  const insert = oracleEntities(parsed).find(
    (e) => e.type === 'INSERT' && e.name === def.name && near(e.position.x, inst.x, 0.01),
  )!;
  assert.ok(insert, '対応する INSERT が見つからない');
  assert.ok(near(insert.position.y, inst.y, 0.01));
  assert.ok(near(((insert.rotation ?? 0) * Math.PI) / 180, inst.angle, 1e-6), `回転 ${insert.rotation}`);
});

test('ブロック定義の中身は画層 0 に置かれる', () => {
  const scene = sampleScene();
  const parsed = parseDxfOracle(sceneToDxf(scene, [], defaultSettings(), dxfOpts()))!;
  for (const block of Object.values(parsed.blocks ?? {})) {
    for (const e of block.entities ?? []) {
      assert.equal(e.layer, '0', `ブロックの中身が画層 ${e.layer} に出ている`);
    }
  }
});

test('ブロックが SVG に出る', () => {
  const scene = sampleScene();
  const svg = sceneToSvg(scene, [], defaultSettings());
  assert.ok(svg.includes('ソファ'), 'ブロックの名前が出ていない');
  assert.ok(!/NaN|Infinity|undefined/.test(svg));
});
