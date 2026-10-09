import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vec, type Vec } from '../src/core/geometry.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { emptyScene, newId, type Id, type Scene } from '../src/core/types.ts';
import {
  CONSTRAINT_KINDS,
  CONSTRAINT_SPECS,
  constraintLabel,
  constraintNodes,
  isConstraintKind,
  type Constraint,
  type ConstraintKind,
} from '../src/core/constraints.ts';

export function sceneWithWalls(segments: [Vec, Vec][]): { scene: Scene; wallIds: Id[] } {
  const scene = emptyScene();
  const wallIds = segments.map(([a, b]) => {
    const na = findOrCreateNode(scene, a);
    const nb = findOrCreateNode(scene, b);
    return addWall(scene, na, nb, 120)!.id;
  });
  return { scene, wallIds };
}

export function constraintOn(kind: ConstraintKind, walls: Id[], value: number | null = null): Constraint {
  return { id: newId('c'), kind, walls, value };
}

/**
 * 種別ごとの代表配置。
 * **必ず斜めにする** — 軸平行だと水平拘束以外の偏微分がゼロになり、符号の誤りを見逃す。
 * `Record<ConstraintKind, …>` なので、種別を足すと配置の書き忘れが型エラーになる。
 */
const JACOBIAN_CASES: Record<ConstraintKind, () => { scene: Scene; constraint: Constraint }> = {
  horizontal: () => {
    const { scene, wallIds } = sceneWithWalls([[vec(130, 210), vec(2170, 940)]]);
    return { scene, constraint: constraintOn('horizontal', wallIds) };
  },
  vertical: () => {
    const { scene, wallIds } = sceneWithWalls([[vec(-310, 120), vec(680, 3050)]]);
    return { scene, constraint: constraintOn('vertical', wallIds) };
  },
  distance: () => {
    const { scene, wallIds } = sceneWithWalls([[vec(420, -180), vec(2890, 1630)]]);
    return { scene, constraint: constraintOn('distance', wallIds, 2600) };
  },
  parallel: () => {
    const { scene, wallIds } = sceneWithWalls([
      [vec(0, 0), vec(3120, 1480)],
      [vec(500, 2600), vec(3900, 3310)],
    ]);
    return { scene, constraint: constraintOn('parallel', wallIds) };
  },
  perpendicular: () => {
    const { scene, wallIds } = sceneWithWalls([
      [vec(0, 0), vec(2700, 1100)],
      [vec(400, 2200), vec(1550, 4900)],
    ]);
    return { scene, constraint: constraintOn('perpendicular', wallIds) };
  },
};

/** 解析的な勾配を「ノードID+軸」ごとに畳む。同じノードが複数回現れるため */
function foldGradient(scene: Scene, c: Constraint): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of CONSTRAINT_SPECS[c.kind].gradient(scene, c)) {
    out.set(`${g.nodeId}.x`, (out.get(`${g.nodeId}.x`) ?? 0) + g.dx);
    out.set(`${g.nodeId}.y`, (out.get(`${g.nodeId}.y`) ?? 0) + g.dy);
  }
  return out;
}

for (const kind of CONSTRAINT_KINDS) {
  test(`${kind} のヤコビアンが数値微分と一致する`, () => {
    const { scene, constraint } = JACOBIAN_CASES[kind]();
    const spec = CONSTRAINT_SPECS[kind];
    const analytic = foldGradient(scene, constraint);
    const h = 1e-4;

    const nodeIds = constraintNodes(scene, constraint);
    assert.ok(nodeIds.length > 0, '関与するノードが無い');

    for (const nodeId of nodeIds) {
      for (const axis of ['x', 'y'] as const) {
        const node = scene.nodes[nodeId];
        const base = node[axis];

        node[axis] = base + h;
        const plus = spec.residual(scene, constraint)!;
        node[axis] = base - h;
        const minus = spec.residual(scene, constraint)!;
        node[axis] = base;

        const numeric = (plus - minus) / (2 * h);
        const got = analytic.get(`${nodeId}.${axis}`) ?? 0;
        const tol = 1e-6 * Math.max(1, Math.abs(got));
        assert.ok(Math.abs(got - numeric) < tol, `∂r/∂${axis} が ${got} / 数値微分は ${numeric}`);
      }
    }
  });
}

