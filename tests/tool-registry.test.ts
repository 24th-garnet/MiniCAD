import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools, TOOL_REGISTRY } from '../src/ui/tool-registry.ts';
import { MODES, type Mode } from '../src/ui/mode.ts';
import { defaultCapabilities } from '../src/host.ts';

const ALL = defaultCapabilities();
const VIEW_ONLY = { ...ALL, edit: false };
import type { ToolId } from '../src/tools/tool.ts';

test('表のキーとツール自身の id が一致する', () => {
  // **ここが食い違うと静かに壊れる。** `Editor.registerTool` は `tool.id` で
  // 登録するので、表のキーが `copy` なのに中身が回転なら、ツールバーの
  // 複写ボタンが何も選ばない。型は `make(mode): Tool` としか言っていない。
  // **モードで中身が変わるものがある**ので、両方で見る
  for (const mode of MODES) {
    for (const [id, entry] of Object.entries(TOOL_REGISTRY)) {
      assert.equal(entry.make(mode).id, id, `${mode}: ${id} の欄が別のツールを作っている`);
    }
  }
});

test('ツールバーの並びは表のキーの順', () => {
  // プロモードは今のところ全部出る。並びが表の順であることを見ている
  const ids = buildTools('pro', ALL).map((t) => t.id);
  assert.deepEqual(ids, Object.keys(TOOL_REGISTRY) as ToolId[]);
  assert.equal(new Set(ids).size, ids.length, '同じツールが二度出ている');
});

test('どのモードでも選択ツールは出る', () => {
  // 消えると `Editor.setTools` の逃げ先が無くなる
  for (const mode of MODES) {
    assert.ok(buildTools(mode, ALL).some((t) => t.id === 'select'), `${mode} に選択ツールが無い`);
  }
});

test('通常モードはプロモードの部分集合', () => {
  // **プロは通常を狭めない。** ワイヤーは字義どおりならプロから壁を外すが、
  // 代わりに入るはずの汎用ソリッドがまだ無いので、外すと空のモードになる
  const pro = new Set(buildTools('pro', ALL).map((t) => t.id));
  for (const tool of buildTools('normal', ALL)) {
    assert.ok(pro.has(tool.id), `${tool.id} が通常にだけある`);
  }
  assert.ok(buildTools('normal', ALL).length < pro.size, '通常とプロで何も変わらない');
});

test('どのモードにも属さないツールが無い', () => {
  for (const [id, entry] of Object.entries(TOOL_REGISTRY)) {
    assert.ok(entry.modes.length > 0, `${id} がどのモードにも出ない`);
  }
});

test('ショートカットが重なっていない', () => {
  // 重なると後ろのツールに切り替えられなくなる。今まで誰も見ていなかった
  const seen = new Map<string, string>();
  for (const tool of buildTools('pro', ALL)) {
    // **キーを持たないツールがあってよい。** A〜Z が全部埋まっていて、
    // 指の記憶で呼ぶものでなければ、ツールバーのボタンだけで足りる
    if (tool.shortcut === '') continue;
    const key = tool.shortcut.toLowerCase();
    const other = seen.get(key);
    assert.equal(other, undefined, `${key} が ${other} と ${tool.id} で重なっている`);
    seen.set(key, tool.id);
  }
});

test('キーを持たないツールも、ツールバーからは選べる', () => {
  const keyless = buildTools('pro', ALL).filter((t) => t.shortcut === '');
  for (const tool of keyless) {
    assert.ok(TOOL_REGISTRY[tool.id], `${tool.id} が表に無い`);
    assert.ok(TOOL_REGISTRY[tool.id].glyph.length > 0, `${tool.id} に絵記号が無い`);
  }
});

test('グリフと表示名が全部入っている', () => {
  for (const mode of MODES) {
    for (const [id, entry] of Object.entries(TOOL_REGISTRY)) {
      assert.ok(entry.glyph.length > 0, `${id} のグリフが空`);
      const tool = entry.make(mode);
      assert.ok(tool.label.length > 0, `${mode}: ${id} の表示名が空`);
      assert.ok(tool.cursor.length > 0, `${mode}: ${id} のカーソルが空`);
    }
  }
});

test('閲覧のみでは図面を書き換えるツールが出ない', () => {
  // **画面から消すのは行き止まりを減らすためで、保証ではない。**
  // 保証は `Store.readOnly` が掛ける（`tests/store.test.ts`）
  for (const mode of MODES) {
    const ids = buildTools(mode, VIEW_ONLY).map((t) => t.id);
    for (const id of ids) {
      assert.equal(TOOL_REGISTRY[id].edits, false, `${id} は図面を書き換えるのに閲覧のみで出ている`);
    }
    assert.ok(ids.includes('select'), `${mode} に選択ツールが無い`);
  }
});

