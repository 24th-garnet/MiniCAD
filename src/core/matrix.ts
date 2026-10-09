/**
 * 拘束ソルバ専用の、小さな密行列。
 *
 * 解く線形系は `(JᵀJ + λI) δ = −Jᵀr` ただ一つで、λ > 0 を足した時点で
 * **対称正定値**が保証される。だからコレスキー分解だけで足り、
 * LU も QR も SVD も要らない（ピボット選択が不要で、LU の半分の演算量で、
 * 失敗＝負のピボットがそのまま「数値的に危ない」のシグナルになる）。
 *
 * 行列はすべて**行優先**の `Float64Array`。`a[row * n + col]` で引く。
 * 一時オブジェクトなので `Scene` には入らず、`structuredClone` の対象外。
 */

/** m×k の行列から正規方程式を作る。`atb` は **−Jᵀr**（そのまま解けば増分になる） */
export function normalEquations(
  j: Float64Array,
  r: Float64Array,
  m: number,
  k: number,
): { ata: Float64Array; atb: Float64Array } {
  const ata = new Float64Array(k * k);
  const atb = new Float64Array(k);

  for (let row = 0; row < m; row++) {
    const base = row * k;
    const ri = r[row];
    for (let c = 0; c < k; c++) {
      const jc = j[base + c];
      if (jc === 0) continue;
      atb[c] -= jc * ri;
      // 対称なので上三角だけ埋めて、あとで写す
      for (let d = c; d < k; d++) ata[c * k + d] += jc * j[base + d];
    }
  }
  for (let c = 0; c < k; c++) {
    for (let d = c + 1; d < k; d++) ata[d * k + c] = ata[c * k + d];
  }
  return { ata, atb };
}

/** 対角の和。λ の初期値をスケールに追従させるために使う */
export function trace(a: Float64Array, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i * n + i];
  return sum;
}

/** 対角に λ を足す（破壊的ではなく複製を返す。λ の付け替えを何度も試すため） */
export function withDamping(a: Float64Array, n: number, lambda: number): Float64Array {
  const out = Float64Array.from(a);
  for (let i = 0; i < n; i++) out[i * n + i] += lambda;
  return out;
}

/**
 * 対称正定値行列を `A = L Lᵀ` に分解する。下三角を行優先で返す。
 * 正定値でない・非有限が出たときは null（呼び出し側が λ を上げて再試行する）。
 */
export function choleskyDecompose(a: Float64Array, n: number): Float64Array | null {
  const l = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i * n + j];
      for (let k = 0; k < j; k++) sum -= l[i * n + k] * l[j * n + k];
      if (i === j) {
        if (!(sum > 1e-300)) return null;
        l[i * n + j] = Math.sqrt(sum);
      } else {
        l[i * n + j] = sum / l[j * n + j];
      }
      if (!Number.isFinite(l[i * n + j])) return null;
    }
  }
  return l;
}

/** `L Lᵀ x = b` を前進・後退代入で解く */
export function choleskySolve(l: Float64Array, n: number, b: Float64Array): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= l[i * n + k] * y[k];
    y[i] = sum / l[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= l[k * n + i] * x[k];
    x[i] = sum / l[i * n + i];
  }
  return x;
}

export function norm2(v: Float64Array): number {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}

export function maxAbs(v: Float64Array): number {
  let best = 0;
  for (const x of v) {
    const a = Math.abs(x);
    if (a > best) best = a;
  }
  return best;
}

export const allFinite = (v: Float64Array): boolean => v.every(Number.isFinite);
