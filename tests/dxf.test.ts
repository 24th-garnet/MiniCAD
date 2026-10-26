import { dxfOpts, headerPoint, oracleEntities, parseDxfOracle } from './dxf-oracle.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IDxf } from 'dxf-parser';
import { sampleScene } from '../src/io/sample.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { sceneToDxf, type DxfOptions } from '../src/io/dxf.ts';
import { defaultSettings } from '../src/core/store.ts';
import { LAYER_IDS } from '../src/core/layer.ts';

function build(options: Partial<DxfOptions> = {}) {
  const scene = sampleScene();
  const rooms = detectRooms(scene);
  const dxf = sceneToDxf(scene, rooms, defaultSettings(), {
    escapeUnicode: false,
    trueDimension: true,
    ...options,
  });
  return { scene, rooms, dxf };
}

/** 書き出した DXF を外部パーサで読み戻す。自前の思い込みを避けるための検証 */
const parse = (dxf: string): IDxf => parseDxfOracle(dxf);

test('DXF が外部パーサで読み戻せる', () => {
  const { dxf } = build();
  const parsed = parse(dxf);
  assert.ok(parsed, 'パースに失敗した');
  assert.ok(oracleEntities(parsed).length > 50, `エンティティ数 ${oracleEntities(parsed).length}`);
});

test('ヘッダに mm 単位とメートル法が入っている', () => {
  const { dxf } = build();
  const parsed = parse(dxf);
  assert.equal(parsed.header['$INSUNITS'], 4, 'ミリメートルを示す 4 であるべき');
  assert.equal(parsed.header['$MEASUREMENT'], 1, 'メートル法を示す 1 であるべき');
  assert.equal(parsed.header['$ACADVER'], 'AC1009');
});

test('画層テーブルが MiniCAD の画層と一致する', () => {
  const { scene, dxf } = build();
  const parsed = parse(dxf);
  const names = Object.keys(parsed.tables.layer.layers).sort();
  const expected = Object.values(scene.layers).map((l) => l.name).sort();
  assert.deepEqual(names, expected);
  assert.ok(names.includes('A-WALL'));
  assert.ok(names.includes('A-DOOR-WIND'));
});

test('エンティティが正しい画層に乗っている', () => {
  const { scene, dxf } = build();
  const parsed = parse(dxf);
  const byLayer = new Map<string, string[]>();
  for (const e of oracleEntities(parsed)) {
    const list = byLayer.get(e.layer) ?? [];
    list.push(e.type);
    byLayer.set(e.layer, list);
  }
  const wallLayer = scene.layers[LAYER_IDS.wall].name;
  const openingLayer = scene.layers[LAYER_IDS.opening].name;

  assert.ok((byLayer.get(wallLayer) ?? []).every((t) => t === 'LINE'), '壁は線だけであるべき');
  assert.ok((byLayer.get(wallLayer) ?? []).length > 20);
  // ドアの開き軌跡が ARC として出ている
  assert.ok((byLayer.get(openingLayer) ?? []).includes('ARC'), 'ドアの円弧がない');
  assert.ok((byLayer.get(openingLayer) ?? []).includes('LINE'));
  // 室名が TEXT として出ている
  const texts = oracleEntities(parsed).filter((e) => e.type === 'TEXT');
  assert.ok(texts.some((t) => t.text === 'LDK'), '室名 LDK が見つからない');
});

test('開口部の位置に壁の線が通っていない', () => {
  const { scene, dxf } = build();
  const parsed = parse(dxf);
  const wallLayer = scene.layers[LAYER_IDS.wall].name;
  // 南側の外壁 (y=0 近辺) には offset 2000 / 幅 2600 の窓がある → x 700..3300 が開口
  const wallLines = oracleEntities(parsed).filter(
    (e) => e.layer === wallLayer && e.type === 'LINE' && Math.abs(e.vertices[0].y) < 200 && Math.abs(e.vertices[1].y) < 200,
  );
  const spansOpening = wallLines.some((e) => {
    const [a, b] = e.vertices;
    if (Math.abs(a.y - b.y) > 1) return false; // 小口の縦線は除く
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    return lo < 1000 && hi > 3000; // 開口をまたいでいる
  });
  assert.ok(!spansOpening, '窓の位置を壁の線が横切っている');
});