test('残るものを作るツールは「書き換える」と言っている', () => {
  // **ここが腐りやすい。** 計測は Phase 5 で `commit` を呼ぶようになったが、
  // 表は「書き換えない」のままだった。出したまま `Store.readOnly` に弾かれると、
  // 測っても何も残らない行き止まりになる
  for (const [id, entry] of Object.entries(TOOL_REGISTRY)) {
    if (!entry.edits) {
      assert.ok(
        ['select', 'comment'].includes(id),
        `${id} が「書き換えない」と言っている。本当に Store を触らないか確かめること`,
      );
    }
  }
});

test('コメントは comment の権限で出し分ける', () => {
  const noComment = { ...ALL, comment: false };
  assert.ok(buildTools('normal', ALL).some((t) => t.id === 'comment'));
  assert.ok(!buildTools('normal', noComment).some((t) => t.id === 'comment'));
  // **編集できなくてもコメントは置ける。** 図面を変えないので
  assert.ok(buildTools('normal', VIEW_ONLY).some((t) => t.id === 'comment'));
});

/**
 * モードで出し分ける種類（22 段）。
 *
 * ワイヤーは 4 枚でモードを分けている——**5/6 が 3D（プロ／通常）、
 * 7/8 が 2D（プロ／通常）**。長い作図一覧は 7 枚目（プロの 2D）だけのもので、
 * 8 枚目（通常の 2D）が求めているのは「ペイント：直線 / 矩形 / 曲線 /
 * 外部領域」の 4 つ。**ここを読み違えて、矩形と曲線をプロ専用にしていた。**
 */

const kindsOf = (mode: Mode, id: string): readonly string[] => {
  const tool = buildTools(mode, ALL).find((t) => t.id === id);
  assert.ok(tool, `${mode} に ${id} が出ていない`);
  return (tool as unknown as { kinds: readonly string[] }).kinds;
};

test('通常モードの作図はペイントの 2 つだけ、プロは 7 つ', () => {
  // 直線は `line` ツールが受け持つので、ここには入らない
  assert.deepEqual(kindsOf('normal', 'shape'), ['rect', 'spline']);
  assert.equal(kindsOf('pro', 'shape').length, 7);
  // プロは通常の上位集合。狭めていないことを見る
  for (const k of kindsOf('normal', 'shape')) {
    assert.ok(kindsOf('pro', 'shape').includes(k), `プロから ${k} が消えている`);
  }
});

test('通常モードの角ツールは結合だけ、プロは 3 つ', () => {
  // ワイヤー 7 枚目「例）壁、円弧壁、壁結合などは、通常モードを利用する前提」
  assert.deepEqual(kindsOf('normal', 'corner'), ['join']);
  assert.deepEqual(kindsOf('pro', 'corner'), ['fillet', 'chamfer', 'join']);
});

test('種類が 1 つだけのときは「種類」の欄を出さない', () => {
  const tool = buildTools('normal', ALL).find((t) => t.id === 'corner')!;
  const selects = (tool.options?.({} as never) ?? []).filter((f) => f.kind === 'select');
  assert.equal(selects.length, 0, '選ぶものが無いのに欄が出ている');
});

test('通常モードでも名前が中身と合っている', () => {
  // 「角」という名前で結合しかしない道具は嘘になる
  const normal = buildTools('normal', ALL).find((t) => t.id === 'corner')!;
  const pro = buildTools('pro', ALL).find((t) => t.id === 'corner')!;
  assert.equal(normal.label, '結合');
  assert.equal(pro.label, '角');
});

test('ワイヤー 8 枚目のペイントが通常モードで描ける', () => {
  // **道具の名前では見ない。** どう分けても、描ける形が揃っていればよい
  const drawable = new Set<string>();
  for (const tool of buildTools('normal', ALL)) {
    const kinds = (tool as unknown as { kinds?: readonly string[] }).kinds;
    if (kinds) for (const k of kinds) drawable.add(k);
  }
  for (const [kind, name] of [
    ['line', '直線'],
    ['rect', '矩形'],
    ['spline', '曲線'],
  ] as const) {
    assert.ok(drawable.has(kind), `通常モードで${name}が描けない`);
  }
  // 外部領域はまだ無い。**描けないものを「描ける」と言わない**ための控え
  assert.equal(drawable.has('outerArea' as string), false);
});
