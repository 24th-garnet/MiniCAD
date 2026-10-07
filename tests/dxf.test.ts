import { test } from 'node:test';
import assert from 'node:assert/strict';
import DxfParser from 'dxf-parser';
import { sampleScene } from '../src/io/sample.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { sceneToDxf } from '../src/io/dxf.ts';
import { defaultSettings } from '../src/core/store.ts';
import { LAYER_IDS } from '../src/core/layer.ts';

function build(options = { escapeUnicode: false }) {
  const scene = sampleScene();
  const rooms = detectRooms(scene);
  const dxf = sceneToDxf(scene, rooms, defaultSettings(), options);
  return { scene, rooms, dxf };
}

/** 書き出した DXF を外部パーサで読み戻す。自前の思い込みを避けるための検証 */
function parse(dxf: string) {
  return new DxfParser().parseSync(dxf);
}

test('DXF が外部パーサで読み戻せる', () => {
  const { dxf } = build();
  const parsed = parse(dxf);
  assert.ok(parsed, 'パースに失敗した');
  assert.ok(parsed.entities.length > 50, `エンティティ数 ${parsed.entities.length}`);
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
  for (const e of parsed.entities) {
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
  const texts = parsed.entities.filter((e) => e.type === 'TEXT');
  assert.ok(texts.some((t) => t.text === 'LDK'), '室名 LDK が見つからない');
});

test('開口部の位置に壁の線が通っていない', () => {
  const { scene, dxf } = build();
  const parsed = parse(dxf);
  const wallLayer = scene.layers[LAYER_IDS.wall].name;
  // 南側の外壁 (y=0 近辺) には offset 2000 / 幅 2600 の窓がある → x 700..3300 が開口
  const wallLines = parsed.entities.filter(
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
  for (const e of parsed.entities) {
    for (const v of e.vertices ?? []) {
      assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y), `不正な座標 ${JSON.stringify(v)}`);
    }
  }
  assert.ok(parsed.header['$EXTMAX'].x > parsed.header['$EXTMIN'].x);
  assert.ok(parsed.header['$EXTMAX'].y > parsed.header['$EXTMIN'].y);
});

test('Unicode エスケープを選ぶと ASCII だけになる', () => {
  const plain = build({ escapeUnicode: false }).dxf;
  const escaped = build({ escapeUnicode: true }).dxf;
  assert.ok(/[^\x00-\x7F]/.test(plain), '通常出力には日本語がそのまま入る');
  assert.ok(!/[^\x00-\x7F]/.test(escaped), 'エスケープ時は ASCII だけになるべき');
  assert.ok(escaped.includes('\\U+'), 'エスケープ表記が見当たらない');
  // エスケープしても構造は壊れない
  assert.ok(parse(escaped).entities.length > 50);
});

test('ドアの開き軌跡が 90 度の円弧になっている', () => {
  const { scene, dxf } = build();
  const parsed = parse(dxf);
  const arcs = parsed.entities.filter((e) => e.type === 'ARC');
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
  for (const arc of parsed.entities.filter((e) => e.type === 'ARC')) {
    assert.ok(widths.has(Math.round(arc.radius)), `半径 ${arc.radius} に対応するドアがない`);
  }
});
