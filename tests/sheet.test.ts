import { test } from 'node:test';
import assert from 'node:assert/strict';
import DxfParser from 'dxf-parser';
import { sampleScene } from '../src/io/sample.ts';
import {
  centerSheetOn,
  defaultSheet,
  fitsInFrame,
  jisMargins,
  paperDimensions,
  sheetGeometry,
} from '../src/core/sheet.ts';
import { jisStandard } from '../src/core/standard.ts';
import { sceneBounds } from '../src/core/entity.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { sceneToDxf } from '../src/io/dxf.ts';
import { sceneToSvg } from '../src/io/svg.ts';
import { buildPrintDocument } from '../src/io/print.ts';
import { defaultSettings } from '../src/core/store.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { vec } from '../src/core/geometry.ts';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

test('用紙の実寸が向きで入れ替わる', () => {
  const std = jisStandard();
  assert.deepEqual(paperDimensions(std), { w: 420, h: 297 });
  assert.deepEqual(paperDimensions({ ...std, orientation: 'portrait' }), { w: 297, h: 420 });
});

test('余白は A0・A1 が 20mm、A2〜A4 が 10mm。とじ代は一律 20mm', () => {
  for (const id of ['A0', 'A1']) {
    assert.deepEqual(jisMargins(id), { binding: 20, top: 20, right: 20, bottom: 20 }, id);
  }
  for (const id of ['A2', 'A3', 'A4']) {
    assert.deepEqual(jisMargins(id), { binding: 20, top: 10, right: 10, bottom: 10 }, id);
  }
});

test('A3 横 1:100 の輪郭がワールド 39000 × 27700 になる', () => {
  const std = jisStandard(); // A3 / 1:100
  const g = sheetGeometry({ ...defaultSheet(), origin: vec(0, 0) }, std);
  // (420 - 20 とじ代 - 10 右) × 100
  assert.ok(near(g.frame.max.x - g.frame.min.x, 39000), `幅 ${g.frame.max.x - g.frame.min.x}`);
  // (297 - 10 - 10) × 100
  assert.ok(near(g.frame.max.y - g.frame.min.y, 27700), `高さ ${g.frame.max.y - g.frame.min.y}`);
  assert.ok(near(g.paper.max.x - g.paper.min.x, 42000));
  assert.ok(near(g.paper.max.y - g.paper.min.y, 29700));
});

test('尺度を変えると輪郭のワールド寸法が比例する', () => {
  const sheet = defaultSheet();
  const at100 = sheetGeometry(sheet, { ...jisStandard(), scale: 100 });
  const at50 = sheetGeometry(sheet, { ...jisStandard(), scale: 50 });
  assert.ok(near((at100.frame.max.x - at100.frame.min.x) / 2, at50.frame.max.x - at50.frame.min.x));
});

test('表題欄は輪郭内の右下に収まる', () => {
  const g = sheetGeometry(defaultSheet(), jisStandard());
  assert.ok(g.titleBox);
  assert.ok(near(g.titleBox!.max.x, g.frame.max.x), '右端が輪郭と揃っていない');
  assert.ok(near(g.titleBox!.min.y, g.frame.min.y), '下端が輪郭と揃っていない');
  assert.ok(g.titleBox!.min.x > g.frame.min.x, '輪郭からはみ出している');
  assert.ok(g.titleBox!.max.y < g.frame.max.y);
});

test('表題欄に尺度と記入事項が入る', () => {
  const sheet = defaultSheet();
  sheet.titleBlock.fields.drawingName = 'テスト住宅 平面図';
  sheet.titleBlock.fields.company = '株式会社テスト';
  const g = sheetGeometry(sheet, jisStandard());
  const texts = g.texts.map((t) => t.text);
  assert.ok(texts.includes('テスト住宅 平面図'));
  assert.ok(texts.includes('株式会社テスト'));
  assert.ok(texts.some((t) => t.includes('1:100')), `尺度が入っていない: ${texts}`);
  assert.ok(texts.includes('図面名称'), '項目名が入っていない');
});

test('表題欄を切ると罫線も文字も出ない', () => {
  const sheet = defaultSheet();
  sheet.titleBlock.enabled = false;
  const g = sheetGeometry(sheet, jisStandard());
  assert.equal(g.titleBox, null);
  assert.equal(g.rules.length, 0);
  assert.equal(g.texts.length, 0);
  assert.equal(g.frameOutline.length, 4, '輪郭線は残るはず');
});

