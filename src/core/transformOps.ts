import { dist, vec, type Vec } from "./geometry.ts";
import { resolveSelection } from "./selection.ts";
import { transformShape } from "./shapes.ts";
import {
  applyPoint,
  directionAngleAfter,
  isMirror,
  type Transform,
} from "./transform.ts";
import { newId, type EntityRef, type Id, type Scene } from "./types.ts";
import { copyConstraints } from "./constraintOps.ts";
import { setLayerOf } from "./entity.ts";
import type { LayerId } from "./layer.ts";
import type { Attrs } from "./attrs.ts";

export interface TransformResult {
  /** 操作のあと選択しておくべきもの。複写なら複製側 */
  refs: EntityRef[];
  /** 複写で作った元ノード → 新ノードの対応 */
  nodeMap: Map<Id, Id>;
  /** 複写で作った元の壁 → 新しい壁の対応。拘束の複製に使う */
  wallMap: Map<Id, Id>;
}

export interface TransformOptions {
  /** 元を残して複製する */
  copy: boolean;
  /**
   * 複製先の画層（ワイヤー 5 枚目の「複製先のレイヤーを選択」）。
   * null なら元と同じ画層のまま。**複製のときだけ効く。**
   *
   * 画層を持たない実体（ノード）は黙って素通りする——`setLayerOf` の作法と同じ。
   */
  layerId?: LayerId | null;
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
  const movedWalls = Object.values(scene.walls).filter(
    (w) => nodeIds.has(w.a) && nodeIds.has(w.b),
  );

  return options.copy
    ? copyEntities(scene, sel, movedWalls, t, mirrored, options.layerId ?? null)
    : moveEntities(scene, sel, movedWalls, t, mirrored);
}

type Selection = ReturnType<typeof resolveSelection>;
type Wall = Scene["walls"][string];

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
  for (const id of sel.fixtureIds) {
    const f = scene.fixtures[id];
    if (!f) continue;
    const p = applyPoint(t, f);
    f.x = p.x;
    f.y = p.y;
    f.angle = directionAngleAfter(t, f.angle);
    // 柱・梁・直階段・箱は既定の輪郭が上下対称なので、角度を変えるだけで鏡像になる。
    // **自前の輪郭だけは別**——左右の区別があるので、鏡像ならローカルで裏返す。
    //
    // **直せていないもの。** `stairL` / `stairWinder` / `prism` は既定の輪郭が
    // 上下対称でないので、鏡像にしても形が裏返らない（L 字階段が同じ向きのまま、
    // 三角柱の頂点が同じ側に残る）。直すには既定の輪郭を `f.outline` に
    // 書き出すことになり、階段の段板（`stairTreads` が種別と大きさから引いていて
    // 輪郭を見ていない）が付いてこない。**傾きとは別の話**なので、ここでは触らない
    f.outline = mirrorOutline(f.outline, mirrored);
    f.tilt = mirrorTilt(f.tilt, mirrored);
  }
  if (mirrored) {
    const movedWallIds = new Set(movedWalls.map((w) => w.id));
    for (const op of Object.values(scene.openings)) {
      if (movedWallIds.has(op.wallId)) op.flipY = !op.flipY;
    }
  }

  const refs: EntityRef[] = [
    ...sel.nodeIds.map((id) => ({ type: "node" as const, id })),
    ...sel.instanceIds.map((id) => ({ type: "blockInstance" as const, id })),
    ...sel.roomLabelIds.map((id) => ({ type: "roomLabel" as const, id })),
    ...sel.shapeIds.map((id) => ({ type: "shape" as const, id })),
    ...sel.fixtureIds.map((id) => ({ type: "fixture" as const, id })),
  ];
  return { refs, nodeMap: new Map(), wallMap: new Map() };
}

/**
 * 複製が**属性を元と共有してしまう**のを防ぐ。
 *
 * `{ ...wall }` は浅い複製なので、`attrs`（と建具の `bay`）が**元と同じオブジェクト**を
 * 指したままになる。複製の素材や積算区分を変えると元まで変わり、
 * グループ化を入れれば「複製を選ぶと元まで選ばれる」になる。
 * `fixtures` だけは前から複製していたので、残りをそれに揃える。
 */
const freshAttrs = (attrs: Attrs): Attrs => ({ ...attrs });

/**
 * 自前の輪郭を複製する。鏡像なら**ローカル座標で上下を裏返す**。
 *
 * **なぜ y なのか。** `directionAngleAfter` は「ローカルの +x 軸を変換した向き」を
 * 新しい角度にする。つまり鏡映 M は `M·R(a) = R(a')·S` と分解されていて、
 * `S = R(-a')·M·R(a)` は **+x を動かさない行列式 −1 の直交行列**、
 * すなわち `diag(1, -1)`——上下の反転になる。どの軸で折り返しても同じ。
 *
 * 裏返すと巻きが時計回りになり、押し出しの法線が内を向くので、並びも戻す。
 */
const mirrorOutline = (
  outline: Vec[] | null,
  mirrored: boolean,
): Vec[] | null => {
  if (!outline) return null;
  const copy = outline.map((p) => vec(p.x, mirrored ? -p.y : p.y));
  return mirrored ? copy.reverse() : copy;
};

