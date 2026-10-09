import {
  allFinite,
  choleskyDecompose,
  choleskySolve,
  maxAbs,
  norm2,
  normalEquations,
  trace,
  withDamping,
} from './matrix.ts';
import { CONSTRAINT_SPECS, constraintNodes, type Constraint } from './constraints.ts';
import { pruneConstraints } from './constraintOps.ts';
import { dist } from './geometry.ts';
import { NODE_MERGE_TOLERANCE, wallEnds } from './ops.ts';
import type { Id, Scene } from './types.ts';

/**
 * 幾何拘束ソルバ。
 *
 * ノードの (x, y) だけを自由度とする**非線形最小二乗**として解く。
 * 壁は座標を持たずノード参照なので、壁の拘束はすべてノード座標の式に還元できる。
 *
 * 解く線形系は `(JᵀJ + λI) δ = −Jᵀr` ただ一つで、λ > 0 の時点で対称正定値。
 * だから `matrix.ts` はコレスキーだけで足りる。
 *
 * 矛盾の判定は**階数ではなく残差**で行う。冗長な拘束（同じ壁に水平2本など）は
 * `JᵀJ` を特異にするが λI が救い、残差は 0 に落ちるので受理される。
 * これは実際に無害なので受理が正しい。矛盾は収束しても残差が残ることで分かる。
 */

/** これ以下なら収束。NODE_MERGE_TOLERANCE (1mm) の 1/100 で、丸めが統合の判定を揺らさない */
const RESIDUAL_TOL = 0.01;
/** 増分がこれ以下なら、残差が残っていても打ち切る */
const STEP_TOL = 1e-4;
const MAX_ITERATIONS = 30;
/** 1反復のなかで λ を上げ直す回数の上限 */
const DAMPING_TRIES = 6;
/** 開始位置からこれ以上動いたら暴走とみなす (mm) */
const MAX_JUMP = 20000;
/** 壁がこれより短くなったら潰れたとみなす */
const MIN_WALL_LEN = NODE_MERGE_TOLERANCE;

export interface SolveOptions {
  /** 動かさないノード。残差には寄与するが変数にはならない */
  pinned?: ReadonlySet<Id>;
  maxIterations?: number;
}

export interface SolveResult {
  /** すべての連結成分が収束したか */
  ok: boolean;
  /** 実際に座標が動いたか */
  changed: boolean;
  maxResidual: number;
  components: number;
  iterations: number;
  /** 収束しなかった拘束。画面で赤く出す */
  violated: Id[];
}

const idle = (): SolveResult => ({ ok: true, changed: false, maxResidual: 0, components: 0, iterations: 0, violated: [] });

export function solveScene(scene: Scene, options: SolveOptions = {}): SolveResult {
  // 拘束を使わないユーザーの挙動を1ビットも変えないための門
  if (Object.keys(scene.constraints).length === 0) return idle();
  return solve(scene, options);
}

function solve(scene: Scene, options: SolveOptions): SolveResult {
  pruneConstraints(scene);

  const pinned = options.pinned ?? new Set<Id>();
  const maxIterations = options.maxIterations ?? MAX_ITERATIONS;

  // 残差を出せる拘束だけを行にする。壁が消えた・長さ 0 になったものは素通し
  const rows = Object.values(scene.constraints).filter((c) => CONSTRAINT_SPECS[c.kind].residual(scene, c) !== null);
  if (rows.length === 0) return idle();

  const groups = splitComponents(scene, rows, pinned);
  const result: SolveResult = { ok: true, changed: false, maxResidual: 0, components: groups.length, iterations: 0, violated: [] };

  for (const group of groups) {
    const r = solveComponent(scene, group.rows, group.nodes, maxIterations);
    result.changed ||= r.changed;
    result.iterations += r.iterations;
    result.maxResidual = Math.max(result.maxResidual, r.maxResidual);
    if (!r.ok) {
      result.ok = false;
      for (const c of group.rows) result.violated.push(c.id);
    }
  }
  return result;
}

interface Component {
  rows: Constraint[];
  /** 動かせるノード。決定論的にするため id でソート済み */
  nodes: Id[];
}

/**
 * 連結成分に分ける。
 *
 * Union-Find を**自由ノードだけ**に張るのが要点。`pinned` を union に参加させないので、
 * ドラッグ中に掴んだ角を pin するだけで成分が分断され、1成分の自由度が小さく保たれる。
 */
