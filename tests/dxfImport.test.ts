import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleScene } from '../src/io/sample.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { sceneToDxf } from '../src/io/dxf.ts';
import { defaultSettings } from '../src/core/store.ts';
import { emptyScene } from '../src/core/types.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { arcSweep, shapeVertices } from '../src/core/shapes.ts';
import { wallOutline } from '../src/core/shape.ts';
import { vec } from '../src/core/geometry.ts';
import { parseDxf } from '../src/io/dxfRead.ts';
import {
  bulgeToArc,
  defaultImportOptions,
  dxfToScene,
  formatReport,
  importDxfInto,
  unitScaleOf,
  type ImportOptions,
} from '../src/io/dxfImport.ts';

/** サンプル間取り → DXF → 取り込み、という往復を1本の関数に */
function roundTrip(overrides: Partial<ImportOptions> = {}, escapeUnicode = false) {
  const source = sampleScene();
  const dxf = sceneToDxf(source, detectRooms(source), defaultSettings(), { escapeUnicode });
  const doc = parseDxf(dxf);
  const target = emptyScene();
  const report = importDxfInto(target, doc, { ...defaultImportOptions(doc), ...overrides });
  return { source, doc, scene: target, report };
}

const shapesOf = (scene: ReturnType<typeof emptyScene>, kind: string) =>
  Object.values(scene.shapes).filter((s) => s.shape === kind);

test('往復しても壁の輪郭線の本数が合う', () => {
  const { source, scene } = roundTrip();
  const expected = Object.values(source.walls).reduce((n, w) => n + wallOutline(source, w).length, 0);
  const wallLayer = Object.values(scene.layers).find((l) => l.name === source.layers[LAYER_IDS.wall].name)!;
  const lines = shapesOf(scene, 'line').filter((s) => s.layerId === wallLayer.id);
  assert.equal(lines.length, expected);
});

test('画層はすべて既存の組み込み画層に吸収される', () => {
  const { scene, report } = roundTrip();
  assert.deepEqual(report.layersCreated, [], `新しい画層ができた: ${report.layersCreated.join(', ')}`);
  assert.ok(report.layersReused.length > 0);
  assert.equal(Object.keys(scene.layers).length, Object.keys(emptyScene().layers).length);
});

test('室名の文字高が紙 mm のまま戻る', () => {
  const { source, scene } = roundTrip();
  const ldk = shapesOf(scene, 'text').find((s) => s.shape === 'text' && s.text === 'LDK');
  assert.ok(ldk, 'LDK の文字が見つからない');
  if (ldk?.shape !== 'text') return;
  // DXF にはワールド mm で出ているので、尺度で割って紙 mm に戻せているかを見る
  assert.ok(Math.abs(ldk.height - source.standard.textHeight.room) < 1e-6, `文字高 ${ldk.height}`);
});

test('ドアの開き軌跡が 90 度のまま戻る（270 度になっていない）', () => {
  const { scene } = roundTrip();
  const arcs = shapesOf(scene, 'arc');
  assert.ok(arcs.length > 0, '円弧が戻っていない');
  for (const arc of arcs) {
    if (arc.shape !== 'arc') continue;
    assert.ok(Math.abs(arcSweep(arc) - Math.PI / 2) < 1e-6, `掃き角 ${(arcSweep(arc) * 180) / Math.PI} 度`);
  }
});

test('家具がブロック挿入として戻り、定義が増殖しない', () => {
  const { source, scene, report } = roundTrip();
  assert.equal(Object.keys(scene.instances).length, Object.keys(source.instances).length);
  assert.deepEqual(report.blocksCreated, [], `ブロック定義が増えた: ${report.blocksCreated.join(', ')}`);
  assert.equal(Object.keys(scene.blocks).length, Object.keys(emptyScene().blocks).length);

  // 挿入点と回転が元のインスタンスと一致する
  const byPos = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x - b.x || a.y - b.y;
  const before = Object.values(source.instances).sort(byPos);
  const after = Object.values(scene.instances).sort(byPos);
  for (let i = 0; i < before.length; i++) {
    assert.ok(Math.abs(before[i].x - after[i].x) < 1e-6 && Math.abs(before[i].y - after[i].y) < 1e-6);
    assert.ok(Math.abs(before[i].angle - after[i].angle) < 1e-6);
  }
});