test('座標が有限で、図面範囲がヘッダと矛盾しない', () => {
  const { dxf } = build();
  const parsed = parse(dxf);
  for (const e of oracleEntities(parsed)) {
    for (const v of e.vertices ?? []) {
      assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y), `不正な座標 ${JSON.stringify(v)}`);
    }
  }
  assert.ok(headerPoint(parsed, '$EXTMAX').x > headerPoint(parsed, '$EXTMIN').x);
  assert.ok(headerPoint(parsed, '$EXTMAX').y > headerPoint(parsed, '$EXTMIN').y);
});

test('Unicode エスケープを選ぶと ASCII だけになる', () => {
  const plain = build(dxfOpts()).dxf;
  const escaped = build(dxfOpts({ escapeUnicode: true })).dxf;
  assert.ok(/[^\x00-\x7F]/.test(plain), '通常出力には日本語がそのまま入る');
  assert.ok(!/[^\x00-\x7F]/.test(escaped), 'エスケープ時は ASCII だけになるべき');
  assert.ok(escaped.includes('\\U+'), 'エスケープ表記が見当たらない');
  // エスケープしても構造は壊れない
  assert.ok(oracleEntities(parse(escaped)).length > 50);
});

test('ドアの開き軌跡が 90 度の円弧になっている', () => {
  const { scene, dxf } = build();
  const parsed = parse(dxf);
  const arcs = oracleEntities(parsed).filter((e) => e.type === 'ARC');
  const doors = Object.values(scene.openings).filter((o) => o.kind === 'door');
  assert.equal(arcs.length, doors.length, `ドア ${doors.length} 枚に対し円弧 ${arcs.length} 本`);

  for (const arc of arcs) {
    // DXF の ARC は start から end へ反時計回り。扇形の角度は常に 90 度のはず
    let sweep = (arc.endAngle - arc.startAngle) * (180 / Math.PI);
    while (sweep < 0) sweep += 360;
    while (sweep >= 360) sweep -= 360;
    assert.ok(
      Math.abs(sweep - 90) < 0.01,
      `円弧の掃き角が ${sweep.toFixed(1)}° になっている（270° なら向きの取り違え）`,
    );
  }
});

test('ドアの開き軌跡が建具の幅と一致する', () => {
  const { scene, dxf } = build();
  const parsed = parse(dxf);
  const widths = new Set(
    Object.values(scene.openings)
      .filter((o) => o.kind === 'door')
      .map((o) => o.width),
  );
  for (const arc of oracleEntities(parsed).filter((e) => e.type === 'ARC')) {
    assert.ok(widths.has(Math.round(arc.radius)), `半径 ${arc.radius} に対応するドアがない`);
  }
});

// --- 本物の DIMENSION エンティティ ---

import { dimensionGeometry, TICK_PAPER_MM } from '../src/core/dimension.ts';

const dimensionsOf = (scene: ReturnType<typeof sampleScene>) =>
  Object.values(scene.shapes).filter((s) => s.shape === 'dimension');

test('寸法が DIMENSION エンティティとして出る', () => {
  const { scene, dxf } = build();
  const parsed = parse(dxf)!;
  const dims = oracleEntities(parsed).filter((e) => e.type === 'DIMENSION');
  assert.equal(dims.length, dimensionsOf(scene).length);
  assert.ok(dims.length > 0, 'サンプルに寸法が無い');
});

test('DIMENSION の種別が 33（整列寸法 + 専用ブロック）', () => {
  const { dxf } = build();
  for (const e of oracleEntities(parse(dxf)).filter((x) => x.type === 'DIMENSION')) {
    const t = e.dimensionType as number;
    // 下位3bit = 1 は整列寸法。回転寸法(0)だと値が角度への投影で決まり、斜め寸法で実測値と食い違う
    assert.equal(t & 7, 1, `種別 ${t}`);
    assert.equal(t & 32, 32, `無名ブロックのビットが立っていない: ${t}`);
  }
});

