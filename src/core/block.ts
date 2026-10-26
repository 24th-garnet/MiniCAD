import { add, angleOf, boundsOf, dist, rotate, vec, type Bounds, type Vec } from './geometry.ts';
import { newId, type Id } from './id.ts';
import { LAYER_IDS, type LayerId } from './layer.ts';
import type { Primitive } from './primitive.ts';
import type { Segment } from './shape.ts';
import { shapeOutline, shapePrimitives, type Shape } from './shapes.ts';
import type { DrawingStandard } from './standard.ts';
import type { Scene } from './types.ts';

/**
 * ブロック定義。名前付きの図形の集合で、シーンに1つだけ持つ。
 * 中身はブロックのローカル座標（基点が原点）で持つ。
 *
 * 壁と建具は入れない。ノードのグラフを定義の中に持ち込むと、
 * 挿入のたびにノードを複製する羽目になり、部屋の自動検出とも噛み合わない。
 */
export interface BlockDef {
  id: Id;
  /** DXF の BLOCK 名。ASCII 英数と _ $ - に正規化済みで、一意 */
  name: string;
  /** 画面に出す名前。日本語可 */
  label: string;
  /** 自然な大きさ (mm)。インスタンスの尺度と掛けて寸法欄に出す */
  size: { w: number; h: number };
  shapes: Record<Id, Shape>;
  source: 'builtin' | 'user';
}

/**
 * ブロックの挿入。
 * 尺度は X と Y を別々に持つ。家具は同じ「ベッド」でもシングルとダブルで
 * 寸法が違うので、一様尺度に限ると表せない。
 * 非一様尺度では円が楕円になるが、DXF の INSERT (41/42) はそのまま表せる。
 */
export interface BlockInstance {
  id: Id;
  blockId: Id;
  layerId: LayerId;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  /** 回転角 (rad) */
  angle: number;
  /** 表示名の上書き。null なら定義の label */
  label: string | null;
  levelId: Id;
}

/** 定義座標系の点をワールドへ。尺度 → 回転 → 平行移動の順 */
export function instanceToWorld(inst: BlockInstance, p: Vec): Vec {
  return add(vec(inst.x, inst.y), rotate(vec(p.x * inst.scaleX, p.y * inst.scaleY), inst.angle));
}

/** インスタンスの見かけの寸法 (mm) */
export function instanceSize(def: BlockDef, inst: BlockInstance): { w: number; h: number } {
  return { w: def.size.w * Math.abs(inst.scaleX), h: def.size.h * Math.abs(inst.scaleY) };
}

/** 鏡像になっているか。円弧の向きを反転する必要がある */
export const instanceMirrored = (inst: BlockInstance): boolean => inst.scaleX * inst.scaleY < 0;

export function blockOf(scene: Scene, inst: BlockInstance): BlockDef | null {
  return scene.blocks[inst.blockId] ?? null;
}

/**
 * インスタンスを線分の集合として取り出す。
 * 当たり判定・範囲計算・プレビューが共有する。
 * 円や円弧は定義側で折れ線に近似されているので、非一様尺度でも楕円として正しく出る。
 */
export function instanceOutline(scene: Scene, inst: BlockInstance): Segment[] {
  const def = blockOf(scene, inst);
  if (!def) return [];
  const local = { ...scene, shapes: def.shapes };
  const out: Segment[] = [];
  for (const shape of Object.values(def.shapes)) {
    for (const seg of shapeOutline(local, shape)) {
      out.push({ a: instanceToWorld(inst, seg.a), b: instanceToWorld(inst, seg.b) });
    }
  }
  return out;
}

/**
 * 挿入したブロックの**外形の四隅**（反時計回り）。
 *
 * `instanceVertices` は輪郭線の端点を全部返す「点の集まり」で、多角形の環ではない。
 * 3D の押し出しのように「環として回したい」用途ではこちらを使う。
 */
export function instanceFootprint(scene: Scene, inst: BlockInstance): Vec[] {
  const def = blockOf(scene, inst);
  if (!def) return [];
  const { w, h } = def.size;
  // ブロックの図形は基点を中心に組まれている（blockPresets.ts の outlineRect と同じ）
  return [vec(-w / 2, -h / 2), vec(w / 2, -h / 2), vec(w / 2, h / 2), vec(-w / 2, h / 2)].map((p) =>
    instanceToWorld(inst, p),
  );
}

