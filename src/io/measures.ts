import { blockOf, instanceLabel } from '../core/block.ts';
import { wallHeightOf } from '../core/level.ts';
import { openingVertical } from '../core/opening.ts';
import { openingsOnWall } from '../core/ops.ts';
import { nestingOf, perimeterOf, roomAt } from '../core/rooms.ts';
import { wallSpans } from '../core/shape.ts';
import { vec } from '../core/geometry.ts';
import type { Opening, Room, Scene } from '../core/types.ts';

/**
 * 数量拾いへ渡す中立の実測 JSON を作る。
 *
 * **拾い方の知識は持たない。** 開口を差し引くかどうか、巾木をどこから引くか、
 * どの仕上げを当てるかは積算の規約で、現場ごとに動く。ここが出すのは
 * **解決済みの幾何**だけ ——面積・周長・開口を抜いた壁の正味長さ・員数。
 *
 * 幾何を知っているのはこちらだけなので、ここで数にして渡す。拾い側で計算し直すと、
 * **同じ部屋の面積が道具によって違う**という最悪の形で破綻する。
 *
 * **測ったものと仮定したものを区別する。** `wall.height === null` や
 * `opening.sillHeight === null` は「階の既定に落ちた」ことを型が教えてくれるので、
 * `basis: '既定'` が機械的に立つ。新しいフラグは要らない。
 */

/** 契約の版。拾い側がこれを見て断る */
export const SCHEMA = 'mdr-measures-1';

/** 根拠の語彙。拾い側の `basis.STRENGTH` と同じもの */
type Basis = '実測' | '推定' | '代用' | '既定' | '外接' | '未検出' | '未計測';

export interface MeasuresOptions {
  planId: string;
  name?: string;
}

export interface MeasuresFile {
  schema_version: string;
  source: string;
  plan_id: string;
  name: string;
  rooms: MeasuredRoom[];
  basis: Record<string, Basis>;
  basis_note: Record<string, string>;
}

export interface MeasuredRoom {
  id: string;
  name: string;
  floor_area: number;
  ceiling_area: number;
  perimeter: number;
  height: number;
  wall_area: number;
  openings: { id: string; kind: string; width: number; height: number; sill: number }[];
  furniture: { code: string; label: string; count: number }[];
  basis: Record<string, Basis>;
  basis_note: Record<string, string>;
}

const round = (v: number, digits = 3): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** 開口を抜いた壁の正味長さ (mm)。`wallSpans` の区間を足すだけ */
function netLength(scene: Scene, wallId: string): number {
  const wall = scene.walls[wallId];
  if (!wall) return 0;
  const ws = wallSpans(scene, wall);
  if (!ws) return 0;
  return ws.spans.reduce((sum, [lo, hi]) => sum + Math.max(0, hi - lo), 0);
}

/** 部屋に面している開口。壁の重複を畳む */
function openingsOf(scene: Scene, room: Room): Opening[] {
  const seen = new Set<string>();
  const out: Opening[] = [];
  for (const wallId of room.wallIds) {
    if (seen.has(wallId)) continue;
    seen.add(wallId);
    out.push(...openingsOnWall(scene, wallId));
  }
  return out;
}

/** 部屋の中に置かれたブロックを品目ごとに数える */
function furnitureOf(scene: Scene, rooms: Room[], room: Room) {
  const counts = new Map<string, { code: string; label: string; count: number }>();
  for (const inst of Object.values(scene.instances)) {
    if (roomAt(rooms, vec(inst.x, inst.y)) !== room) continue;
    const def = blockOf(scene, inst);
    if (!def) continue;
    // 標準ブロックは `blockId === preset.id` の安定したスラッグ
    const code = def.source === 'builtin' ? def.id : def.name;
    const got = counts.get(code);
    if (got) got.count += 1;
    else counts.set(code, { code, label: instanceLabel(scene, inst), count: 1 });
  }
  return [...counts.values()].sort((a, b) => (a.code < b.code ? -1 : 1));
}

export function sceneToMeasures(
  scene: Scene,
  rooms: Room[],
  options: MeasuresOptions,
): MeasuresFile {
  const level = scene.level;
  const nesting = nestingOf(rooms);

  const out: MeasuredRoom[] = rooms.map((room, index) => {
    // 入れ子（柱型・PS）を引く。引かないと床も天井も仕上げが多すぎる数になる
    const inner = nesting.get(index) ?? [];
    const holeArea = inner.reduce((sum, i) => sum + rooms[i].innerArea, 0);
    const holePerimeter = inner.reduce(
      (sum, i) => sum + perimeterOf(rooms[i].innerPolygon),
      0,
    );
    const floor = Math.max(room.innerArea - holeArea, 0);

    // 巾木・回り縁は柱型の周りを回るので、**周長には足す**
    const perimeter = perimeterOf(room.innerPolygon) + holePerimeter;

    // 壁の高さは壁ごとに違いうるので、面積は壁ごとに積む
    const seen = new Set<string>();
    let wallArea = 0;
    let anyDefaultHeight = false;
    for (const wallId of room.wallIds) {
      if (seen.has(wallId)) continue;
      seen.add(wallId);
      const wall = scene.walls[wallId];
      if (!wall) continue;
      if (wall.height === null) anyDefaultHeight = true;
      wallArea += (netLength(scene, wallId) * wallHeightOf(wall, level)) / 1e6;
    }

    const openings = openingsOf(scene, room).map((o) => {
      const v = openingVertical(o, level);
      return {
        id: o.id,
        kind: o.kind as string,
        width: Math.round(o.width),
        height: Math.round(v.head - v.sill),
        sill: Math.round(v.sill - level.floorZ),
      };
    });

    const basis: Record<string, Basis> = {};
    const note: Record<string, string> = {};
    if (anyDefaultHeight) {
      basis.height = '既定';
      note.height = `壁の高さを持たない壁がある。階の既定 ${level.wallHeight}mm`;
    }
    if (inner.length > 0) {
      basis.area = '推定';
      note.area = `入れ子の ${inner.length} 室を控除した`;
    }

    return {
      id: room.labelId ?? `r${index + 1}`,
      name: room.name ?? '',
      floor_area: round(floor),
      ceiling_area: round(floor),
      perimeter: Math.round(perimeter),
      height: Math.round(level.wallHeight),
      wall_area: round(wallArea),
      openings,
      furniture: furnitureOf(scene, rooms, room),
      basis,
      basis_note: note,
    };
  });

  return {
    schema_version: SCHEMA,
    source: 'minicad',
    plan_id: options.planId,
    name: options.name ?? options.planId,
    rooms: out,
    // **天井高を持っていない。** 壁高で代用していることを名乗る
    basis: { ceiling_height: '代用', swing: '未計測' },
    basis_note: {
      ceiling_height: '天井高を持たないので壁高を置いた',
      swing: '建具の開き勝手は記号としては持つが、寸法として持っていない',
    },
  };
}

export function measuresToJson(file: MeasuresFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
