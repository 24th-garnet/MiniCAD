import { vec, type Bounds, type Vec } from './geometry.ts';
import { getLayer, isBuiltinLayer, type Layer, type LayerId } from './layer.ts';
import { nodePos, openingsOnWall, pruneOrphanNodes, wallEnds, wallsAtNode } from './ops.ts';
import { instanceVertices } from './block.ts';
import { openingFrame } from './shape.ts';
import { shapeVertices } from './shapes.ts';
import { DEFAULT_LAYER_FOR, type EntityRef, type EntityType, type Id, type Scene } from './types.ts';
import { pruneConstraints } from './constraintOps.ts';

/**
 * エンティティ種別ごとの操作をまとめた表。
 *
 * これを `Record<EntityType, ...>` で持つと、種別を足したときに型エラーで漏れが分かる。
 * 以前は削除・ピック・図面範囲・画層の判定がそれぞれ別の switch に散っていて、
 * 種別を足すたびに約20箇所を手で追従する必要があった。
 */
export interface EntityKind {
  label: string;
  table(scene: Scene): Record<Id, { id: Id }>;
  /** 所属する画層。ノードは画層を持たないので null */
  layerIdOf(scene: Scene, id: Id): LayerId | null;
  setLayerId(scene: Scene, id: Id, layerId: LayerId): boolean;
  /** 付随するもの（壁なら開口部）も巻き込んで消す */
  remove(scene: Scene, id: Id): boolean;
  /** 図面範囲に寄与する点 */
  points(scene: Scene, id: Id): Vec[];
}

export const ENTITY_KINDS: Record<EntityType, EntityKind> = {
  node: {
    label: '壁の端点',
    table: (scene) => scene.nodes,
    layerIdOf: () => null,
    setLayerId: () => false,
    remove: (scene, id) => {
      if (!scene.nodes[id]) return false;
      // ノードを消すと、そこに取り付く壁は行き場がなくなる
      for (const w of wallsAtNode(scene, id)) ENTITY_KINDS.wall.remove(scene, w.id);
      delete scene.nodes[id];
      return true;
    },
    points: (scene, id) => (scene.nodes[id] ? [nodePos(scene, id)] : []),
  },

  wall: {
    label: '壁',
    table: (scene) => scene.walls,
    layerIdOf: (scene, id) => scene.walls[id]?.layerId ?? null,
    setLayerId: (scene, id, layerId) => {
      const w = scene.walls[id];
      if (!w) return false;
      w.layerId = layerId;
      return true;
    },
    remove: (scene, id) => {
      if (!scene.walls[id]) return false;
      for (const op of openingsOnWall(scene, id)) delete scene.openings[op.id];
      delete scene.walls[id];
      return true;
    },
    points: (scene, id) => {
      const w = scene.walls[id];
      return w ? wallEnds(scene, w) : [];
    },
  },

  opening: {
    label: '建具',
    table: (scene) => scene.openings,
    layerIdOf: (scene, id) => scene.openings[id]?.layerId ?? null,
    setLayerId: (scene, id, layerId) => {
      const o = scene.openings[id];
      if (!o) return false;
      o.layerId = layerId;
      return true;
    },
    remove: (scene, id) => {
      if (!scene.openings[id]) return false;
      delete scene.openings[id];
      return true;
    },
    points: (scene, id) => {
      const o = scene.openings[id];
      const f = o ? openingFrame(scene, o) : null;
      return f ? [f.start, f.end] : [];
    },
  },

  blockInstance: {
    label: 'ブロック',
    table: (scene) => scene.instances,
    layerIdOf: (scene, id) => scene.instances[id]?.layerId ?? null,
    setLayerId: (scene, id, layerId) => {
      const inst = scene.instances[id];
      if (!inst) return false;
      inst.layerId = layerId;
      return true;
    },
    remove: (scene, id) => {
      if (!scene.instances[id]) return false;
      delete scene.instances[id];
      return true;
    },
    points: (scene, id) => {
      const inst = scene.instances[id];
      return inst ? instanceVertices(scene, inst) : [];
    },
  },

  shape: {
    label: '図形',
    table: (scene) => scene.shapes,
    layerIdOf: (scene, id) => scene.shapes[id]?.layerId ?? null,
    setLayerId: (scene, id, layerId) => {
      const s = scene.shapes[id];
      if (!s) return false;
      s.layerId = layerId;
      return true;
    },
    remove: (scene, id) => {
      if (!scene.shapes[id]) return false;
      delete scene.shapes[id];
      return true;
    },
    points: (scene, id) => {
      const s = scene.shapes[id];
      return s ? shapeVertices(scene, s) : [];
    },
  },

  roomLabel: {
    label: '室名',
    table: (scene) => scene.roomLabels,
    layerIdOf: (scene, id) => scene.roomLabels[id]?.layerId ?? null,
    setLayerId: (scene, id, layerId) => {
      const l = scene.roomLabels[id];
      if (!l) return false;
      l.layerId = layerId;
      return true;
    },
    remove: (scene, id) => {
      if (!scene.roomLabels[id]) return false;
      delete scene.roomLabels[id];
      return true;
    },
    points: (scene, id) => {
      const l = scene.roomLabels[id];
      return l ? [vec(l.x, l.y)] : [];
    },
  },
};