test('角度系の残差が長さの次元に正規化されている', () => {
  // 壁長を10倍にしても、同じ角度ずれなら残差がほぼ同じオーダーに収まる
  const residualFor = (len: number, kind: 'parallel' | 'perpendicular') => {
    const angle = kind === 'parallel' ? (1 * Math.PI) / 180 : Math.PI / 2 + (1 * Math.PI) / 180;
    const { scene, wallIds } = sceneWithWalls([
      [vec(0, 0), vec(len, 0)],
      [vec(0, 9000), vec(len * Math.cos(angle), 9000 + len * Math.sin(angle))],
    ]);
    return Math.abs(CONSTRAINT_SPECS[kind].residual(scene, constraintOn(kind, wallIds))!);
  };

  for (const kind of ['parallel', 'perpendicular'] as const) {
    const short = residualFor(500, kind);
    const long = residualFor(5000, kind);
    assert.ok(Math.abs(short - long) < 1e-6, `${kind}: ${short} と ${long} が揃っていない`);
    // 1度のずれが「mm として意味のある大きさ」になっている
    assert.ok(short > 0.1 && short < 100, `${kind}: 残差 ${short} がスケール外れ`);
  }
});

test('退化した壁を含む拘束は残差も勾配も出さない', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(5000, 0));
  const wall = addWall(scene, a, b, 120)!;
  const other = addWall(scene, findOrCreateNode(scene, vec(0, 3000)), findOrCreateNode(scene, vec(4000, 3000)), 120)!;

  // 端点を重ねて長さ 0 にする
  scene.nodes[b].x = 0;

  for (const kind of CONSTRAINT_KINDS) {
    const spec = CONSTRAINT_SPECS[kind];
    const c = constraintOn(kind, spec.arity === 1 ? [wall.id] : [wall.id, other.id], 1000);
    assert.equal(spec.residual(scene, c), null, `${kind} の残差`);
    assert.deepEqual(spec.gradient(scene, c), [], `${kind} の勾配`);
  }
});

test('参照先の壁が無い拘束は静かに無視される', () => {
  const { scene } = sceneWithWalls([[vec(0, 0), vec(1000, 0)]]);
  for (const kind of CONSTRAINT_KINDS) {
    const c = constraintOn(kind, ['missing-1', 'missing-2'], 1000);
    assert.equal(CONSTRAINT_SPECS[kind].residual(scene, c), null, kind);
    assert.deepEqual(CONSTRAINT_SPECS[kind].gradient(scene, c), [], kind);
    assert.deepEqual(constraintNodes(scene, c), []);
  }
});

test('applicable が選択の本数と実在を見る', () => {
  const { scene, wallIds } = sceneWithWalls([
    [vec(0, 0), vec(1000, 0)],
    [vec(0, 2000), vec(1000, 2000)],
  ]);
  for (const kind of CONSTRAINT_KINDS) {
    const spec = CONSTRAINT_SPECS[kind];
    assert.equal(spec.applicable(scene, [wallIds[0]]), spec.arity === 1, `${kind} 1本`);
    assert.equal(spec.applicable(scene, wallIds), spec.arity === 2, `${kind} 2本`);
    assert.equal(spec.applicable(scene, []), false, `${kind} 0本`);
    assert.equal(spec.applicable(scene, ['missing']), false, `${kind} 実在しない`);
    // 同じ壁を2回選んでも平行・直角にはできない
    assert.equal(spec.applicable(scene, [wallIds[0], wallIds[0]]), false, `${kind} 同一の壁2本`);
  }
});

test('長さの初期値は現在の壁長になる', () => {
  const { scene, wallIds } = sceneWithWalls([[vec(0, 0), vec(3000, 4000)]]);
  assert.equal(CONSTRAINT_SPECS.distance.initialValue(scene, wallIds), 5000);
  for (const kind of CONSTRAINT_KINDS) {
    if (kind === 'distance') continue;
    assert.equal(CONSTRAINT_SPECS[kind].initialValue(scene, wallIds), null, kind);
  }
});

test('ラベルと種別の判定', () => {
  assert.equal(constraintLabel(constraintOn('horizontal', ['w'])), '水平');
  assert.equal(constraintLabel(constraintOn('distance', ['w'], 3640)), '長さ 3,640 mm');
  assert.equal(isConstraintKind('parallel'), true);
  assert.equal(isConstraintKind('coincident'), false, '一致は入れない設計');
});

// --- ソルバ ---