test('日本語をエスケープして書き出しても室名が化けない', () => {
  const { scene } = roundTrip({}, true);
  const texts = shapesOf(scene, 'text').map((s) => (s.shape === 'text' ? s.text : ''));
  assert.ok(texts.includes('LDK'));
  assert.ok(texts.some((t) => /[^\x00-\x7f]/.test(t)), '日本語の室名が戻っていない');
});

test('寸法は匿名ブロックに入っていないので線と文字として戻る', () => {
  const { source, scene } = roundTrip();
  const dimLayerName = source.layers[LAYER_IDS.dimension].name;
  const layer = Object.values(scene.layers).find((l) => l.name === dimLayerName)!;
  const onDim = Object.values(scene.shapes).filter((s) => s.layerId === layer.id);
  assert.ok(onDim.length > 0, '寸法画層に何も乗っていない');
  assert.ok(onDim.some((s) => s.shape === 'text'));
});

// --- 取り込みの規則 --------------------------------------------------------

test('下図モードではすべて A-DRAFT に乗る', () => {
  const { scene, report } = roundTrip({ layerMode: 'draft' });
  assert.deepEqual(report.layersCreated, []);
  for (const shape of Object.values(scene.shapes)) assert.equal(shape.layerId, LAYER_IDS.draft);
});

test('同名の画層を再利用するとき、既存画層の色や線種を書き換えない', () => {
  const source = sampleScene();
  // 壁画層を赤・破線で書き出し、取り込み先の既定（黒・実線）が守られるかを見る
  source.layers[LAYER_IDS.wall].aci = 1;
  source.layers[LAYER_IDS.wall].lineType = 'dashed';
  const dxf = sceneToDxf(source, detectRooms(source), defaultSettings(), { escapeUnicode: false });
  const target = emptyScene();
  const before = { ...target.layers[LAYER_IDS.wall] };
  importDxfInto(target, parseDxf(dxf), defaultImportOptions(parseDxf(dxf)));
  assert.equal(target.layers[LAYER_IDS.wall].aci, before.aci);
  assert.equal(target.layers[LAYER_IDS.wall].lineType, before.lineType);
});

test('知らない画層は追加され、色と線種を引き継ぐ', () => {
  const dxf = [
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'LAYER',
    '0', 'LAYER', '2', '通り芯', '70', '0', '62', '5', '6', 'CENTER',
    '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '通り芯', '10', '0', '20', '0', '11', '1000', '21', '0',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\r\n');
  const doc = parseDxf(dxf);
  const { scene, report } = dxfToScene(doc, defaultImportOptions(doc));
  assert.deepEqual(report.layersCreated, ['通り芯']);
  const layer = Object.values(scene.layers).find((l) => l.name === '通り芯')!;
  assert.equal(layer.aci, 5);
  assert.equal(layer.lineType, 'center');
});

test('単位がメートルなら座標と文字高の両方に倍率が掛かる', () => {
  const dxf = [
    '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '2', '21', '0',
    '0', 'TEXT', '8', '0', '10', '0', '20', '0', '40', '0.5', '1', 'A',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\r\n');
  const doc = parseDxf(dxf);
  assert.equal(unitScaleOf(doc).scale, 1000);
  const { scene, report } = dxfToScene(doc, defaultImportOptions(doc));
  assert.match(report.unitNote ?? '', /メートル/);

  const line = Object.values(scene.shapes).find((s) => s.shape === 'line');
  assert.ok(line?.shape === 'line' && Math.abs(line.b.x - 2000) < 1e-6, '座標に倍率が掛かっていない');
  const text = Object.values(scene.shapes).find((s) => s.shape === 'text');
  // 0.5m = 500mm のワールド文字高。1:100 なら紙の上では 5mm
  assert.ok(text?.shape === 'text' && Math.abs(text.height - 5) < 1e-6, `文字高 ${text?.shape === 'text' ? text.height : '?'}`);
});

test('単位の指定が無ければ mm として読み、その旨をレポートに出す', () => {
  const doc = parseDxf(['0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF'].join('\n'));
  assert.equal(unitScaleOf(doc).scale, 1);
  assert.match(unitScaleOf(doc).note ?? '', /指定がありません/);
});

test('上限を超えると打ち切り、レポートに残す', () => {
  const { scene, report } = roundTrip({ maxEntities: 5 });
  assert.equal(report.truncated, true);
  assert.ok(Object.keys(scene.shapes).length + Object.keys(scene.instances).length <= 5 + 1);
  assert.ok(report.warnings.some((w) => w.includes('打ち切')));
});

test('原点寄せで図形の中心が原点に来る', () => {
  const { scene } = roundTrip({ recenter: true });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const shape of Object.values(scene.shapes)) {
    for (const p of shapeVertices(scene, shape)) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
  }
  assert.ok(Math.abs((minX + maxX) / 2) < 1, `中心 x = ${(minX + maxX) / 2}`);
  assert.ok(Math.abs((minY + maxY) / 2) < 1, `中心 y = ${(minY + maxY) / 2}`);
});

