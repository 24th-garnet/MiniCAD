import { dxfOpts, oracleEntities, parseDxfOracle } from './dxf-oracle.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleScene } from '../src/io/sample.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { sceneToDxf } from '../src/io/dxf.ts';
import { defaultSettings } from '../src/core/store.ts';
import { parseDxf, parseDxfBytes, stripMtextFormat } from '../src/io/dxfRead.ts';
import { decodeDxf, DxfFormatError, readTags, splitRecords, splitSections } from '../src/io/dxfTags.ts';

function exported(options = dxfOpts()) {
  const scene = sampleScene();
  return sceneToDxf(scene, detectRooms(scene), defaultSettings(), options);
}

/** 最小の DXF を組む。エンティティ単体の検証用 */
function wrap(body: string): string {
  return ['0', 'SECTION', '2', 'ENTITIES', body.trim(), '0', 'ENDSEC', '0', 'EOF'].join('\r\n');
}

// --- タグ層 ---------------------------------------------------------------

test('CRLF と LF が混ざっていても読める', () => {
  const tags = readTags('0\r\nSECTION\n2\nENTITIES\r\n');
  assert.deepEqual(tags, [
    { code: 0, value: 'SECTION' },
    { code: 2, value: 'ENTITIES' },
  ]);
});

test('コメント(999)と壊れた行を捨てる', () => {
  const tags = readTags('999\nメモ\n0\nLINE\nxx\nyy\n');
  assert.deepEqual(tags, [{ code: 0, value: 'LINE' }]);
});

test('末尾が EOF で終わっていなくても例外を投げない', () => {
  const doc = parseDxf(['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', 'A', '10', '0', '20'].join('\n'));
  assert.equal(doc.entities.length, 0);
});

test('UTF-8 の BOM を剥いで読む', () => {
  const body = new TextEncoder().encode('0\nSECTION\n');
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
  assert.equal(decodeDxf(bytes), '0\nSECTION\n');
});

test('$DWGCODEPAGE が ANSI_932 なら Shift_JIS として読む', () => {
  // 「居間」= Shift_JIS で 0x8B 0x8F 0x8A 0xD4
  const head = '0\nSECTION\n2\nHEADER\n9\n$DWGCODEPAGE\n3\nANSI_932\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nTEXT\n1\n';
  const bytes = new Uint8Array([
    ...[...head].map((c) => c.charCodeAt(0)),
    0x8b, 0x8f, 0x8a, 0xd4,
    ...[...'\n0\nENDSEC\n'].map((c) => c.charCodeAt(0)),
  ]);
  assert.match(decodeDxf(bytes), /居間/);
});

test('文字コードの指定が無ければ UTF-8、壊れていれば Shift_JIS に落ちる', () => {
  assert.match(decodeDxf(new TextEncoder().encode('0\n寝室\n')), /寝室/);
  assert.match(decodeDxf(new Uint8Array([0x30, 0x0a, 0x8b, 0x8f, 0x8a, 0xd4, 0x0a])), /居間/);
});

test('バイナリ DXF は明示的に断る', () => {
  const bytes = new TextEncoder().encode('AutoCAD Binary DXF\r\n\x1a\x00');
  assert.throws(() => decodeDxf(bytes), DxfFormatError);
});

test('MiniCAD 自身が書いた \\U+XXXX エスケープを復号する', () => {
  const doc = parseDxf(exported(dxfOpts({ escapeUnicode: true })));
  const texts = doc.entities.filter((e) => e.kind === 'TEXT');
  assert.ok(texts.some((t) => t.kind === 'TEXT' && t.text.includes('LDK')), 'LDK が戻らない');
  assert.ok(
    texts.some((t) => t.kind === 'TEXT' && /[^\x00-\x7f]/.test(t.text)),
    'エスケープされた日本語が戻っていない',
  );
});

// --- dxf-parser との差分（自前の思い込み対策） -----------------------------

test('自前パーサと dxf-parser でエンティティの種別内訳が一致する', () => {
  const dxf = exported();
  const mine = parseDxf(dxf);
  const theirs = parseDxfOracle(dxf);

  const tally = (types: string[]) => {
    const m = new Map<string, number>();
    for (const t of types) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort();
  };
  assert.deepEqual(tally(mine.entities.map((e) => e.kind)), tally(theirs.entities.map((e) => e.type)));
});

test('自前パーサと dxf-parser で LINE の座標が一致する', () => {
  const dxf = exported();
  const mine = parseDxf(dxf).entities.filter((e) => e.kind === 'LINE');
  const theirs = oracleEntities(parseDxfOracle(dxf)).filter((e) => e.type === 'LINE');
  assert.equal(mine.length, theirs.length);
  for (let i = 0; i < mine.length; i++) {
    const a = mine[i];
    const b = theirs[i];
    if (a.kind !== 'LINE') continue;
    assert.ok(Math.abs(a.a.x - b.vertices[0].x) < 1e-6 && Math.abs(a.a.y - b.vertices[0].y) < 1e-6);
    assert.ok(Math.abs(a.b.x - b.vertices[1].x) < 1e-6 && Math.abs(a.b.y - b.vertices[1].y) < 1e-6);
  }
});