import { solveScene } from '../src/core/constraintSolver.ts';
import { addConstraint, copyConstraints, hasConstraint, pruneConstraints, splitConstraints } from '../src/core/constraintOps.ts';
import { dist as distOf } from '../src/core/geometry.ts';

/** 壁の両端座標 */
const ends = (scene: Scene, wallId: Id) => {
  const w = scene.walls[wallId];
  return [scene.nodes[w.a], scene.nodes[w.b]] as const;
};

test('拘束が無ければ何もしない', () => {
  const { scene } = sceneWithWalls([[vec(0, 0), vec(3000, 700)]]);
  const before = JSON.stringify(scene.nodes);
  const r = solveScene(scene);
  assert.equal(r.changed, false);
  assert.equal(r.iterations, 0);
  assert.equal(JSON.stringify(scene.nodes), before, '座標が動いた');
});

test('傾いた壁に水平を付けると両端の y が揃う', () => {
  const { scene, wallIds } = sceneWithWalls([[vec(0, 0), vec(3000, 700)]]);
  addConstraint(scene, 'horizontal', wallIds);
  const r = solveScene(scene);
  assert.equal(r.ok, true, `残差 ${r.maxResidual}`);
  const [a, b] = ends(scene, wallIds[0]);
  assert.ok(Math.abs(a.y - b.y) < 0.01, `y が ${a.y} と ${b.y}`);
});

test('長さの拘束が壁長を指定値にする', () => {
  const { scene, wallIds } = sceneWithWalls([[vec(0, 0), vec(3000, 700)]]);
  const c = addConstraint(scene, 'distance', wallIds)!;
  c.value = 4000;
  assert.equal(solveScene(scene).ok, true);
  const [a, b] = ends(scene, wallIds[0]);
  assert.ok(Math.abs(distOf(a, b) - 4000) < 0.01, `長さ ${distOf(a, b)}`);
});

test('長方形の4辺に水平2・垂直2を付けると直角が出る', () => {
  // わざと歪ませた四角形
  const { scene, wallIds } = sceneWithWalls([
    [vec(0, 0), vec(4000, 300)],
    [vec(4000, 300), vec(4200, 3000)],
    [vec(4200, 3000), vec(150, 2800)],
    [vec(150, 2800), vec(0, 0)],
  ]);
  addConstraint(scene, 'horizontal', [wallIds[0]]);
  addConstraint(scene, 'vertical', [wallIds[1]]);
  addConstraint(scene, 'horizontal', [wallIds[2]]);
  addConstraint(scene, 'vertical', [wallIds[3]]);

  const r = solveScene(scene);
  assert.equal(r.ok, true, `残差 ${r.maxResidual}`);
  for (const [i, kind] of [[0, 'h'], [1, 'v'], [2, 'h'], [3, 'v']] as const) {
    const [a, b] = ends(scene, wallIds[i]);
    const off = kind === 'h' ? Math.abs(a.y - b.y) : Math.abs(a.x - b.x);
    assert.ok(off < 0.01, `壁${i} の ${kind} 残差 ${off}`);
  }
});

test('平行と直角が角度を揃える', () => {
  const { scene, wallIds } = sceneWithWalls([
    [vec(0, 0), vec(3000, 100)],
    [vec(0, 2000), vec(2900, 2400)],
    [vec(6000, 0), vec(6200, 2500)],
  ]);
  addConstraint(scene, 'parallel', [wallIds[0], wallIds[1]]);
  addConstraint(scene, 'perpendicular', [wallIds[0], wallIds[2]]);
  assert.equal(solveScene(scene).ok, true);

  const angleOfWall = (id: Id) => {
    const [a, b] = ends(scene, id);
    return Math.atan2(b.y - a.y, b.x - a.x);
  };
  const base = angleOfWall(wallIds[0]);
  // 残差の式と同じ形で見る。平行なら sin が 0、直角なら cos が 0
  assert.ok(Math.abs(Math.sin(angleOfWall(wallIds[1]) - base)) < 1e-5, '平行になっていない');
  assert.ok(Math.abs(Math.cos(angleOfWall(wallIds[2]) - base)) < 1e-5, '直角になっていない');
});

test('pin したノードは1ミリも動かない', () => {
  const { scene, wallIds } = sceneWithWalls([[vec(0, 0), vec(3000, 700)]]);
  addConstraint(scene, 'horizontal', wallIds);
  const anchor = scene.walls[wallIds[0]].a;
  const before = { ...scene.nodes[anchor] };

  const r = solveScene(scene, { pinned: new Set([anchor]) });
  assert.equal(r.ok, true);
  assert.equal(scene.nodes[anchor].x, before.x);
  assert.equal(scene.nodes[anchor].y, before.y);
});

