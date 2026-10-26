import { blockOf, instanceLabel } from '../core/block.ts';
import { levelOf, wallHeightOf, type Level } from '../core/level.ts';
import { openingVertical } from '../core/opening.ts';
import { openingsOnWall } from '../core/ops.ts';
import { nestingOf, perimeterOf, roomAt } from '../core/rooms.ts';
import { wallSpans } from '../core/shape.ts';
import { vec } from '../core/geometry.ts';
import type { Opening, Room, Scene } from '../core/types.ts';
import type { TakeoffMode } from '../core/attrs.ts';

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
 *
 * **素材と積算の可否だけは別。** あれは導けない——作図者が宣言した意図で、
 * 幾何のどこにも書いていない。だから `Attrs` という明示の欄がある。
 * 「MiniCAD は拾い方の規約を持たない」は変わらない。規約ではなく、
 * **その図面について人が決めたこと**を運んでいる。
 *
 * **建具の「対象外」は効かない。** 拾い側は `openings[]` を品目の数え上げと
 * 壁面積の控除の**両方**に使っているので、外すと穴が無かったことになって
 * 壁が多く出る。穴は実在する幾何なので、外さない。
 */

/** 人が「拾わない」と決めたか。**未指定（null）は対象外ではない** */
const isExcluded = (attrs: { takeoff: TakeoffMode | null }): boolean => attrs.takeoff === 'excluded';

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
  openings: {
    id: string;
    kind: string;
    /** 建具符号。平面では同じ記号になる建具を区別する唯一の手がかり */
    designation: string;
    leaves: number;
    width: number;
    height: number;
    sill: number;
  }[];
  furniture: { code: string; label: string; count: number }[];
  /**
   * 面を個体として分けたもの。**仕上げを面ごとに選んだときだけ出す。**
   *
   * 拾い側は「面が来ている種類は室ごとの行を作らない」ので、出すなら
   * **その種類の面を全部**出す必要がある。1 面でも漏らすと、その面が
   * 見積書から黙って消える。
   */
  surfaces?: MeasuredSurface[];
  basis: Record<string, Basis>;
  basis_note: Record<string, string>;
}

