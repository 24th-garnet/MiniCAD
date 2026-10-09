import { dist, type Vec } from './geometry.ts';
import { resolveSelection } from './selection.ts';
import { transformShape } from './shapes.ts';
import { applyPoint, directionAngleAfter, isMirror, type Transform } from './transform.ts';
import { newId, type EntityRef, type Id, type Scene } from './types.ts';

export interface TransformResult {
  /** 操作のあと選択しておくべきもの。複写なら複製側 */
  refs: EntityRef[];
  /** 複写で作った元ノード → 新ノードの対応 */
  nodeMap: Map<Id, Id>;
}

export interface TransformOptions {
  /** 元を残して複製する */
  copy: boolean;
}

/**
 * 選択にアフィン変換を適用する。移動・複写・回転・鏡像がすべてここを通る。
 *
 * 守っている規則:
 * - 壁は**両端が選択に含まれるものだけ**が対象。片端しか選ばれていない壁を複製すると
 *   行き場のない壁ができてしまう
 * - 複写では新しいノードを明示的に作る。`findOrCreateNode` を通すと、変位ゼロの複写が
 *   元の壁に溶接されてしまう
 * - `mergeNodesAt` はここでは呼ばない。必要かどうかは呼び出し側（移動系のツール）が決める
 */
export function transformEntities(
  scene: Scene,
  refs: EntityRef[],
  t: Transform,
  options: TransformOptions,
): TransformResult {
  const sel = resolveSelection(scene, refs);
  const nodeIds = new Set(sel.nodeIds);
  const mirrored = isMirror(t);

  // 両端が動く壁だけが「変換される壁」
  const movedWalls = Object.values(scene.walls).filter((w) => nodeIds.has(w.a) && nodeIds.has(w.b));

  return options.copy
    ? copyEntities(scene, sel, movedWalls, t, mirrored)
    : moveEntities(scene, sel, movedWalls, t, mirrored);
}

type Selection = ReturnType<typeof resolveSelection>;
type Wall = Scene['walls'][string];

function moveEntities(
  scene: Scene,
  sel: Selection,
  movedWalls: Wall[],
  t: Transform,
  mirrored: boolean,
): TransformResult {
  for (const id of sel.nodeIds) {
    const node = scene.nodes[id];
    if (!node) continue;
    const p = applyPoint(t, node);
    node.x = p.x;
    node.y = p.y;
  }
  for (const id of sel.instanceIds) {
    const inst = scene.instances[id];
    if (!inst) continue;
    const p = applyPoint(t, inst);
    inst.x = p.x;
    inst.y = p.y;
    inst.angle = directionAngleAfter(t, inst.angle);
    // 鏡像では左右が入れ替わる。尺度の符号で表す
    if (mirrored) inst.scaleX = -inst.scaleX;
  }
  for (const id of sel.roomLabelIds) {
    const l = scene.roomLabels[id];
    if (!l) continue;
    const p = applyPoint(t, l);
    l.x = p.x;
    l.y = p.y;
  }
  for (const id of sel.shapeIds) {
    const s = scene.shapes[id];
    if (s) scene.shapes[id] = transformShape(scene, s, t, null);
  }
  if (mirrored) {
    const movedWallIds = new Set(movedWalls.map((w) => w.id));
    for (const op of Object.values(scene.openings)) {
      if (movedWallIds.has(op.wallId)) op.flipY = !op.flipY;
    }
  }

  const refs: EntityRef[] = [
    ...sel.nodeIds.map((id) => ({ type: 'node' as const, id })),
    ...sel.instanceIds.map((id) => ({ type: 'blockInstance' as const, id })),
    ...sel.roomLabelIds.map((id) => ({ type: 'roomLabel' as const, id })),
    ...sel.shapeIds.map((id) => ({ type: 'shape' as const, id })),
  ];
  return { refs, nodeMap: new Map() };
}

function copyEntities(
  scene: Scene,
  sel: Selection,
  movedWalls: Wall[],
  t: Transform,
  mirrored: boolean,
): TransformResult {
  const nodeMap = new Map<Id, Id>();
  const refs: EntityRef[] = [];

  for (const id of sel.nodeIds) {
    const node = scene.nodes[id];
    if (!node) continue;
    const p = applyPoint(t, node);
    const newNodeId = newId('n');
    scene.nodes[newNodeId] = { id: newNodeId, x: p.x, y: p.y };
    nodeMap.set(id, newNodeId);
  }

  const wallMap = new Map<Id, Id>();
  for (const wall of movedWalls) {
    const a = nodeMap.get(wall.a);
    const b = nodeMap.get(wall.b);
    if (!a || !b) continue;
    const newWallId = newId('w');
    scene.walls[newWallId] = { ...wall, id: newWallId, a, b };
    wallMap.set(wall.id, newWallId);
    refs.push({ type: 'wall', id: newWallId });
  }

  // 建具は所属する壁が複製されたときだけ複製する
  for (const op of Object.values(scene.openings)) {
    const newWallId = wallMap.get(op.wallId);
    if (!newWallId) continue;
    const newOpeningId = newId('o');
    scene.openings[newOpeningId] = {
      ...op,
      id: newOpeningId,
      wallId: newWallId,
      // 鏡像では法線の向きが反転するので、見た目どおりに開かせるには flipY を反転する
      flipY: mirrored ? !op.flipY : op.flipY,
    };
  }

  for (const id of sel.instanceIds) {
    const inst = scene.instances[id];
    if (!inst) continue;
    const p = applyPoint(t, inst);
    const newInstanceId = newId('i');
    scene.instances[newInstanceId] = {
      ...inst,
      id: newInstanceId,
      x: p.x,
      y: p.y,
      angle: directionAngleAfter(t, inst.angle),
      scaleX: mirrored ? -inst.scaleX : inst.scaleX,
    };
    refs.push({ type: 'blockInstance', id: newInstanceId });
  }

  for (const id of sel.roomLabelIds) {
    const l = scene.roomLabels[id];
    if (!l) continue;
    const p = applyPoint(t, l);
    const newLabelId = newId('l');
    scene.roomLabels[newLabelId] = { ...l, id: newLabelId, x: p.x, y: p.y };
    refs.push({ type: 'roomLabel', id: newLabelId });
  }

  for (const id of sel.shapeIds) {
    const s = scene.shapes[id];
    if (!s) continue;
    const newShapeId = newId('s');
    scene.shapes[newShapeId] = { ...transformShape(scene, s, t, nodeMap), id: newShapeId };
    refs.push({ type: 'shape', id: newShapeId });
  }

  return { refs, nodeMap };
}

/**
 * 何も起きない変換か。
 * 変位ゼロの複写を許すと、同じ位置に二重の壁ができて部屋検出が面積ゼロの
 * フェイスを吐くので、呼び出し側はこれで弾いてから commit する。
 */
export function isNoopTransform(t: Transform, reference: Vec): boolean {
  const moved = dist(reference, applyPoint(t, reference));
  const rotated = Math.abs(directionAngleAfter(t, 0));
  return moved < 1e-6 && rotated < 1e-9 && !isMirror(t);
}