test('無関係な2グループは互いに影響しない', () => {
  const { scene, wallIds } = sceneWithWalls([
    [vec(0, 0), vec(3000, 700)],
    [vec(50000, 50000), vec(53000, 50600)],
  ]);
  addConstraint(scene, 'horizontal', [wallIds[0]]);
  const far = ends(scene, wallIds[1]).map((n) => ({ ...n }));

  const r = solveScene(scene);
  assert.equal(r.components, 1, '拘束のない壁まで成分に入っている');
  const after = ends(scene, wallIds[1]);
  assert.deepEqual([{ ...after[0] }, { ...after[1] }].map((n) => [n.x, n.y]), far.map((n) => [n.x, n.y]));
});

test('収束済みのシーンを解き直しても座標が1ビットも変わらない', () => {
  const { scene, wallIds } = sceneWithWalls([[vec(0, 0), vec(3000, 700)]]);
  addConstraint(scene, 'horizontal', wallIds);
  solveScene(scene);
  const settled = JSON.stringify(scene.nodes);

  const again = solveScene(scene);
  assert.equal(again.changed, false, '収束済みなのに動いた');
  assert.equal(again.iterations, 0);
  assert.equal(JSON.stringify(scene.nodes), settled);
});

test('矛盾する拘束は棄却され、座標が元のまま残る', () => {
  const { scene, wallIds } = sceneWithWalls([[vec(0, 0), vec(3000, 700)]]);
  addConstraint(scene, 'horizontal', wallIds);
  addConstraint(scene, 'vertical', wallIds);
  const before = JSON.stringify(scene.nodes);

  const r = solveScene(scene);
  assert.equal(r.ok, false, '矛盾が検出されていない');
  assert.ok(r.violated.length > 0, '違反した拘束が報告されていない');
  // 長さ 0 に潰そうとして暴走するのを防ぐ。座標は開始位置のまま
  assert.equal(JSON.stringify(scene.nodes), before);
});

test('冗長な拘束は受理される（特異行列でも落ちない）', () => {
  const { scene, wallIds } = sceneWithWalls([
    [vec(0, 0), vec(3000, 120)],
    [vec(0, 2000), vec(3000, 2120)],
    [vec(0, 4000), vec(3000, 4120)],
  ]);
  // 既に平行な3本に、閉じた輪になるよう平行拘束を3本（1本は冗長）
  addConstraint(scene, 'parallel', [wallIds[0], wallIds[1]]);
  addConstraint(scene, 'parallel', [wallIds[1], wallIds[2]]);
  addConstraint(scene, 'parallel', [wallIds[0], wallIds[2]]);
  addConstraint(scene, 'horizontal', [wallIds[0]]);
  addConstraint(scene, 'horizontal', [wallIds[0]]); // 完全重複は addConstraint が弾く

  const r = solveScene(scene);
  assert.equal(r.ok, true, `残差 ${r.maxResidual}`);
  for (const node of Object.values(scene.nodes)) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), 'NaN が入った');
  }
});

test('退化した壁があってもソルバは落ちない', () => {
  const { scene, wallIds } = sceneWithWalls([
    [vec(0, 0), vec(3000, 700)],
    [vec(0, 5000), vec(3000, 5000)],
  ]);
  addConstraint(scene, 'parallel', wallIds);
  addConstraint(scene, 'horizontal', [wallIds[0]]);
  // 片方を潰す
  const w = scene.walls[wallIds[1]];
  scene.nodes[w.b].x = scene.nodes[w.a].x;
  scene.nodes[w.b].y = scene.nodes[w.a].y;

  const r = solveScene(scene);
  for (const node of Object.values(scene.nodes)) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), 'NaN が入った');
  }
  assert.ok(r.maxResidual < 1, `退化した行を飛ばせていない: ${r.maxResidual}`);
});

// --- 張り替え ---

