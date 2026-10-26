import { signedArea, vec, type Vec } from '../core/geometry.ts';
import { instanceFootprint } from '../core/block.ts';
import { levelOf, wallHeightOf, type Level } from '../core/level.ts';
import { OPENING_SYMBOLS, openingVertical } from '../core/opening.ts';
import { doorSwing, openingFrame, wallPointAt, wallSpans } from '../core/shape.ts';
import { BLOCK_HEIGHTS, DEFAULT_BLOCK_HEIGHT } from '../core/blockPresets.ts';
import { blockOf } from '../core/block.ts';
import { isSnappable } from '../core/entity.ts';
import { theme } from '../render/theme.ts';
import type { Room, Scene } from '../core/types.ts';
import { cross3, normalize3, sub3, vec3, type Vec3 } from './mat4.ts';

/**
 * 立体の1面。頂点は**外向き法線に対して反時計回り**に並べる。
 *
 * 法線は押し出した時点で確定するので、あとから `signedArea` で直したりしない。
 * 2D の `drawWalls` が「描くときに向きを揃える」のと違い、3D は生成時に正しく出す。
 */
export interface Face3 {
  points: Vec3[];
  normal: Vec3;
  color: string;
  /** ペインターズ法の層。この順に描く */
  bucket: Bucket;
  /** 裏からも見える面（床・ガラス） */
  doubleSided?: boolean;
}

export type Bucket = 'floor' | 'wall' | 'furniture' | 'glass';

/** 描く順。床は壁と交差しないので、この固定順が常に正しい */
export const BUCKET_ORDER: Bucket[] = ['floor', 'wall', 'furniture', 'glass'];

/** 建具の板の厚み (mm) */
const PANEL_THICKNESS = 40;

/**
 * シーン全体を立体にする。**階をまたいで全部立てる。**
 *
 * 床の高さ（`Level.floorZ`）が階ごとに違うので、同じ平面に重ならない。
 * 描く順（`BUCKET_ORDER`）は階に関係なく正しいまま——床が壁と交差しない、
 * という性質は階の中で閉じているため。
 */
export function buildMesh(scene: Scene, rooms: Room[]): Face3[] {
  const out: Face3[] = [];

  // 床は内法ポリゴン。壁芯で作ると壁と必ず交差し、どうソートしても破綻する
  for (const room of rooms) {
    const poly = room.innerPolygon;
    if (poly.length < 3) continue;
    const level = levelOf(scene, scene.walls[room.wallIds[0]]?.levelId ?? scene.activeLevelId);
    out.push(flatFace(poly, level.floorZ, theme.floor3d, 'floor'));
  }

  for (const wall of Object.values(scene.walls)) {
    if (!isSnappable(scene, { type: 'wall', id: wall.id })) continue;
    extrudeWall(scene, wall.id, levelOf(scene, wall.levelId), out);
  }

  for (const inst of Object.values(scene.instances)) {
    if (!isSnappable(scene, { type: 'blockInstance', id: inst.id })) continue;
    const def = blockOf(scene, inst);
    if (!def) continue;
    const height = BLOCK_HEIGHTS[def.id] ?? DEFAULT_BLOCK_HEIGHT;
    if (height <= 0) continue; // 階段のように箱で表すと嘘になるものは立てない
    const { floorZ } = levelOf(scene, inst.levelId);
    extrudePrism(instanceFootprint(scene, inst), floorZ, floorZ + height, theme.furniture3d, 'furniture', out);
  }

  return out;
}

function extrudeWall(scene: Scene, wallId: string, level: Level, out: Face3[]): void {
  const wall = scene.walls[wallId];
  const ws = wallSpans(scene, wall);
  if (!ws) return;
  const z0 = level.floorZ;
  const z1 = z0 + wallHeightOf(wall, level);
  const at = (along: number, side: number): Vec => wallPointAt(ws, along, side);
  const box = (lo: number, hi: number, bottom: number, top: number) => {
    if (hi - lo < 1e-6 || top - bottom < 1e-6) return;
    extrudePrism([at(lo, -1), at(hi, -1), at(hi, 1), at(lo, 1)], bottom, top, theme.wall3d, 'wall', out);
  };

  // 開口に食われていない区間
  for (const [lo, hi] of ws.spans) box(lo, hi, z0, z1);

  for (const hole of ws.holes) {
    const { sill, head } = openingVertical(hole.opening, level);
    const bottom = Math.max(z0, Math.min(sill, z1));
    const top = Math.max(z0, Math.min(head, z1));

    // 腰壁とまぐさ
    box(hole.lo, hole.hi, z0, bottom);
    box(hole.lo, hole.hi, top, z1);

    if (top - bottom < 1e-6) continue;

    // 小口（ジャム）と、窓台の上面・まぐさの下面。
    // これが無いと開口部で壁の厚みが見えず、紙を切り抜いたように見える
    for (const [along, sign] of [
      [hole.lo, -1],
      [hole.hi, 1],
    ] as const) {
      out.push(
        verticalFace(at(along, -sign), at(along, sign), bottom, top, theme.wall3d, 'wall'),
      );
    }
    if (bottom > z0 + 1e-6) out.push(flatFace([at(hole.lo, -1), at(hole.hi, -1), at(hole.hi, 1), at(hole.lo, 1)], bottom, theme.wall3d, 'wall'));
    if (top < z1 - 1e-6) {
      out.push(downwardFace([at(hole.lo, -1), at(hole.hi, -1), at(hole.hi, 1), at(hole.lo, 1)], top, theme.wall3d, 'wall'));
    }

    pushLeaf(scene, hole.opening.id, bottom, top, out);
  }
}