export function instanceVertices(scene: Scene, inst: BlockInstance): Vec[] {
  const out: Vec[] = [];
  for (const seg of instanceOutline(scene, inst)) out.push(seg.a, seg.b);
  return out.length > 0 ? out : [vec(inst.x, inst.y)];
}

export function instanceBounds(scene: Scene, inst: BlockInstance): Bounds | null {
  return boundsOf(instanceVertices(scene, inst));
}

/**
 * 描画用の中間表現。
 * 一様尺度なら円・円弧をそのまま残し、非一様なら折れ線に落として楕円にする。
 */
export function instancePrimitives(scene: Scene, inst: BlockInstance, std: DrawingStandard): Primitive[] {
  const def = blockOf(scene, inst);
  if (!def) return [];
  const local = { ...scene, shapes: def.shapes };
  const uniform = Math.abs(Math.abs(inst.scaleX) - Math.abs(inst.scaleY)) < 1e-9;
  const out: Primitive[] = [];

  for (const shape of Object.values(def.shapes)) {
    for (const prim of shapePrimitives(local, shape, std)) {
      out.push(...transformPrimitive(prim, inst, uniform, local, shape));
    }
  }
  return out;
}

function transformPrimitive(
  prim: Primitive,
  inst: BlockInstance,
  uniform: boolean,
  local: Scene,
  shape: Shape,
): Primitive[] {
  const to = (p: Vec) => instanceToWorld(inst, p);

  switch (prim.kind) {
    case 'segments':
      return [{ kind: 'segments', segments: prim.segments.map((s) => ({ a: to(s.a), b: to(s.b) })) }];

    case 'polygon':
      return [{ ...prim, points: prim.points.map(to) }];

    case 'text':
      // 注記の大きさは尺度に引きずられない方が読みやすい
      return [{ ...prim, at: to(prim.at), angle: prim.angle + inst.angle }];

    case 'circle':
    case 'arc': {
      if (!uniform) {
        // 楕円になるので折れ線へ落とす
        return [
          {
            kind: 'segments',
            segments: shapeOutline(local, shape).map((s) => ({ a: to(s.a), b: to(s.b) })),
          },
        ];
      }
      const scale = Math.abs(inst.scaleX);
      const mirrored = instanceMirrored(inst);
      const center = to(prim.kind === 'circle' ? prim.center : prim.center);
      if (prim.kind === 'circle') return [{ kind: 'circle', center, radius: prim.radius * scale }];
      const start = prim.startAngle + inst.angle;
      const end = prim.endAngle + inst.angle;
      // 鏡像では掃く向きが逆になるので、始点と終点を入れ替えて「常に反時計回り」を保つ
      return [
        {
          kind: 'arc',
          center,
          radius: prim.radius * scale,
          startAngle: mirrored ? -end : start,
          endAngle: mirrored ? -start : end,
        },
      ];
    }
  }
}

/** 表示する名前 */
export function instanceLabel(scene: Scene, inst: BlockInstance): string {
  return inst.label ?? blockOf(scene, inst)?.label ?? '';
}

/** 名前がその大きさの中に収まるか。和文は字幅がほぼ正方形なので文字数で見積もる */
export function labelFits(name: string, size: { w: number; h: number }, textSize: number): boolean {
  if (!name) return false;
  return [...name].length * textSize * 0.95 <= Math.max(size.w, size.h);
}

// --- 定義の作成・分解 ---

const NAME_SAFE = /[^A-Za-z0-9_$-]/g;