/**
 * 傾きを複製する。鏡像なら **x まわりだけ**符号が反転する。
 *
 * `mirrorOutline` と同じ分解を 3 次元でやる。鏡映のあとに残るローカルの変換は
 * `S = diag(1, −1, 1)`（上下の反転）で、向きは `S · Ry(ty) · Rx(tx)` になる。
 * これを `Ry(ty') · Rx(tx') · S` の形に直すと、
 *
 * - `S · Ry(t) · S = Ry(t)`——`Ry` は x と z を混ぜるだけで、S はどちらも触らない
 * - `S · Rx(t) · S = Rx(−t)`——`Rx` は y と z を混ぜるので、y が裏返ると回る向きも裏返る
 *
 * つまり **`tilt.y` は変わらず、`tilt.x` だけ符号が変わる。**
 * 式だけでは取り違えやすいので、テストは**倒した立体の面を鏡映した点**と
 * 突き合わせて見ている。
 *
 * **オブジェクトごと作り直す。** `{ ...f }` は浅いので、複製の傾きを直すと
 * 元まで変わる（`size` と `outline` が既に同じ理由で複製している）。
 */
const mirrorTilt = (
  tilt: { x: number; y: number } | null,
  mirrored: boolean,
): { x: number; y: number } | null =>
  tilt ? { x: mirrored ? -tilt.x : tilt.x, y: tilt.y } : null;

function copyEntities(
  scene: Scene,
  sel: Selection,
  movedWalls: Wall[],
  t: Transform,
  mirrored: boolean,
  layerId: LayerId | null,
): TransformResult {
  const nodeMap = new Map<Id, Id>();
  const refs: EntityRef[] = [];

  for (const id of sel.nodeIds) {
    const node = scene.nodes[id];
    if (!node) continue;
    const p = applyPoint(t, node);
    const newNodeId = newId("n");
    scene.nodes[newNodeId] = {
      id: newNodeId,
      x: p.x,
      y: p.y,
      levelId: node.levelId,
    };
    nodeMap.set(id, newNodeId);
  }

  const wallMap = new Map<Id, Id>();
  for (const wall of movedWalls) {
    const a = nodeMap.get(wall.a);
    const b = nodeMap.get(wall.b);
    if (!a || !b) continue;
    const newWallId = newId("w");
    scene.walls[newWallId] = {
      ...wall,
      id: newWallId,
      a,
      b,
      attrs: freshAttrs(wall.attrs),
    };
    wallMap.set(wall.id, newWallId);
    refs.push({ type: "wall", id: newWallId });
  }

  // 建具は所属する壁が複製されたときだけ複製する
  for (const op of Object.values(scene.openings)) {
    const newWallId = wallMap.get(op.wallId);
    if (!newWallId) continue;
    const newOpeningId = newId("o");
    scene.openings[newOpeningId] = {
      ...op,
      id: newOpeningId,
      wallId: newWallId,
      // 鏡像では法線の向きが反転するので、見た目どおりに開かせるには flipY を反転する
      flipY: mirrored ? !op.flipY : op.flipY,
      // 張り出しも入れ子のオブジェクト。共有すると複製の出を変えて元が動く
      bay: op.bay ? { ...op.bay } : null,
      attrs: freshAttrs(op.attrs),
    };
  }

  for (const id of sel.instanceIds) {
    const inst = scene.instances[id];
    if (!inst) continue;
    const p = applyPoint(t, inst);
    const newInstanceId = newId("i");
    scene.instances[newInstanceId] = {
      ...inst,
      id: newInstanceId,
      x: p.x,
      y: p.y,
      angle: directionAngleAfter(t, inst.angle),
      scaleX: mirrored ? -inst.scaleX : inst.scaleX,
      attrs: freshAttrs(inst.attrs),
    };
    refs.push({ type: "blockInstance", id: newInstanceId });
  }

  for (const id of sel.roomLabelIds) {
    const l = scene.roomLabels[id];
    if (!l) continue;
    const p = applyPoint(t, l);
    const newLabelId = newId("l");
    scene.roomLabels[newLabelId] = { ...l, id: newLabelId, x: p.x, y: p.y };
    refs.push({ type: "roomLabel", id: newLabelId });
  }

  for (const id of sel.shapeIds) {
    const s = scene.shapes[id];
    if (!s) continue;
    const newShapeId = newId("s");
    scene.shapes[newShapeId] = {
      ...transformShape(scene, s, t, nodeMap),
      id: newShapeId,
      attrs: freshAttrs(s.attrs),
    };
    refs.push({ type: "shape", id: newShapeId });
  }

  for (const id of sel.fixtureIds) {
    const f = scene.fixtures[id];
    if (!f) continue;
    const p = applyPoint(t, f);
    const newFixtureId = newId("f");
    scene.fixtures[newFixtureId] = {
      ...f,
      id: newFixtureId,
      x: p.x,
      y: p.y,
      angle: directionAngleAfter(t, f.angle),
      size: { ...f.size },
      // **配列ごと複製する。** `{ ...f }` は浅いので、複製の輪郭を直すと元まで変わる
      outline: mirrorOutline(f.outline, mirrored),
      tilt: mirrorTilt(f.tilt, mirrored),
      attrs: freshAttrs(f.attrs),
    };
    refs.push({ type: "fixture", id: newFixtureId });
  }

  // 全参照先が複製された拘束だけを写す。片側だけだと複製が元に引きずられて動く
  copyConstraints(scene, wallMap);

  // **複製してから画層を移す。** 作るときに画層を差し込むと、
  // 6 種別それぞれの生成式に同じ分岐が入る。出来たものをまとめて移すほうが短い
  if (layerId) setLayerOf(scene, refs, layerId);

  return { refs, nodeMap, wallMap };
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
