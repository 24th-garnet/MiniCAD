import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '../src/core/id.ts';

test('接頭辞がそのまま頭に付く', () => {
  assert.ok(newId('w').startsWith('w'));
  assert.ok(newId('dim').startsWith('dim'));
});

test('乱数部は 36 進 12 桁', () => {
  const id = newId('n');
  assert.match(id.slice(1), /^[0-9a-z]{12}$/);
});

test('大量に作ってもぶつからない', () => {
  // 以前は「カウンタ＋乱数 4 桁」で、カウンタは再読み込みで 0 に戻っていた。
  // 別の端末で作った ID とぶつかると、選んだ仕上げが別のものに移る
  const n = 50_000;
  const seen = new Set<string>();
  for (let i = 0; i < n; i += 1) seen.add(newId('w'));
  assert.equal(seen.size, n, '同じ ID が 2 度出た');
});

test('36 文字すべてが乱数部に現れる（偏っていない）', () => {
  // 256 を 36 で割った余りをそのまま使うと 0〜3 だけ多く出る。
  // 捨てて引き直しているので、どの文字も出るはず
  const chars = new Set<string>();
  for (let i = 0; i < 5000; i += 1) {
    for (const c of newId('x').slice(1)) chars.add(c);
  }
  assert.equal(chars.size, 36, `出なかった文字がある: ${36 - chars.size} 種`);
});