test('壁を分割すると角度系は両方に残り、長さは消える', () => {
  const { scene, wallIds } = sceneWithWalls([[vec(0, 0), vec(4000, 0)]]);
  addConstraint(scene, 'horizontal', wallIds);
  addConstraint(scene, 'distance', wallIds);

  const second = 'w-second';
  scene.walls[second] = { ...scene.walls[wallIds[0]], id: second };
  splitConstraints(scene, wallIds[0], second);

  const kinds = Object.values(scene.constraints).map((c) => `${c.kind}:${c.walls.join(',')}`).sort();
  assert.deepEqual(kinds, [`horizontal:${second}`, `horizontal:${wallIds[0]}`].sort());
});

test('参照先を失った拘束が掃除される', () => {
  const { scene, wallIds } = sceneWithWalls([[vec(0, 0), vec(4000, 0)]]);
  addConstraint(scene, 'horizontal', wallIds);
  assert.equal(Object.keys(scene.constraints).length, 1);

  delete scene.walls[wallIds[0]];
  assert.equal(pruneConstraints(scene), true);
  assert.equal(Object.keys(scene.constraints).length, 0);
});

test('複写では全参照先が複製された拘束だけが写る', () => {
  const { scene, wallIds } = sceneWithWalls([
    [vec(0, 0), vec(3000, 0)],
    [vec(0, 2000), vec(3000, 2000)],
  ]);
  addConstraint(scene, 'horizontal', [wallIds[0]]);
  addConstraint(scene, 'parallel', [wallIds[0], wallIds[1]]);

  // 1本目だけを複製したことにする
  const copy = 'w-copy';
  scene.walls[copy] = { ...scene.walls[wallIds[0]], id: copy };
  copyConstraints(scene, new Map([[wallIds[0], copy]]));

  const copied = Object.values(scene.constraints).filter((c) => c.walls.includes(copy));
  assert.equal(copied.length, 1, '片側しか複製されていない平行まで写っている');
  assert.equal(copied[0].kind, 'horizontal');
});

test('同じ拘束を二重に付けられない', () => {
  const { scene, wallIds } = sceneWithWalls([[vec(0, 0), vec(3000, 0)]]);
  assert.ok(addConstraint(scene, 'horizontal', wallIds));
  assert.equal(addConstraint(scene, 'horizontal', wallIds), null);
  assert.equal(hasConstraint(scene, 'horizontal', wallIds), true);
  assert.equal(hasConstraint(scene, 'vertical', wallIds), false);
  assert.equal(Object.keys(scene.constraints).length, 1);
});

test('平行は壁の順番が逆でも同じ拘束とみなす', () => {
  const { scene, wallIds } = sceneWithWalls([
    [vec(0, 0), vec(3000, 0)],
    [vec(0, 2000), vec(3000, 2000)],
  ]);
  assert.ok(addConstraint(scene, 'parallel', [wallIds[0], wallIds[1]]));
  assert.equal(addConstraint(scene, 'parallel', [wallIds[1], wallIds[0]]), null);
});

// --- Store との結合 ---

import { Store } from '../src/core/store.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { translateSelection } from '../src/core/selection.ts';
import { resolveSelection } from '../src/core/selection.ts';

function storeWith(segments: [Vec, Vec][]): { store: Store; wallIds: Id[] } {
  const { scene, wallIds } = sceneWithWalls(segments);
  const store = new Store();
  store.replaceScene(scene, { keepHistory: false });
  return { store, wallIds };
}

test('commit を通ると拘束が解かれる', () => {
  const { store, wallIds } = storeWith([[vec(0, 0), vec(3000, 700)]]);
  addConstraint(store.scene, 'horizontal', wallIds);

  const wall = store.scene.walls[wallIds[0]];
  store.commit(() => {
    store.scene.nodes[wall.b].y += 500; // 傾きをさらに増やす
  });
  const [a, b] = ends(store.scene, wallIds[0]);
  assert.ok(Math.abs(a.y - b.y) < 0.01, `commit 後も傾いている: ${a.y} / ${b.y}`);
});

test('拘束が無ければ commit の挙動は変わらない', () => {
  const { store, wallIds } = storeWith([[vec(0, 0), vec(3000, 700)]]);
  const wall = store.scene.walls[wallIds[0]];
  store.commit(() => {
    store.scene.nodes[wall.b].y += 500;
  });
  assert.equal(store.scene.nodes[wall.b].y, 1200, '拘束が無いのに座標が動かされた');
  assert.equal(store.lastSolve?.changed, false);
});