/**
 * 建具そのもの。窓はガラス1枚、戸は板1枚。
 * 平面の記号と同じく `family` で分け、開き戸は `doorSwing` の開いた位置に立てる。
 */
function pushLeaf(scene: Scene, openingId: string, bottom: number, top: number, out: Face3[]): void {
  const opening = scene.openings[openingId];
  const frame = openingFrame(scene, opening);
  if (!frame) return;
  const symbol = OPENING_SYMBOLS[opening.kind];

  if (symbol.family === 'window') {
    // ガラスは壁芯に1枚。裏からも見えるので両面
    out.push({
      ...verticalFace(frame.start, frame.end, bottom, top, theme.glass3d, 'glass'),
      doubleSided: true,
    });
    return;
  }

  if (opening.kind === 'opening') return; // 建具なしの出入口

  if (opening.kind === 'door' || opening.kind === 'doubleDoor' || opening.kind === 'unequalDoor') {
    // 開き戸は開いた位置に立てる。平面図の円弧と同じ姿勢になる
    const swing = doorSwing(frame, opening.flipX, opening.flipY);
    panel(swing.hinge, swing.open, bottom, top, out);
    return;
  }

  // 引戸・折戸は開口の上に寝かせる
  panel(frame.start, frame.end, bottom, top, out);
}

function panel(a: Vec, b: Vec, bottom: number, top: number, out: Face3[]): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const nx = (-dy / len) * (PANEL_THICKNESS / 2);
  const ny = (dx / len) * (PANEL_THICKNESS / 2);
  const poly = [
    vec(a.x - nx, a.y - ny),
    vec(b.x - nx, b.y - ny),
    vec(b.x + nx, b.y + ny),
    vec(a.x + nx, a.y + ny),
  ];
  extrudePrism(poly, bottom, top, theme.door3d, 'furniture', out);
}

// --- 面の組み立て ---

/** 上向きの面。頂点は反時計回りに揃える */
function flatFace(poly: Vec[], z: number, color: string, bucket: Bucket): Face3 {
  const points = ccw(poly).map((p) => vec3(p.x, p.y, z));
  return { points, normal: vec3(0, 0, 1), color, bucket, doubleSided: bucket === 'floor' };
}

/** 下向きの面（まぐさの下端など） */
function downwardFace(poly: Vec[], z: number, color: string, bucket: Bucket): Face3 {
  const points = ccw(poly).map((p) => vec3(p.x, p.y, z)).reverse();
  return { points, normal: vec3(0, 0, -1), color, bucket };
}

/**
 * 縦の1枚。`a → b` の進行方向に対して左が表になる。
 * 四隅は a(bottom) → a(top) → b(top) → b(bottom) の順で、法線は左向き。
 */
function verticalFace(a: Vec, b: Vec, bottom: number, top: number, color: string, bucket: Bucket): Face3 {
  const points = [
    vec3(a.x, a.y, bottom),
    vec3(a.x, a.y, top),
    vec3(b.x, b.y, top),
    vec3(b.x, b.y, bottom),
  ];
  return { points, normal: faceNormal(points), color, bucket };
}

/**
 * 平面の多角形を上下に押し出して箱にする。壁・家具・戸板がすべてこれを通る。
 * 頂点を反時計回りに揃えてから回すので、側面の外向きが自動的に決まる。
 */
export function extrudePrism(
  poly: Vec[],
  bottom: number,
  top: number,
  color: string,
  bucket: Bucket,
  out: Face3[],
): void {
  if (poly.length < 3 || top - bottom < 1e-6) return;
  const ring = ccw(poly);

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) continue; // 長さ 0 の辺は面にならない
    // 反時計回りの辺では、進行方向の右が外。verticalFace は左が表なので b → a で渡す
    out.push(verticalFace(b, a, bottom, top, color, bucket));
  }
  out.push(flatFace(ring, top, color, bucket));
  out.push(downwardFace(ring, bottom, color, bucket));
}

/** 連続する重複点を落としてから、反時計回りに揃える */
function ccw(poly: Vec[]): Vec[] {
  const ring: Vec[] = [];
  for (const p of poly) {
    const last = ring[ring.length - 1];
    if (last && Math.hypot(last.x - p.x, last.y - p.y) < 1e-9) continue;
    ring.push(p);
  }
  if (ring.length > 1) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-9) ring.pop();
  }
  return signedArea(ring) < 0 ? ring.reverse() : ring;
}

/** 最初の3点から法線を出す。縮退していたら +z に落とす */
function faceNormal(points: Vec3[]): Vec3 {
  for (let i = 2; i < points.length; i++) {
    const n = cross3(sub3(points[1], points[0]), sub3(points[i], points[0]));
    if (Math.hypot(n.x, n.y, n.z) > 1e-9) return normalize3(n);
  }
  return vec3(0, 0, 1);
}
