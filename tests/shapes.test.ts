import { dxfOpts, oracleEntities, parseDxfOracle } from './dxf-oracle.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, type Scene } from '../src/core/types.ts';
import { SHAPE_GEOMETRY, SHAPE_KINDS, shapeOutline, shapeVertices, type Shape, type ShapeKind } from '../src/core/shapes.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { vec } from '../src/core/geometry.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { sceneToDxf } from '../src/io/dxf.ts';
import { sceneToSvg } from '../src/io/svg.ts';
import { defaultSettings } from '../src/core/store.ts';
import { pickAt } from '../src/core/pick.ts';
import { snapPoint } from '../src/core/snap.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { render } from '../src/render/renderer.ts';
import { Viewport } from '../src/render/viewport.ts';
import { sceneBounds } from '../src/core/entity.ts';

/**
 * 各種別の代表例。`Record<ShapeKind, Shape>` なので、
 * 種別を足してここに書き忘れると型エラーになる。
 */
const SAMPLES: { [K in ShapeKind]: Extract<Shape, { shape: K }> } = {
  line: { id: 'sh-line', shape: 'line', layerId: LAYER_IDS.shape, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(), a: vec(0, 0), b: vec(2000, 1000) },
  polyline: {
    id: 'sh-poly',
    shape: 'polyline',
    layerId: LAYER_IDS.shape,
    levelId: DEFAULT_LEVEL_ID,
    attrs: defaultAttrs(),
    points: [vec(3000, 0), vec(4000, 0), vec(4000, 1000)],
    closed: false,
  },
  arc: {
    id: 'sh-arc',
    shape: 'arc',
    layerId: LAYER_IDS.shape,
    levelId: DEFAULT_LEVEL_ID,
    attrs: defaultAttrs(),
    center: vec(6000, 0),
    radius: 800,
    startAngle: 0,
    endAngle: Math.PI / 2,
  },
  circle: { id: 'sh-circle', shape: 'circle', layerId: LAYER_IDS.shape, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(), center: vec(8000, 0), radius: 600 },
  text: {
    id: 'sh-text',
    shape: 'text',
    layerId: LAYER_IDS.roomName,
    levelId: DEFAULT_LEVEL_ID,
    attrs: defaultAttrs(),
    at: vec(0, 3000),
    text: '注記テキスト',
    height: 3.5,
    angle: 0,
    align: 'center',
  },
  point: { id: 'sh-point', shape: 'point', layerId: LAYER_IDS.shape, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(), at: vec(5000, 3000) },
  dimension: {
    id: 'sh-dim',
    shape: 'dimension',
    layerId: LAYER_IDS.dimension,
    levelId: DEFAULT_LEVEL_ID,
    attrs: defaultAttrs(),
    a: { x: 0, y: -2000, nodeId: null },
    b: { x: 3000, y: -2000, nodeId: null },
    offset: -500,
    override: null,
  },
};

function sceneWithAllShapes(): Scene {
  const scene = emptyScene();
  for (const s of Object.values(SAMPLES)) scene.shapes[s.id] = structuredClone(s);
  return scene;
}

/** 呼ばれたメソッドを記録し、非有限な数値が来たら落ちる Canvas スタブ */
function stubContext() {
  const calls: string[] = [];
  const noop =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(name);
      for (const a of args) {
        if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(`${name}: ${String(a)}`);
      }
    };
  const ctx: Record<string, unknown> = {};
  for (const name of [
    'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'rect', 'arc', 'ellipse',
    'fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'translate', 'rotate', 'setLineDash',
  ]) {
    ctx[name] = noop(name);
  }
  ctx.measureText = (t: string) => ({ width: t.length * 6 });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

test('代表例がすべての種別を網羅している', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...SHAPE_KINDS].sort());
});

test('全種別が JSON 往復で一致する', () => {
  const scene = sceneWithAllShapes();
  const restored = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.deepEqual(restored.shapes, scene.shapes);
});

test('知らない種別の図形は読み込み時に捨てられる', () => {
  const scene = deserialize({
    nodes: {},
    walls: {},
    shapes: {
      ok: { shape: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } },
      bogus: { shape: 'spline', points: [] },
      broken: { shape: 'line', a: { x: 0, y: 0 } },
    },
  });
  assert.deepEqual(Object.keys(scene.shapes), ['ok']);
});

test('図形を持たない旧ファイルも読める', () => {
  const scene = deserialize({ format: 'minicad', version: 2, scene: { nodes: {}, walls: {} } });
  assert.deepEqual(scene.shapes, {});
});

test('不正な画層を指す図形は既定の画層に落ちる', () => {
  const scene = deserialize({
    shapes: { s1: { shape: 'point', at: { x: 0, y: 0 }, layerId: 'does-not-exist' } },
  });
  assert.equal(scene.shapes['s1'].layerId, LAYER_IDS.shape);
});

