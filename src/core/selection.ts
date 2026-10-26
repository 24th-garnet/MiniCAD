import { add, dot, norm, sub, vec, type Vec } from './geometry.ts';
import { clampOpening, nodePos, wallEnds } from './ops.ts';
import type { Shape } from './shapes.ts';
import { shapeVertices, transformShape } from './shapes.ts';
import { moveDimension } from './dimension.ts';
import { translation } from './transform.ts';
import type { EntityRef, Id, Scene } from './types.ts';

/**
 * 選択を「実際に動かす対象」へ展開したもの。
 * 壁を選ぶと両端のノードが入る（ノードは複数の壁から共有されるので、
 * ここで一度集合にまとめないと同じノードを二重に動かしてしまう）。
 */
export interface ResolvedSelection {
  nodeIds: Id[];
  openingIds: Id[];
  instanceIds: Id[];
  roomLabelIds: Id[];
  shapeIds: Id[];
  fixtureIds: Id[];
  measurementIds: Id[];
}

/** 操作開始時の位置。ドラッグ中に同じ delta を何度適用しても累積しないようにするため */
export interface MoveOrigins {
  nodes: Map<Id, Vec>;
  instances: Map<Id, Vec>;
  roomLabels: Map<Id, Vec>;
  fixtures: Map<Id, Vec>;
  /** 計測は両端を持つので、始点の位置と、始点から終点への差で控える */
  measurements: Map<Id, { a: Vec; b: Vec }>;
  /** 開口は壁に沿った距離で持つ */
  openings: Map<Id, number>;
  /** 図形は種別ごとに持つ座標が違うので、元の図形ごと控えておく */
  shapes: Map<Id, Shape>;
}

export function resolveSelection(scene: Scene, refs: EntityRef[]): ResolvedSelection {
  const nodeIds = new Set<Id>();
  const openingIds = new Set<Id>();
  const instanceIds = new Set<Id>();
  const fixtureIds = new Set<Id>();
  const measurementIds = new Set<Id>();
  const roomLabelIds = new Set<Id>();
  const shapeIds = new Set<Id>();

  for (const ref of refs) {
    switch (ref.type) {
      case 'node':
        if (scene.nodes[ref.id]) nodeIds.add(ref.id);
        break;
      case 'wall': {
        const w = scene.walls[ref.id];
        if (w) {
          nodeIds.add(w.a);
          nodeIds.add(w.b);
        }
        break;
      }
      case 'opening':
        if (scene.openings[ref.id]) openingIds.add(ref.id);
        break;
      case 'blockInstance':
        if (scene.instances[ref.id]) instanceIds.add(ref.id);
        break;
      case 'roomLabel':
        if (scene.roomLabels[ref.id]) roomLabelIds.add(ref.id);
        break;
      case 'shape':
        if (scene.shapes[ref.id]) shapeIds.add(ref.id);
        break;
      case 'fixture':
        if (scene.fixtures[ref.id]) fixtureIds.add(ref.id);
        break;
      case 'measurement':
        if (scene.measurements[ref.id]) measurementIds.add(ref.id);
        break;
    }
  }
  return {
    nodeIds: [...nodeIds],
    openingIds: [...openingIds],
    instanceIds: [...instanceIds],
    roomLabelIds: [...roomLabelIds],
    shapeIds: [...shapeIds],
    fixtureIds: [...fixtureIds],
    measurementIds: [...measurementIds],
  };
}

export function isEmptySelection(sel: ResolvedSelection): boolean {
  return (
    sel.nodeIds.length === 0 &&
    sel.openingIds.length === 0 &&
    sel.instanceIds.length === 0 &&
    sel.roomLabelIds.length === 0 &&
    sel.shapeIds.length === 0 &&
    sel.fixtureIds.length === 0 &&
    sel.measurementIds.length === 0
  );
}

export function captureOrigins(scene: Scene, sel: ResolvedSelection): MoveOrigins {
  const origins: MoveOrigins = {
    nodes: new Map(),
    instances: new Map(),
    roomLabels: new Map(),
    fixtures: new Map(),
    measurements: new Map(),
    openings: new Map(),
    shapes: new Map(),
  };
  for (const id of sel.nodeIds) origins.nodes.set(id, nodePos(scene, id));
  for (const id of sel.instanceIds) {
    const inst = scene.instances[id];
    if (inst) origins.instances.set(id, vec(inst.x, inst.y));
  }
  for (const id of sel.roomLabelIds) {
    const l = scene.roomLabels[id];
    if (l) origins.roomLabels.set(id, vec(l.x, l.y));
  }
  for (const id of sel.fixtureIds) {
    const f = scene.fixtures[id];
    if (f) origins.fixtures.set(id, vec(f.x, f.y));
  }
  for (const id of sel.measurementIds) {
    const m = scene.measurements[id];
    if (m) origins.measurements.set(id, { a: vec(m.a.x, m.a.y), b: vec(m.b.x, m.b.y) });
  }
  for (const id of sel.openingIds) {
    const o = scene.openings[id];
    if (o) origins.openings.set(id, o.offset);
  }
  for (const id of sel.shapeIds) {
    const s = scene.shapes[id];
    if (s) origins.shapes.set(id, structuredClone(s));
  }
  return origins;
}

