import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCoordInput,
  resolveDelta,
  resolveLength,
  resolvePoint,
  type CoordInput,
} from '../src/core/coord-input.ts';
import { vec, type Vec } from '../src/core/geometry.ts';

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const nearPt = (a: Vec | null, b: Vec, eps = 1e-9) => a !== null && near(a.x, b.x, eps) && near(a.y, b.y, eps);

/** 受理する書式の一覧。実装と仕様をここで突き合わせる */
const ACCEPTED: [string, CoordInput][] = [
  ['3000', { kind: 'polar', length: 3000, angleDeg: null }],
  ['3000<45', { kind: 'polar', length: 3000, angleDeg: 45 }],
  ['@3000<45', { kind: 'polar', length: 3000, angleDeg: 45 }],
  ['3000<-90', { kind: 'polar', length: 3000, angleDeg: -90 }],
  ['1000,2000', { kind: 'absolute', point: vec(1000, 2000) }],
  ['@1000,2000', { kind: 'relative', delta: vec(1000, 2000) }],
  ['@-1000,-2000', { kind: 'relative', delta: vec(-1000, -2000) }],
  ['1000, 2000', { kind: 'absolute', point: vec(1000, 2000) }],
  ['１０００，２０００', { kind: 'absolute', point: vec(1000, 2000) }],
  ['0,0', { kind: 'absolute', point: vec(0, 0) }],
  ['2.5<0.5', { kind: 'polar', length: 2.5, angleDeg: 0.5 }],
  ['-3000', { kind: 'polar', length: -3000, angleDeg: null }],
];

const REJECTED = ['', '  ', '@', '<45', '3000<', 'abc', '1000,', ',2000', '0', '3000,45,10', '@@1000,0', '3000<<45'];

test('受理する書式', () => {
  for (const [text, expected] of ACCEPTED) {
    assert.deepEqual(parseCoordInput(text), expected, `「${text}」の解釈が違う`);
  }
});

test('弾く書式', () => {
  for (const text of REJECTED) {
    assert.equal(parseCoordInput(text), null, `「${text}」を受け入れてしまっている`);
  }
});

test('3000,45 は角度ではなく絶対座標として読む（破壊的変更）', () => {
  // 以前は「長さ3000・角度45度」だった。角度の区切りは `<` のみに統一した
  assert.deepEqual(parseCoordInput('3000,45'), { kind: 'absolute', point: vec(3000, 45) });
});

test('点を求める', () => {
  const base = vec(1000, 1000);
  assert.ok(nearPt(resolvePoint(parseCoordInput('3000,0')!, base, null), vec(3000, 0)), '絶対座標');
  assert.ok(nearPt(resolvePoint(parseCoordInput('@3000,0')!, base, null), vec(4000, 1000)), '相対直交');
  assert.ok(nearPt(resolvePoint(parseCoordInput('3000<90')!, base, null), vec(1000, 4000)), '相対極');
  assert.ok(nearPt(resolvePoint(parseCoordInput('3000')!, base, 90), vec(1000, 4000)), '角度省略');
});

test('基準点が無いと相対も極座標も解決できない', () => {
  assert.equal(resolvePoint(parseCoordInput('@1000,0')!, null, null), null);
  assert.equal(resolvePoint(parseCoordInput('3000<45')!, null, null), null);
  // 絶対座標だけは基準点なしで解決できる
  assert.ok(nearPt(resolvePoint(parseCoordInput('1000,2000')!, null, null), vec(1000, 2000)));
});

test('角度が省略されていて向きも分からなければ解決しない', () => {
  assert.equal(resolvePoint(parseCoordInput('3000')!, vec(0, 0), null), null);
});

test('変位を求める', () => {
  const base = vec(1000, 1000);
  assert.ok(nearPt(resolveDelta(parseCoordInput('@500,250')!, base, null), vec(500, 250)), '相対直交');
  // 絶対座標は「基準点からその点まで」
  assert.ok(nearPt(resolveDelta(parseCoordInput('3000,1000')!, base, null), vec(2000, 0)), '絶対座標');
  assert.ok(nearPt(resolveDelta(parseCoordInput('1000<0')!, base, null), vec(1000, 0)), '相対極');
});

test('長さを求める', () => {
  assert.equal(resolveLength(parseCoordInput('3000')!), 3000);
  assert.equal(resolveLength(parseCoordInput('3000<45')!), 3000);
  assert.ok(near(resolveLength(parseCoordInput('@300,400')!)!, 500), '直交は成分からの長さ');
});

test('負の長さは逆向きに進む', () => {
  assert.ok(nearPt(resolvePoint(parseCoordInput('-3000')!, vec(0, 0), 0), vec(-3000, 0)));
});
