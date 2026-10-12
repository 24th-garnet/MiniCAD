import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCp932 } from '../src/io/cp932.ts';
import { emptyScene } from '../src/core/types.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { vec } from '../src/core/geometry.ts';
import { sceneToDxf } from '../src/io/dxf.ts';
import { defaultSettings } from '../src/core/store.ts';

const back = (bytes: Uint8Array) =>
  new TextDecoder('shift_jis').decode(bytes);

test('ASCII はそのまま 1 バイト', () => {
  const { bytes, dropped } = encodeCp932('AC1009');
  assert.equal(bytes.length, 6);
  assert.deepEqual(dropped, []);
  assert.equal(back(bytes), 'AC1009');
});

test('日本語は 2 バイトになり、復号すると戻る', () => {
  const { bytes, dropped } = encodeCp932('居室');
  assert.equal(bytes.length, 4);
  assert.deepEqual(dropped, []);
  assert.equal(back(bytes), '居室');
});

test('室名と表題欄に使う字が全部通る', () => {
  const words = '居室洋室和室浴室洗面脱衣所玄関廊下台所納戸物入縮尺図面名設計者株式会社';
  const { bytes, dropped } = encodeCp932(words);
  assert.deepEqual(dropped, [], `落ちた字: ${dropped.join('')}`);
  assert.equal(back(bytes), words);
});

test('面積の単位記号が通る', () => {
  // 平米の組文字は NEC 拡張にある
  const { dropped } = encodeCp932('12.34㎡');
  assert.deepEqual(dropped, []);
});

test('収まらない字は ? になり、黙って落とさず拾って返す', () => {
  // 絵文字は Shift-JIS に無い
  const { bytes, dropped } = encodeCp932('居室🏠');
  assert.deepEqual(dropped, ['🏠']);
  assert.ok(back(bytes).startsWith('居室'));
  assert.ok(back(bytes).endsWith('?'));
});

test('符号化表は同梱せず復号器から起こす', async () => {
  // データを持っていれば、ファイルに数千の対応が並ぶはず
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../src/io/cp932.ts', import.meta.url), 'utf8');
  assert.ok(src.length < 4000, `表を同梱している疑い: ${src.length} 文字`);
  assert.ok(src.includes('TextDecoder'));
});

// --- DXF への反映 --------------------------------------------------------

function dxfOf(shiftJis: boolean): string {
  const scene = emptyScene();
  const ids = [vec(0, 0), vec(4000, 0), vec(4000, 3000), vec(0, 3000)]
    .map((p) => findOrCreateNode(scene, p));
  for (let i = 0; i < 4; i++) addWall(scene, ids[i], ids[(i + 1) % 4], 100);
  const rooms = detectRooms(scene);
  rooms[0].name = '居室';
  return sceneToDxf(scene, rooms, defaultSettings(), {
    escapeUnicode: false, trueDimension: true, shiftJis,
  });
}

test('文字コードを宣言する', () => {
  assert.ok(dxfOf(false).includes('$DWGCODEPAGE'));
});

test('宣言と中身を食い違わせない', () => {
  // 受け手はこの宣言を見て読み方を決める
  assert.ok(dxfOf(true).includes('ANSI_932'));
  assert.ok(dxfOf(false).includes('UTF-8'));
  assert.ok(!dxfOf(false).includes('ANSI_932'));
});

test('Shift-JIS で書いた DXF が Jw_cad の読み方で戻る', () => {
  const { bytes, dropped } = encodeCp932(dxfOf(true));
  assert.deepEqual(dropped, [], `落ちた字: ${dropped.join('')}`);
  const text = back(bytes);
  assert.ok(text.includes('ANSI_932'));
  assert.ok(text.includes('居室'), '室名が化けた');
});