test('文字を取り込まない設定では文字が1つも入らない', () => {
  const { scene } = roundTrip({ importText: false });
  assert.equal(shapesOf(scene, 'text').length, 0);
});

test('読み飛ばした種別が理由つきでレポートに出る', () => {
  const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'SPLINE', '8', '0', '0', 'ENDSEC', '0', 'EOF'].join('\n');
  const doc = parseDxf(dxf);
  const { report } = dxfToScene(doc, defaultImportOptions(doc));
  assert.deepEqual(report.skipped, [{ kind: 'SPLINE', count: 1, reason: 'スプラインは未対応です' }]);
  assert.match(formatReport(report), /SPLINE 1 件（スプラインは未対応です）/);
});

// --- bulge ---------------------------------------------------------------

test('bulge 1.0 が半円になる', () => {
  const arc = bulgeToArc(vec(0, 0), vec(100, 0), 1)!;
  assert.ok(Math.abs(arc.center.x - 50) < 1e-9 && Math.abs(arc.center.y) < 1e-9);
  assert.ok(Math.abs(arc.radius - 50) < 1e-9);
  assert.ok(Math.abs(arcSweep({ ...arc, shape: 'arc', id: 'x', layerId: 'y' }) - Math.PI) < 1e-9);
});

test('bulge が負でも「常に反時計回り」の不変条件を保つ', () => {
  const up = bulgeToArc(vec(0, 0), vec(100, 0), 0.5)!;
  const down = bulgeToArc(vec(0, 0), vec(100, 0), -0.5)!;
  // 中心は弦の反対側に出る
  assert.ok(up.center.y > 0 && down.center.y < 0);
  for (const arc of [up, down]) {
    const sweep = arcSweep({ ...arc, shape: 'arc', id: 'x', layerId: 'y' });
    assert.ok(sweep > 0 && sweep < Math.PI * 2, `掃き角 ${sweep}`);
  }
});

test('bulge 付きのポリラインが線分と円弧に分かれる', () => {
  const body = [
    '0', 'LWPOLYLINE', '8', '0', '70', '0',
    '10', '0', '20', '0', '42', '0',
    '10', '100', '20', '0', '42', '1',
    '10', '200', '20', '0',
  ];
  const dxf = ['0', 'SECTION', '2', 'ENTITIES', ...body, '0', 'ENDSEC', '0', 'EOF'].join('\n');
  const doc = parseDxf(dxf);
  const { scene } = dxfToScene(doc, defaultImportOptions(doc));
  assert.equal(shapesOf(scene, 'line').length, 1);
  assert.equal(shapesOf(scene, 'arc').length, 1);
});

test('比が 1 の ELLIPSE は円になる', () => {
  const body = ['0', 'ELLIPSE', '8', '0', '10', '0', '20', '0', '11', '100', '21', '0', '40', '1', '41', '0', '42', '6.283185307179586'];
  const dxf = ['0', 'SECTION', '2', 'ENTITIES', ...body, '0', 'ENDSEC', '0', 'EOF'].join('\n');
  const doc = parseDxf(dxf);
  const { scene } = dxfToScene(doc, defaultImportOptions(doc));
  const circle = Object.values(scene.shapes)[0];
  assert.equal(circle?.shape, 'circle');
  if (circle?.shape === 'circle') assert.equal(circle.radius, 100);
});
