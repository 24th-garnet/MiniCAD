import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allFinite,
  choleskyDecompose,
  choleskySolve,
  maxAbs,
  norm2,
  normalEquations,
  trace,
  withDamping,
} from '../src/core/matrix.ts';

const mat = (rows: number[][]): Float64Array => Float64Array.from(rows.flat());

test('コレスキー分解が L·Lᵀ を復元する', () => {
  // 既知の対称正定値行列
  const n = 3;
  const a = mat([
    [4, 12, -16],
    [12, 37, -43],
    [-16, -43, 98],
  ]);
  const l = choleskyDecompose(a, n)!;
  assert.ok(l, '分解に失敗した');

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += l[i * n + k] * l[j * n + k];
      assert.ok(Math.abs(sum - a[i * n + j]) < 1e-9, `(${i},${j}) が一致しない`);
    }
  }
  // 上三角は 0 のまま
  assert.equal(l[0 * n + 1], 0);
  assert.equal(l[0 * n + 2], 0);
});

test('コレスキーで既知の解が再現できる', () => {
  const n = 3;
  const a = mat([
    [4, 12, -16],
    [12, 37, -43],
    [-16, -43, 98],
  ]);
  const x = Float64Array.from([1, -2, 3]);
  const b = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) b[i] += a[i * n + j] * x[j];
  }
  const got = choleskySolve(choleskyDecompose(a, n)!, n, b);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(got[i] - x[i]) < 1e-9, `x[${i}] = ${got[i]}`);
});

test('正定値でない行列では null を返す', () => {
  assert.equal(choleskyDecompose(mat([[0, 0], [0, 0]]), 2), null, 'ゼロ行列');
  assert.equal(choleskyDecompose(mat([[-1, 0], [0, 1]]), 2), null, '負の対角');
  // 特異（ランク落ち）。拘束が冗長なときに実際に出る形
  assert.equal(choleskyDecompose(mat([[1, 1], [1, 1]]), 2), null, '特異');
});

test('ダンピングを足せば特異な行列でも解ける', () => {
  // 冗長な拘束（同じ行が2本）の JᵀJ はランク落ちするが、λI で救われる
  const singular = mat([[1, 1], [1, 1]]);
  const damped = withDamping(singular, 2, 1e-3);
  const l = choleskyDecompose(damped, 2);
  assert.ok(l, 'ダンピング後も分解できない');
  // 元の行列は書き換わらない
  assert.equal(singular[0], 1);
});

test('正規方程式が JᵀJ と −Jᵀr を作る', () => {
  // J は 2x2、r は 2
  const j = mat([
    [1, 2],
    [3, 4],
  ]);
  const r = Float64Array.from([5, 6]);
  const { ata, atb } = normalEquations(j, r, 2, 2);

  // JᵀJ = [[10, 14], [14, 20]]
  assert.deepEqual([...ata], [10, 14, 14, 20]);
  // −Jᵀr = −[1*5 + 3*6, 2*5 + 4*6] = [−23, −34]
  assert.deepEqual([...atb], [-23, -34]);
});

test('正規方程式が対称になる', () => {
  const m = 5;
  const k = 4;
  const j = new Float64Array(m * k);
  for (let i = 0; i < j.length; i++) j[i] = Math.sin(i * 1.7) * 3;
  const { ata } = normalEquations(j, new Float64Array(m), m, k);
  for (let a = 0; a < k; a++) {
    for (let b = 0; b < k; b++) {
      assert.ok(Math.abs(ata[a * k + b] - ata[b * k + a]) < 1e-12, `(${a},${b})`);
    }
  }
});

test('小物（trace / norm2 / maxAbs / allFinite）', () => {
  assert.equal(trace(mat([[1, 9], [9, 5]]), 2), 6);
  assert.equal(norm2(Float64Array.from([3, 4])), 5);
  assert.equal(maxAbs(Float64Array.from([-7, 2, 5])), 7);
  assert.equal(allFinite(Float64Array.from([1, 2])), true);
  assert.equal(allFinite(Float64Array.from([1, NaN])), false);
  assert.equal(allFinite(Float64Array.from([Infinity])), false);
});
