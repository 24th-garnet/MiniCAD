import { rotate, vec, type Vec } from './geometry.ts';
import { rotation, translation } from './transform.ts';
import { transformEntities } from './transformOps.ts';
import type { EntityRef, Scene } from './types.ts';

/**
 * 配列複写。**3D のソリッドとは無関係で、2D でも 3D でも同じものが動く。**
 *
 * ワイヤーの 5 枚目は「行・列の格子状や、円周上に、規則正しくオブジェクトを
 * 複数配置・複製」と書いていて、3D 作図の節に並んでいるが、
 * **汎用ソリッドは要らない**。`transformEntities(..., { copy: true })` を
 * 繰り返し呼ぶだけで済む。
 *
 * **元は動かさない。** 複写なので、1 つめは元のまま。
 */

export interface GridArray {
  kind: 'grid';
  /** 行数・列数。どちらも 1 以上で、1×1 なら何も増えない */
  rows: number;
  cols: number;
  /** 行と列の間隔 (mm)。負なら逆向き */
  rowStep: number;
  colStep: number;
  /** 列が伸びる向き（ラジアン）。行はその直角 */
  angle: number;
}

export interface RadialArray {
  kind: 'radial';
  center: Vec;
  /** 元を含めた総数。2 以上 */
  count: number;
  /** 全体で回す角（ラジアン）。2π なら等間隔に一周する */
  sweep: number;
}

/**
 * **向きを変えずに円周上へ並べることはできない。**
 *
 * `transformEntities` は選択全体に 1 つの変換をかける造りで、
 * 「位置だけ回して向きは保つ」は実体ごとに違う平行移動になるため、
 * 1 つの変換では表せない。ベクターワークスにはこの選択肢があるが、
 * 入れるなら複写の受け皿から作ることになる。
 */

export type ArrayCopy = GridArray | RadialArray;

/** 1 つめ（＝元）を除いた、置く先の変換の列 */
function stepsOf(spec: ArrayCopy): { kind: 'move'; delta: Vec }[] | { kind: 'turn'; angle: number }[] {
  if (spec.kind === 'grid') {
    const out: { kind: 'move'; delta: Vec }[] = [];
    for (let r = 0; r < Math.max(1, Math.round(spec.rows)); r++) {
      for (let c = 0; c < Math.max(1, Math.round(spec.cols)); c++) {
        if (r === 0 && c === 0) continue;
        // 列は `angle` の向き、行はその直角
        const along = rotate(vec(spec.colStep * c, 0), spec.angle);
        const across = rotate(vec(0, spec.rowStep * r), spec.angle);
        out.push({ kind: 'move', delta: vec(along.x + across.x, along.y + across.y) });
      }
    }
    return out;
  }
  const n = Math.max(2, Math.round(spec.count));
  // 一周なら n 等分、それ以外は端から端まで n-1 等分
  const full = Math.abs(Math.abs(spec.sweep) - Math.PI * 2) < 1e-9;
  const step = spec.sweep / (full ? n : n - 1);
  const out: { kind: 'turn'; angle: number }[] = [];
  for (let i = 1; i < n; i++) out.push({ kind: 'turn', angle: step * i });
  return out;
}

/**
 * 配列複写を実行する。置けた数（元を除く）を返す。
 *
 * **1 回の呼び出しで全部置く。** 呼ぶ側が `store.commit` で包めば、
 * undo 1 回でまとめて戻る。
 */
export function arrayCopy(scene: Scene, refs: readonly EntityRef[], spec: ArrayCopy): number {
  if (refs.length === 0) return 0;
  let placed = 0;
  for (const step of stepsOf(spec)) {
    const t = step.kind === 'move'
      ? translation(step.delta)
      : rotation((spec as RadialArray).center, step.angle);
    const got = transformEntities(scene, [...refs], t, { copy: true });
    if (got.refs.length > 0) placed += 1;
  }
  return placed;
}