test('自前パーサと dxf-parser で ARC の中心・半径・角度が一致する', () => {
  const dxf = exported();
  const mine = parseDxf(dxf).entities.filter((e) => e.kind === 'ARC');
  const theirs = oracleEntities(parseDxfOracle(dxf)).filter((e) => e.type === 'ARC');
  assert.ok(mine.length > 0, '円弧が1つも出ていない');
  assert.equal(mine.length, theirs.length);
  for (let i = 0; i < mine.length; i++) {
    const a = mine[i];
    const b = theirs[i];
    if (a.kind !== 'ARC') continue;
    assert.ok(Math.abs(a.center.x - b.center.x) < 1e-6 && Math.abs(a.center.y - b.center.y) < 1e-6);
    assert.ok(Math.abs(a.radius - b.radius) < 1e-6);
    // dxf-parser はラジアンに直して返す
    assert.ok(Math.abs((a.startDeg * Math.PI) / 180 - b.startAngle) < 1e-6);
    assert.ok(Math.abs((a.endDeg * Math.PI) / 180 - b.endAngle) < 1e-6);
  }
});

test('自前パーサと dxf-parser で画層テーブルが一致する', () => {
  const dxf = exported();
  const mine = parseDxf(dxf).layers;
  const theirs = parseDxfOracle(dxf).tables.layer.layers;
  assert.deepEqual([...mine.keys()].sort(), Object.keys(theirs).sort());
  for (const [name, layer] of mine) {
    assert.equal(layer.aci, Math.abs((theirs[name] as { colorIndex: number }).colorIndex), name);
  }
});

test('自前パーサと dxf-parser でブロック定義が一致する', () => {
  const dxf = exported();
  const mine = parseDxf(dxf).blocks;
  const theirs = parseDxfOracle(dxf).blocks;
  assert.ok(mine.size > 0, 'ブロックが1つも出ていない');
  assert.deepEqual([...mine.keys()].sort(), Object.keys(theirs).sort());
});

// --- エンティティ単体 -----------------------------------------------------

test('押し出し方向 z = -1 の ARC を鏡像として正規化する', () => {
  const doc = parseDxf(
    wrap(['0', 'ARC', '8', 'A', '10', '100', '20', '0', '40', '50', '50', '0', '51', '90', '230', '-1'].join('\n')),
  );
  const arc = doc.entities[0];
  assert.equal(arc?.kind, 'ARC');
  if (arc.kind !== 'ARC') return;
  assert.equal(arc.center.x, -100);
  assert.equal(arc.startDeg, 90); // 180 - 終了角 90
  assert.equal(arc.endDeg, 180); // 180 - 開始角 0
});

test('LWPOLYLINE の bulge と閉じフラグを拾う', () => {
  const doc = parseDxf(
    wrap(['0', 'LWPOLYLINE', '8', 'A', '70', '1', '10', '0', '20', '0', '42', '1', '10', '100', '20', '0'].join('\n')),
  );
  const pl = doc.entities[0];
  assert.equal(pl?.kind, 'LWPOLYLINE');
  if (pl.kind !== 'LWPOLYLINE') return;
  assert.equal(pl.closed, true);
  assert.equal(pl.vertices.length, 2);
  assert.equal(pl.vertices[0].bulge, 1);
});

test('POLYLINE + VERTEX を読み、3D ポリラインは捨てる', () => {
  const planar = ['0', 'POLYLINE', '8', 'A', '70', '0', '0', 'VERTEX', '10', '0', '20', '0', '0', 'VERTEX', '10', '10', '20', '0', '0', 'SEQEND'];
  assert.equal(parseDxf(wrap(planar.join('\n'))).entities.length, 1);

  const mesh = ['0', 'POLYLINE', '8', 'A', '70', '64', '0', 'VERTEX', '10', '0', '20', '0', '0', 'SEQEND'];
  const doc = parseDxf(wrap(mesh.join('\n')));
  assert.equal(doc.entities.length, 0);
  assert.equal(doc.skipped.get('POLYLINE'), 1);
});