/** 選択範囲の中心。回転・鏡像の既定の基点に使う */
export function selectionCenter(scene: Scene, sel: ResolvedSelection): Vec | null {
  const pts: Vec[] = [];
  for (const id of sel.nodeIds) pts.push(nodePos(scene, id));
  for (const id of sel.instanceIds) {
    const inst = scene.instances[id];
    if (inst) pts.push(vec(inst.x, inst.y));
  }
  for (const id of sel.roomLabelIds) {
    const l = scene.roomLabels[id];
    if (l) pts.push(vec(l.x, l.y));
  }
  for (const id of sel.shapeIds) {
    const s = scene.shapes[id];
    if (s) pts.push(...shapeVertices(scene, s));
  }
  for (const id of sel.fixtureIds) {
    const f = scene.fixtures[id];
    if (f) pts.push(vec(f.x, f.y));
  }
  for (const id of sel.measurementIds) {
    const m = scene.measurements[id];
    if (m) pts.push(vec(m.a.x, m.a.y), vec(m.b.x, m.b.y));
  }
  if (pts.length === 0) return null;
  const sum = pts.reduce((acc, p) => add(acc, p), vec(0, 0));
  return vec(sum.x / pts.length, sum.y / pts.length);
}

/**
 * 起点からの変位として選択を動かす。
 * 同じ delta で何度呼んでも結果が変わらないので、ドラッグ中に毎フレーム呼べる。
 */
export function placeSelection(scene: Scene, origins: MoveOrigins, delta: Vec): void {
  for (const [id, origin] of origins.nodes) {
    const node = scene.nodes[id];
    if (!node) continue;
    node.x = origin.x + delta.x;
    node.y = origin.y + delta.y;
  }
  for (const [id, origin] of origins.instances) {
    const inst = scene.instances[id];
    if (!inst) continue;
    inst.x = origin.x + delta.x;
    inst.y = origin.y + delta.y;
  }
  for (const [id, origin] of origins.roomLabels) {
    const label = scene.roomLabels[id];
    if (!label) continue;
    label.x = origin.x + delta.x;
    label.y = origin.y + delta.y;
  }
  for (const [id, origin] of origins.fixtures) {
    const f = scene.fixtures[id];
    if (!f) continue;
    f.x = origin.x + delta.x;
    f.y = origin.y + delta.y;
  }
  for (const [id, origin] of origins.measurements) {
    const m = scene.measurements[id];
    if (!m) continue;
    // z は触らない。平面で引きずっているので
    m.a.x = origin.a.x + delta.x;
    m.a.y = origin.a.y + delta.y;
    m.b.x = origin.b.x + delta.x;
    m.b.y = origin.b.y + delta.y;
  }
  for (const [id, origin] of origins.shapes) {
    if (!scene.shapes[id]) continue;
    // 寸法は「どちら側にどれだけ出すか」が本体なので、素直に平行移動しない
    scene.shapes[id] =
      origin.shape === 'dimension'
        ? moveDimension(scene, origin, delta)
        : transformShape(scene, origin, translation(delta));
  }
  for (const [id, origin] of origins.openings) {
    const opening = scene.openings[id];
    const wall = opening && scene.walls[opening.wallId];
    if (!opening || !wall) continue;
    const [a, b] = wallEnds(scene, wall);
    // 開口は壁に沿ってしか動けないので、変位を壁の向きに射影する
    const along = dot(delta, norm(sub(b, a)));
    const next = clampOpening(scene, opening.wallId, origin + along, opening.width, opening.id);
    if (next !== null) opening.offset = next;
  }
}

/** 現在位置に delta を加える。矢印キーの微調整のように一発で動かすとき用 */
export function translateSelection(scene: Scene, sel: ResolvedSelection, delta: Vec): void {
  placeSelection(scene, captureOrigins(scene, sel), delta);
}
