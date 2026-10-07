import {
  add,
  angleOf,
  closestOnSegment,
  dist,
  len,
  mid,
  mul,
  rotate,
  segmentIntersection,
  sub,
  vec,
  type Vec,
} from './geometry.ts';
import { isSnappable } from './entity.ts';
import { nodePos, wallEnds } from './ops.ts';
import { shapeSnapPoints } from './shapes.ts';
import type { Id, Scene } from './types.ts';
import type { Settings } from './store.ts';

export type SnapKind = 'node' | 'midpoint' | 'intersection' | 'center' | 'wall' | 'grid' | 'angle' | 'free';

export interface SnapResult {
  point: Vec;
  kind: SnapKind;
  label: string;
  nodeId?: Id;
  wallId?: Id;
}

export interface SnapOptions {
  /** ラバーバンドの起点。これがあると角度スナップと長さの丸めが効く */
  from?: Vec | null;
  /** 候補から除外するノード（自分自身をドラッグ中など） */
  excludeNodes?: Id[];
  /** 候補から除外する壁 */
  excludeWalls?: Id[];
  /** スナップ判定の半径 (mm) */
  radius: number;
  /** 角度スナップの刻み (度) */
  angleStep?: number;
}

const KIND_LABEL: Record<SnapKind, string> = {
  node: '端点',
  midpoint: '中点',
  intersection: '交点',
  center: '中心',
  wall: '壁上',
  grid: 'グリッド',
  angle: '角度',
  free: '',
};

/**
 * CAD らしさの大半はここで決まる。優先度は 端点 > 中点 > 交点 > 壁上 > 角度 > グリッド。
 * オブジェクトスナップが効いた場合は角度・グリッドより常に優先する（作図者の意図に近いため）。
 */
export function snapPoint(scene: Scene, settings: Settings, p: Vec, opts: SnapOptions): SnapResult {
  const excludeNodes = new Set(opts.excludeNodes ?? []);
  const excludeWalls = new Set(opts.excludeWalls ?? []);
  const r = opts.radius;

  let best: SnapResult | null = null;
  let bestScore = Infinity;

  const consider = (candidate: Vec, kind: SnapKind, priority: number, extra?: Partial<SnapResult>) => {
    const d = dist(p, candidate);
    if (d > r) return;
    // 優先度を距離より強く効かせる（遠い端点が近いグリッドに負けないように）
    const score = priority * 1000 + d;
    if (score < bestScore) {
      bestScore = score;
      best = { point: candidate, kind, label: KIND_LABEL[kind], ...extra };
    }
  };

  if (settings.snapNode) {
    for (const n of Object.values(scene.nodes)) {
      if (excludeNodes.has(n.id)) continue;
      if (!isSnappable(scene, { type: 'node', id: n.id })) continue;
      consider(vec(n.x, n.y), 'node', 0, { nodeId: n.id });
    }
  }

  const walls = Object.values(scene.walls).filter(
    (w) => !excludeWalls.has(w.id) && isSnappable(scene, { type: 'wall', id: w.id }),
  );

  if (settings.snapWall) {
    for (const w of walls) {
      const [a, b] = wallEnds(scene, w);
      consider(mid(a, b), 'midpoint', 1, { wallId: w.id });
    }
    for (let i = 0; i < walls.length; i++) {
      const [a1, b1] = wallEnds(scene, walls[i]);
      for (let j = i + 1; j < walls.length; j++) {
        const [a2, b2] = wallEnds(scene, walls[j]);
        const x = segmentIntersection(a1, b1, a2, b2);
        if (x) consider(x, 'intersection', 2);
      }
    }
    for (const w of walls) {
      const [a, b] = wallEnds(scene, w);
      const c = closestOnSegment(p, a, b);
      consider(c.point, 'wall', 3, { wallId: w.id });
    }
  }

  if (settings.snapNode) {
    for (const shape of Object.values(scene.shapes)) {
      if (!isSnappable(scene, { type: 'shape', id: shape.id })) continue;
      for (const candidate of shapeSnapPoints(scene, shape)) {
        // 端点=0 / 中点=1 / 中心=2 と、壁のスナップと同じ優先度帯に乗せる
        const priority = candidate.kind === 'node' ? 0 : candidate.kind === 'midpoint' ? 1 : 2;
        consider(candidate.point, candidate.kind, priority);
      }
    }
  }

  if (best) return best;

  // --- オブジェクトスナップが効かなかった場合 ---

  const from = opts.from ?? null;
  if (from && settings.ortho) {
    const step = ((opts.angleStep ?? 15) * Math.PI) / 180;
    const d = sub(p, from);
    const distance = len(d);
    if (distance > 1e-6) {
      const snappedAngle = Math.round(angleOf(d) / step) * step;
      let length = distance;
      if (settings.snapGrid && settings.gridSize > 0) {
        length = Math.round(length / settings.gridSize) * settings.gridSize;
        if (length === 0) length = settings.gridSize;
      }
      const point = add(from, rotate(vec(length, 0), snappedAngle));
      return { point, kind: 'angle', label: `${Math.round((snappedAngle * 180) / Math.PI)}°` };
    }
  }

  if (settings.snapGrid && settings.gridSize > 0) {
    const g = settings.gridSize;
    const point = vec(Math.round(p.x / g) * g, Math.round(p.y / g) * g);
    if (dist(p, point) <= r) return { point, kind: 'grid', label: KIND_LABEL.grid };
  }

  return { point: { ...p }, kind: 'free', label: '' };
}

/** 作図中に長さ・角度を数値で打ち込むときの点を作る */
export function pointFromPolar(from: Vec, lengthMm: number, angleDeg: number): Vec {
  return add(from, mul(rotate(vec(1, 0), (angleDeg * Math.PI) / 180), lengthMm));
}

/** ノードの実座標（スナップ結果からノードIDが取れたとき用） */
export function resolveSnapNode(scene: Scene, snap: SnapResult): Vec {
  return snap.nodeId ? nodePos(scene, snap.nodeId) : snap.point;
}