test('用紙を図面の中央に合わせられる', () => {
  const scene = sampleScene();
  const bounds = sceneBounds(scene)!;
  const sheet = { ...defaultSheet(), origin: centerSheetOn(bounds, defaultSheet(), scene.standard) };
  const g = sheetGeometry(sheet, scene.standard);

  const frameCenter = vec((g.frame.min.x + g.frame.max.x) / 2, (g.frame.min.y + g.frame.max.y) / 2);
  const contentCenter = vec((bounds.min.x + bounds.max.x) / 2, (bounds.min.y + bounds.max.y) / 2);
  assert.ok(near(frameCenter.x, contentCenter.x, 1e-6), `${frameCenter.x} vs ${contentCenter.x}`);
  assert.ok(near(frameCenter.y, contentCenter.y, 1e-6));
});

test('収まらない尺度では、収まる尺度を提案する', () => {
  const scene = sampleScene();
  const bounds = sceneBounds(scene)!;
  const sheet = defaultSheet();

  // A3 1:100 なら 39000 x 27700 の枠。サンプル（約 9000 x 7000）は余裕で収まる
  assert.equal(fitsInFrame(bounds, sheet, scene.standard).fits, true);

  // 1:20 なら 7800 x 5540 しかないので収まらない
  const tight = fitsInFrame(bounds, sheet, { ...scene.standard, scale: 20 });
  assert.equal(tight.fits, false);
  assert.ok(tight.suggestedScale !== null && tight.suggestedScale > 20, `提案: ${tight.suggestedScale}`);
});

test('用紙枠が JSON 往復で保たれる', () => {
  const scene = sampleScene();
  scene.sheet.show = true;
  scene.sheet.origin = vec(-1000, -2000);
  scene.sheet.titleBlock.fields.designer = '設計 太郎';

  const restored = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.deepEqual(restored.sheet, scene.sheet);
});

test('用紙枠を持たない旧ファイルは既定値で読める', () => {
  const scene = deserialize({ nodes: {}, walls: {} });
  assert.deepEqual(scene.sheet, defaultSheet());
  assert.equal(scene.sheet.show, false, '既定では枠を出さない');
});

test('用紙枠を出すと SVG が用紙の実寸になり、尺度を変えても変わらない', () => {
  const scene = sampleScene();
  scene.sheet.show = true;
  const at100 = sceneToSvg(scene, [], defaultSettings());
  assert.ok(at100.includes('width="420mm"'), `A3 横の実寸になっていない: ${at100.slice(0, 200)}`);
  assert.ok(at100.includes('height="297mm"'));

  scene.standard.scale = 50;
  const at50 = sceneToSvg(scene, [], defaultSettings());
  assert.ok(at50.includes('width="420mm"'), '尺度を変えたら紙の実寸が変わってしまった');
});

test('用紙枠を出さなければ、これまで通り図面の範囲で書き出す', () => {
  const scene = sampleScene();
  const svg = sceneToSvg(scene, [], defaultSettings());
  assert.ok(!svg.includes('width="420mm"'));
});

test('用紙枠が DXF に出る', () => {
  const scene = sampleScene();
  scene.sheet.show = true;
  const parsed = new DxfParser().parseSync(sceneToDxf(scene, [], defaultSettings(), { escapeUnicode: false }))!;
  const sheetLayer = scene.layers[LAYER_IDS.sheet].name;
  const onSheet = parsed.entities.filter((e) => e.layer === sheetLayer);
  assert.ok(onSheet.filter((e) => e.type === 'LINE').length >= 4, '輪郭線が出ていない');
  assert.ok(onSheet.some((e) => e.type === 'TEXT' && e.text === '平面図'), '表題欄の文字が出ていない');
  // 図面範囲が用紙を含む
  assert.ok(parsed.header['$EXTMAX'].x >= scene.sheet.origin.x + 42000 - 1);
});

test('印刷用の HTML が用紙の実寸を指定する', () => {
  const std = jisStandard();
  const html = buildPrintDocument('<svg/>', std);
  assert.ok(html.includes('size: 420mm 297mm'), `@page が正しくない: ${html}`);
  assert.ok(html.includes('width: 420mm'));

  const portrait = buildPrintDocument('<svg/>', { ...std, orientation: 'portrait' });
  assert.ok(portrait.includes('size: 297mm 420mm'));
});