function splitComponents(scene: Scene, rows: Constraint[], pinned: ReadonlySet<Id>): Component[] {
  const parent = new Map<Id, Id>();
  const find = (x: Id): Id => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const add = (x: Id) => {
    if (!parent.has(x)) parent.set(x, x);
  };

  const freeOf = new Map<Constraint, Id[]>();
  for (const c of rows) {
    const free = constraintNodes(scene, c).filter((n) => !pinned.has(n) && scene.nodes[n]);
    freeOf.set(c, free);
    for (const n of free) add(n);
    for (let i = 1; i < free.length; i++) {
      const a = find(free[0]);
      const b = find(free[i]);
      if (a !== b) parent.set(b, a);
    }
  }

  const byRoot = new Map<Id, Component>();
  for (const c of rows) {
    const free = freeOf.get(c)!;
    // 全ノードが pin されている行は変数を持たない。ドラッグ中には普通に起きるので矛盾扱いしない
    if (free.length === 0) continue;
    const root = find(free[0]);
    let comp = byRoot.get(root);
    if (!comp) {
      comp = { rows: [], nodes: [] };
      byRoot.set(root, comp);
    }
    comp.rows.push(c);
    for (const n of free) if (!comp.nodes.includes(n)) comp.nodes.push(n);
  }

  const out = [...byRoot.values()];
  for (const comp of out) comp.nodes.sort();
  return out;
}

interface ComponentResult {
  ok: boolean;
  changed: boolean;
  maxResidual: number;
  iterations: number;
}

/** Levenberg–Marquardt。1成分ぶん */
function solveComponent(scene: Scene, rows: Constraint[], nodes: Id[], maxIterations: number): ComponentResult {
  const k = nodes.length * 2;
  const m = rows.length;
  const index = new Map<Id, number>();
  nodes.forEach((id, i) => index.set(id, i * 2));

  const start = nodes.map((id) => ({ x: scene.nodes[id].x, y: scene.nodes[id].y }));

  /**
   * この成分が触る壁。
   *
   * 解が壁を長さ 0 に潰してしまうことがある（同じ壁に水平と垂直を付けると、
   * 両端を重ねれば残差は 0 になる）。数学的には解だが、図面としては壁が消えるだけなので
   * 矛盾として扱う。
   */
  const walls = [...new Set(rows.flatMap((c) => c.walls))].filter((id) => scene.walls[id]);
  const collapsed = (): boolean =>
    walls.some((id) => {
      const [a, b] = wallEnds(scene, scene.walls[id]);
      return dist(a, b) < MIN_WALL_LEN;
    });
  const restore = () => {
    nodes.forEach((id, i) => {
      scene.nodes[id].x = start[i].x;
      scene.nodes[id].y = start[i].y;
    });
  };

  const residuals = (): Float64Array => {
    const r = new Float64Array(m);
    for (let i = 0; i < m; i++) r[i] = CONSTRAINT_SPECS[rows[i].kind].residual(scene, rows[i]) ?? 0;
    return r;
  };

  let r = residuals();
  let best = maxAbs(r);
  if (best < RESIDUAL_TOL) return { ok: true, changed: false, maxResidual: best, iterations: 0 };

  let lambda = 0;
  let iterations = 0;
  let changed = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations++;

    const j = new Float64Array(m * k);
    for (let i = 0; i < m; i++) {
      for (const g of CONSTRAINT_SPECS[rows[i].kind].gradient(scene, rows[i])) {
        const col = index.get(g.nodeId);
        if (col === undefined) continue; // pin されたノードは変数ではない
        j[i * k + col] += g.dx;
        j[i * k + col + 1] += g.dy;
      }
    }

    const { ata, atb } = normalEquations(j, r, m, k);
    if (lambda === 0) lambda = Math.max(1e-6, (1e-4 * trace(ata, k)) / Math.max(1, k));

    let accepted = false;
    for (let attempt = 0; attempt < DAMPING_TRIES; attempt++) {
      const l = choleskyDecompose(withDamping(ata, k, lambda), k);
      if (!l) {
        lambda *= 10;
        continue;
      }
      const step = choleskySolve(l, k, atb);
      if (!allFinite(step)) {
        lambda *= 10;
        continue;
      }

      nodes.forEach((id, i) => {
        scene.nodes[id].x += step[i * 2];
        scene.nodes[id].y += step[i * 2 + 1];
      });

      const next = residuals();
      const jumped = nodes.some((id, i) => Math.abs(scene.nodes[id].x - start[i].x) > MAX_JUMP || Math.abs(scene.nodes[id].y - start[i].y) > MAX_JUMP);
      const nodesFinite = nodes.every((id) => Number.isFinite(scene.nodes[id].x) && Number.isFinite(scene.nodes[id].y));

      if (!nodesFinite || jumped || collapsed()) {
        // 発散・暴走・壁の潰れ。開始位置へ戻して諦める。NaN をシーンに残すのが最悪
        restore();
        return { ok: false, changed: false, maxResidual: best, iterations };
      }

      if (norm2(next) < norm2(r)) {
        r = next;
        best = maxAbs(r);
        lambda = Math.max(1e-9, lambda / 3);
        accepted = true;
        changed = true;
        break;
      }

      // 悪化したのでステップを捨て、ダンピングを強める
      nodes.forEach((id, i) => {
        scene.nodes[id].x -= step[i * 2];
        scene.nodes[id].y -= step[i * 2 + 1];
      });
      lambda *= 5;
      if (maxAbs(step) < STEP_TOL) break;
    }

    if (!accepted) break;
    if (best < RESIDUAL_TOL) return { ok: true, changed, maxResidual: best, iterations };
  }

  return { ok: best < RESIDUAL_TOL, changed, maxResidual: best, iterations };
}