export const ENTITY_TYPES = Object.keys(ENTITY_KINDS) as EntityType[];

export function entityExists(scene: Scene, ref: EntityRef): boolean {
  return ENTITY_KINDS[ref.type].table(scene)[ref.id] !== undefined;
}

/** ref が属する画層。ノードは接続する壁から導くので、ここでは null を返す */
export function layerOfRef(scene: Scene, ref: EntityRef): Layer | null {
  const layerId = ENTITY_KINDS[ref.type].layerIdOf(scene, ref.id);
  if (layerId === null) return null;
  const fallback = DEFAULT_LAYER_FOR[ref.type as Exclude<EntityType, 'node'>];
  return getLayer(scene.layers, layerId, fallback);
}

/**
 * 選択できるか。画層が表示されていて、かつロックされていないこと。
 * ノードは「接続する壁のどれかが選択可能なら可」とする（ノード自身は画層を持たない）。
 */
export function isSelectable(scene: Scene, ref: EntityRef): boolean {
  if (ref.type === 'node') {
    const walls = wallsAtNode(scene, ref.id);
    if (walls.length === 0) return true;
    return walls.some((w) => isSelectable(scene, { type: 'wall', id: w.id }));
  }
  const layer = layerOfRef(scene, ref);
  return layer ? layer.visible && !layer.locked : true;
}

/**
 * スナップの対象にできるか。表示されていれば十分で、ロックは問わない。
 * 「ロックした図面にスナップして新しい線を引く」のは CAD の普通の使い方。
 */
export function isSnappable(scene: Scene, ref: EntityRef): boolean {
  if (ref.type === 'node') {
    const walls = wallsAtNode(scene, ref.id);
    if (walls.length === 0) return true;
    return walls.some((w) => isSnappable(scene, { type: 'wall', id: w.id }));
  }
  const layer = layerOfRef(scene, ref);
  return layer ? layer.visible : true;
}

/** 図面全体の範囲。zoomToFit・SVG・DXF が同じ計算を3箇所に持っていたのをここへ集約した */
export function sceneBounds(scene: Scene): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;

  for (const type of ENTITY_TYPES) {
    const kind = ENTITY_KINDS[type];
    for (const id of Object.keys(kind.table(scene))) {
      for (const p of kind.points(scene, id)) {
        any = true;
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
  }
  return any ? { min: vec(minX, minY), max: vec(maxX, maxY) } : null;
}

/**
 * 画層を消す。所属していたエンティティは種別ごとの既定画層へ移す。
 * 組み込みの画層は消せない（フォールバック先が無くなるため）。
 */
export function removeLayer(scene: Scene, id: LayerId): boolean {
  if (isBuiltinLayer(id) || !scene.layers[id]) return false;

  for (const type of ENTITY_TYPES) {
    if (type === 'node') continue;
    const kind = ENTITY_KINDS[type];
    const fallback = DEFAULT_LAYER_FOR[type as Exclude<EntityType, 'node'>];
    for (const entityId of Object.keys(kind.table(scene))) {
      if (kind.layerIdOf(scene, entityId) === id) kind.setLayerId(scene, entityId, fallback);
    }
  }
  delete scene.layers[id];
  return true;
}

/** 選択したものの画層をまとめて変える */
export function setLayerOf(scene: Scene, refs: EntityRef[], layerId: LayerId): boolean {
  if (!scene.layers[layerId]) return false;
  let changed = false;
  for (const ref of refs) {
    if (ENTITY_KINDS[ref.type].setLayerId(scene, ref.id, layerId)) changed = true;
  }
  return changed;
}

/** 削除。付随するものを巻き込んだあと、宙に浮いたノードを掃除する */
export function removeEntities(scene: Scene, refs: EntityRef[]): boolean {
  let changed = false;
  for (const ref of refs) {
    if (ENTITY_KINDS[ref.type].remove(scene, ref.id)) changed = true;
  }
  if (changed) {
    pruneOrphanNodes(scene);
    // 参照先の壁を失った拘束は、出口で一括して掃除する（個別の remove に書くより漏れない）
    pruneConstraints(scene);
  }
  return changed;
}