test('TEXT の 72 / 73 で挿入点と揃えを決める', () => {
  const baseline = ['0', 'TEXT', '8', 'A', '10', '0', '20', '0', '40', '100', '1', 'ABC'];
  const t1 = parseDxf(wrap(baseline.join('\n'))).entities[0];
  assert.equal(t1?.kind, 'TEXT');
  if (t1.kind !== 'TEXT') return;
  assert.equal(t1.align, 'left');
  assert.equal(t1.at.y, 50); // ベースライン → 縦中央へ半文字分ずらす

  const centered = ['0', 'TEXT', '8', 'A', '10', '0', '20', '0', '11', '500', '21', '300', '40', '100', '72', '1', '73', '2', '1', 'ABC'];
  const t2 = parseDxf(wrap(centered.join('\n'))).entities[0];
  assert.equal(t2?.kind, 'TEXT');
  if (t2.kind !== 'TEXT') return;
  assert.equal(t2.align, 'center');
  assert.deepEqual({ x: t2.at.x, y: t2.at.y }, { x: 500, y: 300 }); // 72/73 があるので 11/21 が挿入点
});

test('SOLID の頂点を 10,11,13,12 の順に回して輪郭にする', () => {
  const body = ['0', 'SOLID', '8', 'A', '10', '0', '20', '0', '11', '10', '21', '0', '12', '0', '22', '10', '13', '10', '23', '10'];
  const solid = parseDxf(wrap(body.join('\n'))).entities[0];
  assert.equal(solid?.kind, 'SOLID');
  if (solid.kind !== 'SOLID') return;
  assert.deepEqual(
    solid.points.map((p) => [p.x, p.y]),
    [[0, 0], [10, 0], [10, 10], [0, 10]],
  );
});

test('未対応のエンティティは skipped に積まれる', () => {
  const doc = parseDxf(wrap(['0', 'SPLINE', '8', 'A', '0', 'HATCH', '8', 'A'].join('\n')));
  assert.equal(doc.entities.length, 0);
  assert.equal(doc.skipped.get('SPLINE'), 1);
  assert.equal(doc.skipped.get('HATCH'), 1);
});

test('MTEXT の書式コードを剥ぎ、\\P を改行にする', () => {
  assert.equal(stripMtextFormat('{\\fMS Gothic|b0;洋室}\\P4.5帖'), '洋室\n4.5帖');
  assert.equal(stripMtextFormat('45%%d'), '45°');
});

// --- セクション ----------------------------------------------------------

test('セクションとレコードに切り分けられる', () => {
  const sections = splitSections(readTags(exported()));
  assert.deepEqual([...sections.keys()], ['HEADER', 'TABLES', 'BLOCKS', 'ENTITIES']);
  assert.ok(splitRecords(sections.get('ENTITIES')!).length > 50);
});

test('バイト列からそのまま読める', () => {
  const doc = parseDxfBytes(new TextEncoder().encode(exported()));
  assert.ok(doc.entities.length > 50);
  assert.equal(doc.warnings.length, 0);
});

test('AutoCAD 2018 形式（ハンドル・サブクラスマーカ付き）も読める', () => {
  // R12 には無い 5(ハンドル) / 330(所有者) / 100(サブクラスマーカ) / 370(線幅) が差し込まれた形
  const dxf = [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1032',
    '9', '$INSUNITS', '70', '4',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'LAYER', '5', '2', '330', '0', '100', 'AcDbSymbolTable', '70', '1',
    '0', 'LAYER', '5', '10', '330', '2', '100', 'AcDbSymbolTableRecord', '100', 'AcDbLayerTableRecord',
    '2', 'S-WALL', '70', '0', '62', '3', '6', 'ByLayer', '370', '25',
    '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LWPOLYLINE', '5', '1A2', '330', '1F', '100', 'AcDbEntity', '8', 'S-WALL',
    '100', 'AcDbPolyline', '90', '3', '70', '0', '43', '0',
    '10', '0', '20', '0', '10', '1000', '20', '0', '10', '1000', '20', '500',
    '0', 'MTEXT', '5', '1A3', '100', 'AcDbEntity', '8', 'S-WALL', '100', 'AcDbMText',
    '10', '500', '20', '250', '30', '0', '40', '250', '71', '5', '1', '洋室\\P6.0帖',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\r\n');

  const doc = parseDxf(dxf);
  assert.equal(doc.skipped.size, 0, `読み飛ばしがある: ${[...doc.skipped.keys()].join(', ')}`);
  assert.equal(doc.layers.get('S-WALL')?.aci, 3);

  const pl = doc.entities.find((e) => e.kind === 'LWPOLYLINE');
  assert.ok(pl && pl.kind === 'LWPOLYLINE' && pl.vertices.length === 3, 'ハンドル入りの LWPOLYLINE が読めない');

  const mtext = doc.entities.find((e) => e.kind === 'MTEXT');
  assert.ok(mtext?.kind === 'MTEXT' && mtext.text === '洋室\n6.0帖');
  assert.equal(mtext.kind === 'MTEXT' ? mtext.align : null, 'center'); // 71 = 5 は中央
});