export interface MeasuredSurface {
  id: string;
  kind: 'wall' | 'floor' | 'ceiling';
  /** 上流で選んだ仕上げ。**空なら室ごとの選択に落ちる** */
  finish: string;
  /** 壁のみ */
  length?: number;
  height?: number;
  /** 床・天井のみ */
  area?: number;
  /** この面に属する開口の id */
  openings?: string[];
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
    if (isExcluded(inst.attrs)) continue;
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

/**
 * 面を個体として分ける。**仕上げが選ばれている種類だけ**を出す。
 *
 * 拾い側（QuantityTakeoff）は、ある種類の面が 1 枚でも来ていれば
 * その種類の室ごとの行を作らない。だから**出すならその種類を全部**出す。
 * 1 面でも漏らすと、その面が見積書から黙って消える。
 *
 * 床と天井の仕上げは室名ラベルが持つ。`Room` は壁から導く派生データで
 * id を持たず、位置依存の id に落ちるので、そこに紐づけると壁を 1 本
 * 足しただけで別の部屋のものになる。
 */
function surfacesOf(
  scene: Scene,
  room: Room,
  level: Level,
  floorArea: number,
  roomOpeningIds: string[],
): MeasuredSurface[] {
  const out: MeasuredSurface[] = [];
  const known = new Set(roomOpeningIds);

  // --- 壁。1 面でも素材が付いていれば、その部屋の壁を全部出す ---
  const seen = new Set<string>();
  const walls = room.wallIds
    .filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
    .map((id) => scene.walls[id])
    .filter((w): w is NonNullable<typeof w> => Boolean(w) && !isExcluded(w.attrs));
  if (walls.some((w) => w.attrs.materialRef)) {
    for (const wall of walls) {
      out.push({
        id: wall.id,
        kind: 'wall',
        finish: wall.attrs.materialRef ?? '',
        length: Math.round(netLength(scene, wall.id)),
        height: Math.round(wallHeightOf(wall, level)),
        openings: openingsOnWall(scene, wall.id).map((o) => o.id).filter((id) => known.has(id)),
      });
    }
  }

  // --- 床と天井。室名ラベルが持つ ---
  const label = room.labelId ? scene.roomLabels[room.labelId] : null;
  if (label?.floorMaterial) {
    out.push({ id: '__floor__', kind: 'floor', finish: label.floorMaterial, area: round(floorArea) });
  }
  if (label?.ceilingMaterial) {
    out.push({ id: '__ceiling__', kind: 'ceiling', finish: label.ceilingMaterial, area: round(floorArea) });
  }
  return out;
}

export function sceneToMeasures(
  scene: Scene,
  rooms: Room[],
  options: MeasuresOptions,
): MeasuresFile {
  const nesting = nestingOf(rooms);

  const out: MeasuredRoom[] = rooms.map((room, index) => {
    // 部屋の壁は同じ階にあるので、階は最初の壁から引ける
    const level = levelOf(scene, scene.walls[room.wallIds[0]]?.levelId ?? scene.activeLevelId);
    // 入れ子（柱型・PS）を引く。引かないと床も天井も仕上げが多すぎる数になる
    const inner = nesting.get(index) ?? [];
    const holeArea = inner.reduce((sum, i) => sum + rooms[i].innerArea, 0);
    const holePerimeter = inner.reduce(
      (sum, i) => sum + perimeterOf(rooms[i].innerPolygon),
      0,
    );
    // 吹抜・PS・煙道は床が無い。**仕上げも積まない**
    const floor = Math.max(room.innerArea - holeArea - room.voidArea, 0);

    // 巾木・回り縁は柱型の周りを回るので、**周長には足す**
    const perimeter = perimeterOf(room.innerPolygon) + holePerimeter;

    // 壁の高さは壁ごとに違いうるので、面積は壁ごとに積む
    const seen = new Set<string>();
    let wallArea = 0;
    let anyDefaultHeight = false;
    let excludedWalls = 0;
    for (const wallId of room.wallIds) {
      if (seen.has(wallId)) continue;
      seen.add(wallId);
      const wall = scene.walls[wallId];
      if (!wall) continue;
      // **対象外にした壁は幾何ごと渡さない。** 数だけ引いて面積を残すと、
      // 受け取った側が同じ部屋を 2 通りに数えられてしまう
      if (isExcluded(wall.attrs)) {
        excludedWalls += 1;
        continue;
      }
      if (wall.height === null) anyDefaultHeight = true;
      wallArea += (netLength(scene, wallId) * wallHeightOf(wall, level)) / 1e6;
    }

    const openings = openingsOf(scene, room).map((o) => {
      const v = openingVertical(o, level);
      return {
        id: o.id,
        kind: o.kind as string,
        // **符号を渡す。** 平面では同じ記号になる建具（上げ下げ・FIX・
        // すべり出し）を、受け取った側が区別できる唯一の手がかり
        designation: o.designation,
        leaves: o.leaves,
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
    if (excludedWalls > 0) {
      basis.wall_area = '推定';
      note.wall_area = `積算の対象外にした壁 ${excludedWalls} 面を外した`;
    }
    if (room.voidArea > 0) {
      // **何を引いたかを書く。** 数字だけ渡すと、受け取った側が
      // 「内法より小さいのはなぜか」を追えない
      basis.area = '推定';
      note.area = [note.area, `吹抜 ${round(room.voidArea)}m² を控除した`]
        .filter(Boolean)
        .join(' / ');
    }

    const surfaces = surfacesOf(scene, room, level, floor, openings.map((o) => o.id));

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
      ...(surfaces.length > 0 ? { surfaces } : {}),
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