test('commit が false を返すと拘束も座標も巻き戻る', () => {
  const { store, wallIds } = storeWith([[vec(0, 0), vec(3000, 700)]]);
  const before = JSON.stringify(store.scene.nodes);

  store.commit(() => {
    addConstraint(store.scene, 'horizontal', wallIds);
    return false;
  });
  assert.equal(Object.keys(store.scene.constraints).length, 0, '拘束が残っている');
  assert.equal(JSON.stringify(store.scene.nodes), before, '座標が動いた');
  assert.equal(store.canUndo(), false, '履歴が積まれた');
});

test('pin したノードは commit の solve でも動かない', () => {
  const { store, wallIds } = storeWith([[vec(0, 0), vec(3000, 700)]]);
  addConstraint(store.scene, 'horizontal', wallIds);
  const wall = store.scene.walls[wallIds[0]];

  store.solverPins = new Set([wall.b]);
  const kept = { ...store.scene.nodes[wall.b] };
  store.commit(() => {
    const sel = resolveSelection(store.scene, [{ type: 'node', id: wall.b }]);
    translateSelection(store.scene, sel, vec(0, 0));
  });
  assert.equal(store.scene.nodes[wall.b].y, kept.y, 'pin したノードが動いた');
  assert.equal(store.solverPins.size, 0, 'pin が使い捨てになっていない');
});

test('undo では解き直さない', () => {
  const { store, wallIds } = storeWith([[vec(0, 0), vec(3000, 700)]]);
  const wall = store.scene.walls[wallIds[0]];
  const tilted = { ...store.scene.nodes[wall.b] };

  store.commit(() => {
    addConstraint(store.scene, 'horizontal', wallIds);
  });
  assert.ok(Math.abs(store.scene.nodes[wall.b].y - tilted.y) > 1, '拘束が効いていない');

  store.undo();
  // 元の傾いた状態がそのまま戻る（解き直すと undo が元に戻らなくなる）
  assert.equal(store.scene.nodes[wall.b].y, tilted.y);
  assert.equal(Object.keys(store.scene.constraints).length, 0);
});

test('commit の中で例外が出ても、次の solve は自己修復して落ちない', () => {
  const { store, wallIds } = storeWith([[vec(0, 0), vec(3000, 700)]]);
  addConstraint(store.scene, 'horizontal', wallIds);

  assert.throws(() => {
    store.commit(() => {
      delete store.scene.walls[wallIds[0]]; // 参照先を壊したところで throw
      throw new Error('途中で失敗');
    });
  });
  // commit は例外ではシーンを巻き戻さないので、壊れた参照が残っている
  assert.equal(Object.keys(store.scene.constraints).length, 1);

  assert.doesNotThrow(() => store.commit(() => {}));
  assert.equal(Object.keys(store.scene.constraints).length, 0, '壊れた拘束が掃除されていない');
});

test('拘束が JSON の往復で保たれる', () => {
  const { scene, wallIds } = sceneWithWalls([
    [vec(0, 0), vec(3000, 0)],
    [vec(0, 2000), vec(3000, 2000)],
  ]);
  addConstraint(scene, 'horizontal', [wallIds[0]]);
  addConstraint(scene, 'parallel', wallIds);
  const d = addConstraint(scene, 'distance', [wallIds[1]])!;
  d.value = 2500;

  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  const kinds = Object.values(back.constraints).map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['distance', 'horizontal', 'parallel']);
  const restored = Object.values(back.constraints).find((c) => c.kind === 'distance')!;
  assert.equal(restored.value, 2500);
  assert.deepEqual(Object.values(back.constraints).find((c) => c.kind === 'parallel')!.walls, wallIds);
});

test('参照先の壁が無い拘束は読み込み時に捨てられる', () => {
  const { scene, wallIds } = sceneWithWalls([[vec(0, 0), vec(3000, 0)]]);
  addConstraint(scene, 'horizontal', wallIds);
  const raw = JSON.parse(JSON.stringify(serialize(scene)));
  raw.scene.walls = {};

  assert.equal(Object.keys(deserialize(raw).constraints).length, 0);
});

test('知らない種別の拘束は読み飛ばす', () => {
  const { scene, wallIds } = sceneWithWalls([[vec(0, 0), vec(3000, 0)]]);
  addConstraint(scene, 'horizontal', wallIds);
  const raw = JSON.parse(JSON.stringify(serialize(scene)));
  for (const c of Object.values(raw.scene.constraints) as { kind: string }[]) c.kind = 'coincident';

  assert.equal(Object.keys(deserialize(raw).constraints).length, 0);
});