test('全種別が折れ線と代表点を返す', () => {
  const scene = sceneWithAllShapes();
  for (const kind of SHAPE_KINDS) {
    const s = scene.shapes[SAMPLES[kind].id];
    assert.ok(shapeVertices(scene, s).length > 0, `${kind}: 代表点がない`);
    assert.ok(shapeOutline(scene, s).length > 0, `${kind}: 折れ線がない`);
    for (const p of shapeVertices(scene, s)) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${kind}: 座標が不正`);
    }
  }
});

test('全種別がクリックで拾える', () => {
  const scene = sceneWithAllShapes();
  const probes: Record<ShapeKind, { x: number; y: number }> = {
    line: vec(1000, 500),
    polyline: vec(3500, 0),
    arc: vec(6000 + 800 * Math.cos(Math.PI / 4), 800 * Math.sin(Math.PI / 4)),
    circle: vec(8600, 0),
    text: vec(0, 3000),
    point: vec(5000, 3000),
    // 寸法線の上（端点から offset だけ離れた位置）
    dimension: vec(1500, -2500),
  };
  for (const kind of SHAPE_KINDS) {
    const hit = pickAt(scene, probes[kind], 60);
    assert.equal(hit?.type, 'shape', `${kind}: 拾えない`);
    assert.equal(hit?.id, SAMPLES[kind].id, `${kind}: 別の図形を拾っている`);
  }
});

test('何も無いところでは拾わない', () => {
  const scene = sceneWithAllShapes();
  assert.equal(pickAt(scene, vec(-5000, -5000), 60), null);
});

test('円の中心と四分点にスナップできる', () => {
  const scene = sceneWithAllShapes();
  const center = snapPoint(scene, defaultSettings(), vec(8030, 20), { radius: 200 });
  assert.equal(center.kind, 'center');
  const quadrant = snapPoint(scene, defaultSettings(), vec(8610, 10), { radius: 200 });
  assert.equal(quadrant.kind, 'node');
});

test('非表示の画層の図形はスナップにも当たり判定にも出ない', () => {
  const scene = sceneWithAllShapes();
  scene.layers[LAYER_IDS.shape].visible = false;
  assert.equal(pickAt(scene, vec(1000, 500), 60), null);
  const snap = snapPoint(scene, defaultSettings(), vec(8030, 20), { radius: 200 });
  assert.notEqual(snap.kind, 'center');
});

test('図形は壁グラフに混ざらないので部屋にならない', () => {
  const scene = sceneWithAllShapes();
  assert.equal(detectRooms(scene).length, 0);
});

test('図形が図面範囲に含まれる', () => {
  const scene = sceneWithAllShapes();
  const b = sceneBounds(scene)!;
  assert.ok(b.max.x >= 8600, `円の右端が含まれていない: ${b.max.x}`);
  assert.ok(b.max.y >= 3000);
});

test('全種別が例外なく描画できる', () => {
  const scene = sceneWithAllShapes();
  const vp = new Viewport();
  vp.resize(1200, 800);
  vp.fit(sceneBounds(scene));
  const { ctx, calls } = stubContext();
  render({ ctx, vp, scene, rooms: [], settings: defaultSettings(), selected: new Set(), hover: null });
  assert.ok(calls.includes('arc'), '円・円弧が描かれていない');
  assert.ok(calls.includes('fillText'), '文字が描かれていない');
});

test('DXF に LINE / ARC / CIRCLE / TEXT として出る', () => {
  const scene = sceneWithAllShapes();
  const dxf = sceneToDxf(scene, [], defaultSettings(), dxfOpts());
  const parsed = parseDxfOracle(dxf);
  const types = new Set(oracleEntities(parsed).map((e) => e.type));
  for (const expected of ['LINE', 'ARC', 'CIRCLE', 'TEXT']) {
    assert.ok(types.has(expected), `${expected} が出ていない`);
  }
  // 円弧の掃き角は 90 度
  const arc = oracleEntities(parsed).find((e) => e.type === 'ARC')!;
  let sweep = ((arc.endAngle - arc.startAngle) * 180) / Math.PI;
  while (sweep < 0) sweep += 360;
  assert.ok(Math.abs(sweep - 90) < 0.01, `掃き角 ${sweep}`);
  // 文字が正しい画層に乗っている
  const textEntity = oracleEntities(parsed).find((e) => e.type === 'TEXT')!;
  assert.equal(textEntity.layer, scene.layers[LAYER_IDS.roomName].name);
  assert.equal(textEntity.text, '注記テキスト');
});

test('SVG が妥当なまま図形を含む', () => {
  const scene = sceneWithAllShapes();
  const svg = sceneToSvg(scene, [], defaultSettings());
  assert.ok(!/NaN|Infinity|undefined/.test(svg), '不正な値が含まれている');
  assert.ok(svg.includes('<circle'), '円が出ていない');
  assert.ok(svg.includes('注記テキスト'));
  for (const tag of svg.match(/<[^>]*>/g) ?? []) {
    assert.equal((tag.match(/"/g) ?? []).length % 2, 0, `属性値が閉じていない: ${tag.slice(0, 100)}`);
  }
});

test('画層を非印刷にすると書き出しから消える', () => {
  const scene = sceneWithAllShapes();
  scene.layers[LAYER_IDS.shape].printable = false;
  const parsed = parseDxfOracle(sceneToDxf(scene, [], defaultSettings(), dxfOpts()))!;
  const shapeLayer = scene.layers[LAYER_IDS.shape].name;
  assert.ok(!oracleEntities(parsed).some((e) => e.layer === shapeLayer));
  // 文字は別画層なので残る
  assert.ok(oracleEntities(parsed).some((e) => e.type === 'TEXT'));
});

test('点の大きさは尺度に追従する', () => {
  const scene = sceneWithAllShapes();
  const at100 = SHAPE_GEOMETRY.point.primitives(scene, SAMPLES.point, { ...scene.standard, scale: 100 });
  const at50 = SHAPE_GEOMETRY.point.primitives(scene, SAMPLES.point, { ...scene.standard, scale: 50 });
  const span = (p: typeof at100) => {
    const seg = p[0].kind === 'segments' ? p[0].segments[0] : null;
    return seg ? Math.abs(seg.b.x - seg.a.x) : 0;
  };
  assert.ok(span(at100) > span(at50), '尺度を小さくしたのに記号が縮んでいない');
  assert.equal(span(at100) / span(at50), 2);
});