test('DIMENSION の計測点と実測値が幾何と一致する', () => {
  const { scene, dxf } = build();
  const parsed = parse(dxf)!;
  const dims = oracleEntities(parsed).filter((e) => e.type === 'DIMENSION') as unknown as {
    linearOrAngularPoint1: { x: number; y: number };
    linearOrAngularPoint2: { x: number; y: number };
    actualMeasurement: number;
  }[];

  const expected = dimensionsOf(scene)
    .map((d) => (d.shape === 'dimension' ? dimensionGeometry(scene, d, scene.standard) : null))
    .filter((g) => g !== null);
  assert.equal(dims.length, expected.length);

  for (let i = 0; i < dims.length; i++) {
    const g = expected[i]!;
    assert.ok(Math.abs(dims[i].linearOrAngularPoint1.x - g.a.x) < 0.001);
    assert.ok(Math.abs(dims[i].linearOrAngularPoint1.y - g.a.y) < 0.001);
    assert.ok(Math.abs(dims[i].linearOrAngularPoint2.x - g.b.x) < 0.001);
    assert.ok(Math.abs(dims[i].linearOrAngularPoint2.y - g.b.y) < 0.001);
    assert.ok(Math.abs(dims[i].actualMeasurement - g.value) < 0.001, `実測値 ${dims[i].actualMeasurement}`);
  }
});

test('DIMENSION が参照する無名ブロックに線と文字の実体が入っている', () => {
  const { dxf } = build();
  const parsed = parse(dxf)!;
  for (const e of oracleEntities(parsed).filter((x) => x.type === 'DIMENSION')) {
    const name = e.block as string;
    assert.match(name, /^\*D\d+$/, `ブロック名 ${name}`);
    const block = parsed.blocks[name];
    assert.ok(block, `${name} が BLOCKS に無い`);
    const types = (block.entities ?? []).map((x: { type: string }) => x.type);
    // 寸法線1 + 補助線2 + 斜線2 = 5本、文字1個
    assert.equal(types.filter((t: string) => t === 'LINE').length, 5, `${name} の線の本数`);
    assert.equal(types.filter((t: string) => t === 'TEXT').length, 1, `${name} の文字の数`);
  }
});

test('ブロックの中身は画層 0 に置かれ、画層は DIMENSION 側が決める', () => {
  const { scene, dxf } = build();
  const parsed = parse(dxf)!;
  const dimLayer = scene.layers[LAYER_IDS.dimension].name;
  for (const e of oracleEntities(parsed).filter((x) => x.type === 'DIMENSION')) {
    assert.equal(e.layer, dimLayer);
    for (const inner of parsed.blocks[e.block as string].entities ?? []) {
      assert.equal((inner as { layer?: string }).layer, '0');
    }
  }
});

test('DIMSTYLE と $DIM* が入っている', () => {
  const { scene, dxf } = build();
  assert.ok(dxf.includes('DIMSTYLE'), 'DIMSTYLE テーブルが無い');
  assert.ok(dxf.includes('MINICAD'), 'スタイル名が無い');
  const parsed = parse(dxf)!;
  // DIMTSZ > 0 が「矢印ではなく45度の斜線」を意味する
  const expected = TICK_PAPER_MM * scene.standard.scale;
  assert.ok(Math.abs(Number(parsed.header['$DIMTSZ']) - expected) < 1e-6, `$DIMTSZ ${parsed.header['$DIMTSZ']}`);
  assert.equal(Number(parsed.header['$DIMSCALE']), 1, 'モデル空間は原寸なので DIMSCALE は 1');
});

test('trueDimension: false なら従来どおり線と文字に落ちる', () => {
  const { scene, dxf } = build({ trueDimension: false });
  const parsed = parse(dxf)!;
  assert.equal(oracleEntities(parsed).filter((e) => e.type === 'DIMENSION').length, 0);

  const dimLayer = scene.layers[LAYER_IDS.dimension].name;
  const onLayer = oracleEntities(parsed).filter((e) => e.layer === dimLayer);
  assert.ok(onLayer.some((e) => e.type === 'LINE'), '寸法線が出ていない');
  assert.ok(onLayer.some((e) => e.type === 'TEXT'), '寸法値が出ていない');
  assert.ok(!dxf.includes('*D0'), '無名ブロックが残っている');
});

test('日本語の寸法値を上書きしてもエスケープが効く', () => {
  const scene = sampleScene();
  const dim = Object.values(scene.shapes).find((s) => s.shape === 'dimension');
  assert.ok(dim?.shape === 'dimension');
  if (dim?.shape !== 'dimension') return;
  dim.override = '約2730';

  const opts = { escapeUnicode: true, trueDimension: true };
  const dxf = sceneToDxf(scene, detectRooms(scene), defaultSettings(), opts);
  assert.ok(!/[^\x00-\x7F]/.test(dxf), 'エスケープ時に非 ASCII が残っている');
  assert.ok(parse(dxf), '読み戻せない');
});