/** 日本語ラベルから DXF 用の一意な ASCII 名を作る */
export function sanitizeBlockName(label: string, taken: Set<string>): string {
  const ascii = label.normalize('NFKC').replace(NAME_SAFE, '');
  const base = ascii.length > 0 ? ascii.toUpperCase() : 'BLOCK';
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

/**
 * 選択した図形をブロックにする。
 * 元の図形は消え、同じ場所にインスタンスが1つ残る。
 */
export function defineBlock(scene: Scene, shapeIds: Id[], base: Vec, label: string): Id | null {
  const shapes = shapeIds.map((id) => scene.shapes[id]).filter((s): s is Shape => s !== undefined);
  if (shapes.length === 0) return null;

  const defId = newId('b');
  const taken = new Set(Object.values(scene.blocks).map((b) => b.name));
  const localShapes: Record<Id, Shape> = {};
  const vertices: Vec[] = [];

  // 基点を原点にしたローカル座標へ移す
  const shift = { a: -base.x, b: -base.y };
  for (const shape of shapes) {
    const moved = translateShape(shape, shift.a, shift.b);
    localShapes[moved.id] = moved;
    vertices.push(...shapeOutline({ ...scene, shapes: localShapes }, moved).flatMap((s) => [s.a, s.b]));
    delete scene.shapes[shape.id];
  }

  const b = boundsOf(vertices);
  scene.blocks[defId] = {
    id: defId,
    name: sanitizeBlockName(label, taken),
    label,
    size: b ? { w: b.max.x - b.min.x, h: b.max.y - b.min.y } : { w: 1, h: 1 },
    shapes: localShapes,
    source: 'user',
  };

  const instId = newId('i');
  scene.instances[instId] = {
    id: instId,
    blockId: defId,
    layerId: shapes[0].layerId,
    levelId: shapes[0].levelId,
    x: base.x,
    y: base.y,
    scaleX: 1,
    scaleY: 1,
    angle: 0,
    label: null,
  };
  return instId;
}

/** インスタンスを消して、中身をワールド座標の図形として戻す */
export function explodeInstance(scene: Scene, instId: Id): Id[] {
  const inst = scene.instances[instId];
  const def = inst ? blockOf(scene, inst) : null;
  if (!inst || !def) return [];

  const created: Id[] = [];
  for (const shape of Object.values(def.shapes)) {
    const worldShape = mapShapePoints(shape, (p) => instanceToWorld(inst, p));
    const id = newId('s');
    scene.shapes[id] = { ...worldShape, id, layerId: inst.layerId };
    created.push(id);
  }
  delete scene.instances[instId];
  return created;
}

export function blockUsageCount(scene: Scene, blockId: Id): number {
  return Object.values(scene.instances).filter((i) => i.blockId === blockId).length;
}

/** どこからも使われていないユーザー定義ブロックを消す */
export function purgeUnusedBlocks(scene: Scene): Id[] {
  const removed: Id[] = [];
  for (const def of Object.values(scene.blocks)) {
    if (def.source === 'builtin') continue;
    if (blockUsageCount(scene, def.id) > 0) continue;
    delete scene.blocks[def.id];
    removed.push(def.id);
  }
  return removed;
}

export function renameBlock(scene: Scene, id: Id, label: string): boolean {
  const def = scene.blocks[id];
  const trimmed = label.trim();
  if (!def || !trimmed || trimmed === def.label) return false;
  def.label = trimmed;
  const taken = new Set(Object.values(scene.blocks).filter((b) => b.id !== id).map((b) => b.name));
  def.name = sanitizeBlockName(trimmed, taken);
  return true;
}

// --- 図形の座標を写す小道具 ---

function translateShape(shape: Shape, dx: number, dy: number): Shape {
  return mapShapePoints(shape, (p) => vec(p.x + dx, p.y + dy));
}

/**
 * 図形の持つ点をまとめて写す。
 * 角度を持つもの（円弧・文字）は回転を伴う変換では別途直す必要があるが、
 * ここで使うのは平行移動と、インスタンスの合成変換だけ。
 */
function mapShapePoints(shape: Shape, f: (p: Vec) => Vec): Shape {
  switch (shape.shape) {
    case 'line':
      return { ...shape, a: f(shape.a), b: f(shape.b) };
    case 'polyline':
      return { ...shape, points: shape.points.map(f) };
    case 'arc': {
      const center = f(shape.center);
      const from = f(add(shape.center, vec(Math.cos(shape.startAngle) * shape.radius, Math.sin(shape.startAngle) * shape.radius)));
      const to = f(add(shape.center, vec(Math.cos(shape.endAngle) * shape.radius, Math.sin(shape.endAngle) * shape.radius)));
      return {
        ...shape,
        center,
        radius: dist(center, from),
        startAngle: angleOf({ x: from.x - center.x, y: from.y - center.y }),
        endAngle: angleOf({ x: to.x - center.x, y: to.y - center.y }),
      };
    }
    case 'circle': {
      const center = f(shape.center);
      const edge = f(add(shape.center, vec(shape.radius, 0)));
      return { ...shape, center, radius: dist(center, edge) };
    }
    case 'text':
      return { ...shape, at: f(shape.at) };
    case 'point':
      return { ...shape, at: f(shape.at) };
    case 'dimension':
      return {
        ...shape,
        a: { ...f(vec(shape.a.x, shape.a.y)), nodeId: null },
        b: { ...f(vec(shape.b.x, shape.b.y)), nodeId: null },
      };
  }
}

export { LAYER_IDS };
