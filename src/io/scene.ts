import {
  defaultLayers,
  LAYER_IDS,
  type Layer,
  type LayerId,
} from "../core/layer.ts";
import {
  jisStandard,
  lineGroupById,
  paperById,
  type DrawingStandard,
  type LineType,
  type WeightRole,
} from "../core/standard.ts";
import { createWallDimensions } from "../core/dimension.ts";
import { vec, type Vec } from "../core/geometry.ts";
import { OPENING_SYMBOLS } from "../core/opening.ts";
import { defaultSheet, type Sheet } from "../core/sheet.ts";
import type { BlockDef } from "../core/block.ts";
import { BLOCK_PRESETS } from "../core/blockPresets.ts";
import type { Shape } from "../core/shapes.ts";
import type { Id } from "../core/id.ts";
import { readShape } from "./shapeRead.ts";
import {
  FIXTURE_SPECS,
  isFixtureKind,
  isRoundFixture,
  type Fixture,
} from "../core/fixture.ts";
import { isBooleanOp, type FixtureCombine } from "../core/combine.ts";
import { isEdgeKind, isEdgeWhere, type FixtureEdge } from "../core/edge3d.ts";
import { isBayShape, type Bay } from "../core/bay.ts";
import { readPoint3 } from "../core/annotation.ts";
import { emptyBody, isEmptyBody, type Assembly } from "../core/assembly.ts";
import {
  clampOpacity,
  DEFAULT_VIEW_ID,
  defaultViews,
  type DrawingView,
  type LayerViewState,
} from "../core/view.ts";
import { newId, emptyScene, isOpeningKind, type Scene } from "../core/types.ts";
import { CONSTRAINT_SPECS, isConstraintKind } from "../core/constraints.ts";
import { defaultAttrs, isTakeoffMode, type Attrs } from "../core/attrs.ts";
import {
  DEFAULT_LEVEL_ID,
  defaultLevel,
  levelsInOrder,
  type Level,
} from "../core/level.ts";

/**
 * 1 → 2 で画層と製図規格、2 → 3 で汎用図形、3 → 4 で寸法、4 → 5 で用紙枠、
 * 5 → 6 で家具がブロック、6 → 7 で幾何拘束、7 → 8 で高さ（壁・建具・階）、
 * 8 → 9 で階が複数。
 *
 * `deserialize` は常に `emptyScene()` を土台にフィールド単位で補うので、
 * テーブルが増えるだけなら分岐は要らない。
 * 4 だけは「壁に自動表示していた寸法」を実体に変える必要があるので移行する。
 *
 * 8 → 9 も分岐は要らない。単数の `level` を 1 件の `levels` に読み替え、
 * `levelId` の無い実体は**既定の階に乗せる**だけで済む。
 * `DEFAULT_LEVEL_ID` が固定値なのはこのため。
 */
export const FILE_VERSION = 13;

/** 寸法が実体になる前のファイル。読み込み時に全壁ぶんの寸法を作る */
const DIMENSIONS_BECAME_ENTITIES = 4;

/**
 * 枚数が引違い窓以外でも記号に効くようになる前のファイル。
 *
 * それまでツールは種別を問わず 2 を書いていて、引違い窓以外では**誰も読まない値**
 * だった。そのまま読むと、片開き戸が 2 枚に、折戸が 2 山から 1 山に変わる
 * ——保存した図が開いた瞬間に変わる。種別ごとの既定値に寄せて防ぐ。
 */
const LEAVES_BECAME_REAL = 12;

/**
 * シンボルを置いた箇所の id が `groupId` に入っていた頃のファイル。
 *
 * 人が作るグループと同じ欄を使っていたので、`stampId` に分けた。
 * 寄せないと**一括変更が押し直す相手を見失う**（`entitiesInStamps` が
 * `stampId` を見るようになったため）。
 */
const STAMP_ID_SPLIT = 13;

export interface SceneFile {
  format: "minicad";
  version: number;
  unit: "mm";
  savedAt: string;
  scene: Scene;
}

export function serialize(scene: Scene): SceneFile {
  return {
    format: "minicad",
    version: FILE_VERSION,
    unit: "mm",
    savedAt: new Date().toISOString(),
    scene,
  };
}

/** 外部から来たJSONを信用せず、必要なテーブルだけ取り出して形を整える */
/**
 * 自前の輪郭。**3 点に満たなければ捨てて種別の既定に戻す。**
 *
 * 版は上げていない。欄が無い古いファイルは `null` になり、種別の既定の輪郭が出る
 * ——移行の処理が要らないので、`FILE_VERSION` を動かす理由が無い。
 */
function readOutline(raw: unknown): Vec[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Vec[] = [];
  for (const p of raw) {
    if (typeof p?.x !== "number" || typeof p?.y !== "number") return null;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    out.push(vec(p.x, p.y));
  }
  return out.length >= 3 ? out : null;
}

/**
 * 構造物 1 つ。**しまい込んだ相手（ブーリアン）があれば再帰で読む。**
 *
 * 読み込みと「壊れたものを捨てる」書き出しの両方がここを通る。
 * 片方だけ直すと、読めるのに書けない（またはその逆の）欄が生まれる。
 */
function readFixture(
  id: string,
  raw: Record<string, unknown>,
  layerOr: (v: unknown, fallback: LayerId) => LayerId,
  levelId: string,
): Fixture | null {
  if (!isFixtureKind(raw?.kind)) return null;
  if (typeof raw.x !== "number" || typeof raw.y !== "number") return null;
  const spec = FIXTURE_SPECS[raw.kind];
  const size = (
    typeof raw.size === "object" && raw.size !== null ? raw.size : {}
  ) as Record<string, unknown>;
  const w = Math.max(1, numberOr(size.w, spec.defaultSize.w));
  return {
    id,
    kind: raw.kind,
    x: raw.x,
    y: raw.y,
    angle: numberOr(raw.angle, 0),
    // 円柱は直径 1 つで決まる。奥行が別の値で書かれていても直径に揃える
    size: {
      w,
      h: isRoundFixture(raw.kind)
        ? w
        : Math.max(1, numberOr(size.h, spec.defaultSize.h)),
    },
    tilt: readTilt(raw.tilt),
    outline: readOutline(raw.outline),
    combine: readCombine(raw.combine, layerOr, levelId),
    edge: readEdge(raw.edge),
    base: typeof raw.base === "number" ? raw.base : null,
    height: typeof raw.height === "number" ? raw.height : null,
    label: typeof raw.label === "string" ? raw.label : spec.defaultLabel,
    layerId: layerOr(raw.layerId, spec.defaultLayer),
    levelId,
    attrs: readAttrs(raw.attrs),
  };
}

/**
 * 水平軸まわりの傾き。**欄が無い古いファイルは null**（＝傾きなし）。
 *
 * 版は上げていない。読めない値は傾きなしに倒すので、移行の処理が要らない。
 */
function readTilt(raw: unknown): { x: number; y: number } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const x = numberOr(obj.x, 0);
  const y = numberOr(obj.y, 0);
  // 0 と 0 は「傾きなし」と同じ。欄を持たせずに畳む
  return x === 0 && y === 0 ? null : { x, y };
}

/** 稜線の仕上げ。大きさが 0 以下なら持たない（素の立体に戻る） */
function readEdge(raw: unknown): FixtureEdge | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!isEdgeKind(obj.kind)) return null;
  const size = numberOr(obj.size, 0);
  // **欄が無い古いファイルは上下だけ。** 縦が入る前に保存されたものは、
  // 上下のつもりで作られている
  const where = isEdgeWhere(obj.where) ? obj.where : "topBottom";
  return size > 0 ? { kind: obj.kind, size, where } : null;
}

/** ブーリアンの作り方。**相手が 1 つも読めなければ null**（素の立体に戻る） */
function readCombine(
  raw: unknown,
  layerOr: (v: unknown, fallback: LayerId) => LayerId,
  levelId: string,
): FixtureCombine | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!isBooleanOp(obj.op) || !Array.isArray(obj.parts)) return null;
  const parts: Fixture[] = [];
  for (const part of obj.parts) {
    if (typeof part !== "object" || part === null) continue;
    const got = readFixture(
      typeof (part as Record<string, unknown>).id === "string"
        ? String((part as Record<string, unknown>).id)
        : newId("f"),
      part as Record<string, unknown>,
      layerOr,
      levelId,
    );
    if (got) parts.push(got);
  }
  return parts.length > 0 ? { op: obj.op, parts } : null;
}

export function deserialize(raw: unknown): Scene {
  if (typeof raw !== "object" || raw === null)
    throw new Error("JSON の形式が不正です");
  const obj = raw as Record<string, unknown>;
  const payload = (obj.format === "minicad" ? obj.scene : obj) as
    Record<string, unknown> | undefined;
  if (typeof payload !== "object" || payload === null)
    throw new Error("scene が見つかりません");

  const scene = emptyScene();
  const table = <T>(key: string): Record<string, T> => {
    const v = payload[key];
    return typeof v === "object" && v !== null ? (v as Record<string, T>) : {};
  };

  scene.layers = readLayers(table<Record<string, unknown>>("layers"));
  scene.standard = readStandard(payload.standard);
  scene.sheet = readSheet(payload.sheet);
  readViews(scene, payload);
  readLevels(scene, payload);
  const layerOr = (v: unknown, fallback: LayerId): LayerId =>
    typeof v === "string" && scene.layers[v] ? v : fallback;
  /** 知らない階に乗っている実体は作業中の階へ。宙に浮かせるより直しようがある */
  const levelOr = (v: unknown): Id =>
    typeof v === "string" && scene.levels[v] ? v : scene.activeLevelId;

  for (const [id, n] of Object.entries(
    table<Record<string, unknown>>("nodes"),
  )) {
    if (typeof n?.x !== "number" || typeof n?.y !== "number") continue;
    scene.nodes[id] = { id, x: n.x, y: n.y, levelId: levelOr(n.levelId) };
  }
  for (const [id, w] of Object.entries(
    table<Record<string, unknown>>("walls"),
  )) {
    if (typeof w?.a !== "string" || typeof w?.b !== "string") continue;
    const na = scene.nodes[w.a];
    const nb = scene.nodes[w.b];
    // **壁は両端ノードと同じ階に乗る。** 食い違う JSON は壁ごと落とす
    if (!na || !nb || na.levelId !== nb.levelId) continue;
    scene.walls[id] = {
      id,
      a: w.a,
      b: w.b,
      thickness: numberOr(w.thickness, 120),
      // 円弧壁の膨らみ。**欄が無い古いファイルは 0 ＝直線**なので版は上げない
      bulge: numberOr(w.bulge, 0),
      height: finiteOrNull(w.height),
      // 下端は負にならない。古いファイルには欄が無く、床に着く
      base: Math.max(0, numberOr(w.base, 0)),
      layerId: layerOr(w.layerId, LAYER_IDS.wall),
      levelId: na.levelId,
      attrs: readAttrs(w.attrs),
    };
  }
  for (const [id, o] of Object.entries(
    table<Record<string, unknown>>("openings"),
  )) {
    if (typeof o?.wallId !== "string" || !scene.walls[o.wallId]) continue;
    // 表引きにしておかないと、種別を足したときに読み込みで 'door' に化けて静かに壊れる
    const kind = isOpeningKind(o.kind) ? o.kind : "door";
    scene.openings[id] = {
      id,
      wallId: o.wallId,
      offset: numberOr(o.offset, 0),
      width: numberOr(o.width, 800),
      kind,
      flipX: o.flipX === true,
      flipY: o.flipY === true,
      sillHeight: finiteOrNull(o.sillHeight),
      bay: readBay(o.bay),
      designation:
        typeof o.designation === "string" ? o.designation.trim() : "",
      // 枚数は 1 以上の整数。引違いの既定は 2 枚
      leaves: Math.max(1, Math.round(numberOr(o.leaves, 2))),
      height: finiteOrNull(o.height),
      layerId: layerOr(o.layerId, LAYER_IDS.opening),
      attrs: readAttrs(o.attrs),
    };
  }
  for (const [id, b] of Object.entries(
    table<Record<string, unknown>>("blocks"),
  )) {
    const def = readBlockDef(id, b, scene);
    if (def) scene.blocks[id] = def;
  }
  for (const [id, i] of Object.entries(
    table<Record<string, unknown>>("instances"),
  )) {
    if (typeof i?.blockId !== "string" || !scene.blocks[i.blockId]) continue;
    if (typeof i.x !== "number" || typeof i.y !== "number") continue;
    scene.instances[id] = {
      id,
      blockId: i.blockId,
      layerId: layerOr(i.layerId, LAYER_IDS.furniture),
      x: i.x,
      y: i.y,
      scaleX: numberOr(i.scaleX, 1) || 1,
      scaleY: numberOr(i.scaleY, 1) || 1,
      angle: numberOr(i.angle, 0),
      label: typeof i.label === "string" ? i.label : null,
      levelId: levelOr(i.levelId),
      attrs: readAttrs(i.attrs),
    };
  }
  migrateFurniture(
    scene,
    table<Record<string, unknown>>("furniture"),
    layerOr,
    scene.activeLevelId,
  );
  for (const [id, raw] of Object.entries(
    table<Record<string, unknown>>("shapes"),
  )) {
    const shape = readShape(
      {
        id,
        layerId: layerOr(raw?.layerId, LAYER_IDS.shape),
        levelId: levelOr(raw?.levelId),
        attrs: readAttrs(raw?.attrs),
      },
      raw,
    );
    if (shape) scene.shapes[id] = shape;
  }
  migrateDimensions(scene, obj);
  migrateLeaves(scene, obj);

  for (const [id, c] of Object.entries(
    table<Record<string, unknown>>("constraints"),
  )) {
    if (!isConstraintKind(c?.kind)) continue;
    const walls = Array.isArray(c.walls)
      ? c.walls.filter((w): w is string => typeof w === "string")
      : [];
    const spec = CONSTRAINT_SPECS[c.kind];
    // 参照先の壁が実在するものだけ採る（開口が壁を検査するのと同じ作法）
    if (!spec.applicable(scene, walls)) continue;
    scene.constraints[id] = {
      id,
      kind: c.kind,
      walls,
      value: spec.usesValue
        ? numberOr(c.value, spec.initialValue(scene, walls) ?? 0)
        : null,
    };
  }

  for (const [id, raw] of Object.entries(
    table<Record<string, unknown>>("fixtures"),
  )) {
    const got = readFixture(id, raw ?? {}, layerOr, levelOr(raw?.levelId));
    if (got) scene.fixtures[id] = got;
  }

  for (const [id, raw] of Object.entries(
    table<Record<string, unknown>>("assemblies"),
  )) {
    const got = readAssembly(id, raw, layerOr);
    if (got) scene.assemblies[id] = got;
  }

  for (const [id, st] of Object.entries(
    table<Record<string, unknown>>("stamps"),
  )) {
    // 置き先のシンボルが無い箇所は捨てる。押し直しようがない
    if (typeof st?.assemblyId !== "string" || !scene.assemblies[st.assemblyId])
      continue;
    if (typeof st.x !== "number" || typeof st.y !== "number") continue;
    scene.stamps[id] = {
      id,
      assemblyId: st.assemblyId,
      version: Math.max(1, Math.round(numberOr(st.version, 1))),
      x: st.x,
      y: st.y,
      angle: numberOr(st.angle, 0),
      levelId: levelOr(st.levelId),
    };
  }
  // **箇所を読んだ後でないと動かせない。** どの id が箇所かを知る必要がある
  migrateStampIds(scene, obj);

  for (const [id, raw] of Object.entries(
    table<Record<string, unknown>>("measurements"),
  )) {
    const a = readPoint3(raw?.a);
    const b = readPoint3(raw?.b);
    if (!a || !b) continue;
    scene.measurements[id] = {
      id,
      a,
      b,
      // 手入力は数値のときだけ。**未入力と 0 を分ける**
      manual:
        typeof raw.manual === "number" && Number.isFinite(raw.manual)
          ? raw.manual
          : null,
      note: typeof raw.note === "string" ? raw.note : "",
      layerId: layerOr(raw.layerId, LAYER_IDS.draft),
      levelId: levelOr(raw.levelId),
      attrs: readAttrs(raw.attrs),
    };
  }

  for (const [id, l] of Object.entries(
    table<Record<string, unknown>>("roomLabels"),
  )) {
    if (typeof l?.x !== "number" || typeof l?.y !== "number") continue;
    scene.roomLabels[id] = {
      id,
      x: l.x,
      y: l.y,
      name: typeof l.name === "string" ? l.name : "部屋",
      floorMaterial:
        typeof l.floorMaterial === "string" ? l.floorMaterial : null,
      ceilingMaterial:
        typeof l.ceilingMaterial === "string" ? l.ceilingMaterial : null,
      layerId: layerOr(l.layerId, LAYER_IDS.roomName),
      levelId: levelOr(l.levelId),
    };
  }

  // 外部領域。**3 点に満たない輪郭は捨てる**——面積の無い「領域」は図面の嘘
  for (const [id, a] of Object.entries(
    table<Record<string, unknown>>("areas"),
  )) {
    const outline = readOutline(a?.outline);
    if (!outline || outline.length < 3) continue;
    scene.areas[id] = {
      id,
      outline,
      layerId: layerOr(a.layerId, LAYER_IDS.roomName),
      levelId: levelOr(a.levelId),
      attrs: readAttrs(a.attrs),
    };
  }
  return scene;
}

/**
 * シンボルの読み取り。
 *
 * **中身は実体と同じ形**（ローカル座標の壁・ノード・建具・構造）なので、
 * 読み方も同じ作法。壁の両端が中身のノードを指していないものは捨てる——
 * 置いた瞬間に行き場のない壁になる。
 */
function readAssembly(
  id: Id,
  raw: unknown,
  layerOr: (v: unknown, fallback: LayerId) => LayerId,
): Assembly | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  const rawBody =
    typeof a.body === "object" && a.body !== null
      ? (a.body as Record<string, unknown>)
      : {};
  const tbl = (key: string): Record<string, Record<string, unknown>> => {
    const v = rawBody[key];
    return typeof v === "object" && v !== null
      ? (v as Record<string, Record<string, unknown>>)
      : {};
  };
  const body = emptyBody();

  for (const [nid, n] of Object.entries(tbl("nodes"))) {
    if (typeof n?.x !== "number" || typeof n?.y !== "number") continue;
    body.nodes[nid] = { x: n.x, y: n.y };
  }
  for (const [wid, w] of Object.entries(tbl("walls"))) {
    if (typeof w?.a !== "string" || typeof w?.b !== "string") continue;
    if (!body.nodes[w.a] || !body.nodes[w.b]) continue;
    body.walls[wid] = {
      id: wid,
      a: w.a,
      b: w.b,
      thickness: numberOr(w.thickness, 120),
      // 円弧壁の膨らみ。**欄が無い古いファイルは 0 ＝直線**なので版は上げない
      bulge: numberOr(w.bulge, 0),
      height: finiteOrNull(w.height),
      base: Math.max(0, numberOr(w.base, 0)),
      layerId: layerOr(w.layerId, LAYER_IDS.wall),
      attrs: readAttrs(w.attrs),
    };
  }
  for (const [oid, o] of Object.entries(tbl("openings"))) {
    if (typeof o?.wallId !== "string" || !body.walls[o.wallId]) continue;
    if (!isOpeningKind(o.kind)) continue;
    body.openings[oid] = {
      id: oid,
      wallId: o.wallId,
      offset: numberOr(o.offset, 0),
      width: numberOr(o.width, 800),
      kind: o.kind,
      flipX: o.flipX === true,
      flipY: o.flipY === true,
      sillHeight: finiteOrNull(o.sillHeight),
      bay: readBay(o.bay),
      designation:
        typeof o.designation === "string" ? o.designation.trim() : "",
      leaves: Math.max(1, Math.round(numberOr(o.leaves, 2))),
      height: finiteOrNull(o.height),
      layerId: layerOr(o.layerId, LAYER_IDS.opening),
      attrs: readAttrs(o.attrs),
    };
  }
  for (const [fid, f] of Object.entries(tbl("fixtures"))) {
    const got = readFixture(fid, f ?? {}, layerOr, DEFAULT_LEVEL_ID);
    if (!got) continue;
    const { levelId: _drop, ...rest } = got;
    body.fixtures[fid] = rest;
  }

  if (isEmptyBody(body)) return null;
  return {
    id,
    name: typeof a.name === "string" ? a.name : "シンボル",
    version: Math.max(1, Math.round(numberOr(a.version, 1))),
    body,
  };
}

/**
 * 図面ビューの読み取り。
 *
 * **欄が無ければ 1 つだけ作る。** 古いファイルには views が無く、
 * そのときの縮尺が作業中のビューの縮尺になる。
 */
function readViews(scene: Scene, payload: Record<string, unknown>): void {
  const raw =
    typeof payload.views === "object" && payload.views !== null
      ? (payload.views as Record<string, unknown>)
      : {};
  const views: Record<Id, DrawingView> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (typeof v !== "object" || v === null) continue;
    const o = v as Record<string, unknown>;
    const states: Record<string, LayerViewState> = {};
    const rawStates =
      typeof o.layerStates === "object" && o.layerStates !== null
        ? (o.layerStates as Record<string, unknown>)
        : {};
    for (const [layerId, st] of Object.entries(rawStates)) {
      // 知らない画層の欄は捨てる。当てる先が無い
      if (!scene.layers[layerId] || typeof st !== "object" || st === null)
        continue;
      const t = st as Record<string, unknown>;
      states[layerId] = {
        visible: t.visible !== false,
        opacity: clampOpacity(t.opacity),
      };
    }
    views[id] = {
      id,
      name: typeof o.name === "string" ? o.name : "図面",
      scale: numberOr(o.scale, scene.standard.scale) || scene.standard.scale,
      layerStates: states,
    };
  }

  if (Object.keys(views).length === 0) {
    scene.views = defaultViews(scene.standard.scale);
    scene.activeViewId = DEFAULT_VIEW_ID;
    return;
  }
  scene.views = views;
  scene.activeViewId =
    typeof payload.activeViewId === "string" && views[payload.activeViewId]
      ? payload.activeViewId
      : Object.keys(views)[0];
}

/**
 * 出窓・ニッチの読み取り。出が 0 なら無いものと同じなので null に落とす。
 * **種別を増やしていない**ので、古いファイルは欄が無く、そのまま null になる
 */
function readBay(raw: unknown): Bay | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (!isBayShape(b.shape)) return null;
  const depth = numberOr(b.depth, 0);
  if (Math.abs(depth) < 1e-6) return null;
  return { shape: b.shape, depth, side: b.side === -1 ? -1 : 1 };
}

/** ブロック定義の読み取り。中身の図形は既定の画層・既定の階に乗せる（どちらも定義の中では意味を持たない） */
function readBlockDef(id: Id, raw: unknown, scene: Scene): BlockDef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.name !== "string" || typeof b.label !== "string") return null;
  const size = (
    typeof b.size === "object" && b.size !== null ? b.size : {}
  ) as Record<string, unknown>;
  const shapes: Record<Id, Shape> = {};
  const rawShapes =
    typeof b.shapes === "object" && b.shapes !== null
      ? (b.shapes as Record<string, unknown>)
      : {};
  for (const [shapeId, rawShape] of Object.entries(rawShapes)) {
    const shape = readShape(
      {
        id: shapeId,
        layerId: LAYER_IDS.furniture,
        levelId: DEFAULT_LEVEL_ID,
        attrs: defaultAttrs(),
      },
      rawShape,
    );
    if (shape) shapes[shapeId] = shape;
  }
  if (Object.keys(shapes).length === 0) return null;
  void scene;
  return {
    id,
    name: b.name,
    label: b.label,
    size: { w: numberOr(size.w, 1), h: numberOr(size.h, 1) },
    shapes,
    source: b.source === "builtin" ? "builtin" : "user",
  };
}

/**
 * 家具が専用のエンティティだった頃のファイルを、ブロックの挿入に変える。
 *
 * 旧 `kind` は標準ブロックに1対1で対応する。
 * 幅と奥行は定義の自然な大きさとの比を尺度にして、見た目を保つ。
 */
function migrateFurniture(
  scene: Scene,
  furniture: Record<string, Record<string, unknown>>,
  layerOr: (v: unknown, fallback: LayerId) => LayerId,
  levelId: Id,
): void {
  for (const [id, f] of Object.entries(furniture)) {
    if (typeof f?.x !== "number" || typeof f?.y !== "number") continue;
    const name = typeof f.name === "string" ? f.name : "";
    const preset =
      BLOCK_PRESETS.find((p) => p.label === name) ??
      BLOCK_PRESETS.find((p) => p.id.startsWith(String(f.kind ?? ""))) ??
      BLOCK_PRESETS.find((p) => p.id === "box")!;
    const def = scene.blocks[preset.id];
    if (!def) continue;
    scene.instances[id] = {
      id,
      blockId: preset.id,
      layerId: layerOr(f.layerId, LAYER_IDS.furniture),
      x: f.x,
      y: f.y,
      scaleX: numberOr(f.w, def.size.w) / def.size.w,
      scaleY: numberOr(f.h, def.size.h) / def.size.h,
      angle: numberOr(f.angle, 0),
      label: name && name !== preset.label ? name : null,
      levelId,
      attrs: defaultAttrs(),
    };
  }
}

/**
 * 寸法が「全壁への自動表示」だった頃のファイルを、寸法エンティティへ変える。
 *
 * MiniCAD が書いたファイル（format: 'minicad'）でバージョンが古いときだけ走る。
 * 手書きの JSON やテストのリテラルは現行版として扱い、勝手に寸法を生やさない。
 */
function migrateDimensions(scene: Scene, raw: Record<string, unknown>): void {
  if (raw.format !== "minicad") return;
  const version = typeof raw.version === "number" ? raw.version : 1;
  if (version >= DIMENSIONS_BECAME_ENTITIES) return;
  for (const dim of createWallDimensions(scene)) scene.shapes[dim.id] = dim;
}

/**
 * シンボルの箇所 id を `groupId` から `stampId` へ移す。
 *
 * **`Scene.stamps` に載っている id だけを移す。** 人が別の用途で `groupId` に
 * 書いた値（当時は作る手段が無かったが、手書きの JSON はありうる）まで
 * 動かさないため。移したら `groupId` は空ける——同じ値が 2 つの欄に残ると、
 * グループ解除がスタンプを壊す。
 */
function migrateStampIds(scene: Scene, raw: Record<string, unknown>): void {
  if (raw.format !== "minicad") return;
  const version = typeof raw.version === "number" ? raw.version : 1;
  if (version >= STAMP_ID_SPLIT) return;
  const stamps = new Set(Object.keys(scene.stamps));
  if (stamps.size === 0) return;
  const move = (attrs: Attrs): void => {
    if (attrs.groupId === null || !stamps.has(attrs.groupId)) return;
    attrs.stampId = attrs.groupId;
    attrs.groupId = null;
  };
  for (const w of Object.values(scene.walls)) move(w.attrs);
  for (const o of Object.values(scene.openings)) move(o.attrs);
  for (const f of Object.values(scene.fixtures)) move(f.attrs);
}

/**
 * 枚数を読まなかった頃のファイルの枚数を、種別ごとの既定値に寄せる。
 *
 * `migrateDimensions` と同じく MiniCAD が書いたファイルだけが対象。
 * 引違い窓は当時から枚数を読んでいたので触らない——**そこだけは
 * 利用者が選んだ値**で、寄せると 4 枚建てが 2 枚に戻ってしまう。
 */
function migrateLeaves(scene: Scene, raw: Record<string, unknown>): void {
  if (raw.format !== "minicad") return;
  const version = typeof raw.version === "number" ? raw.version : 1;
  if (version >= LEAVES_BECAME_REAL) return;
  for (const opening of Object.values(scene.openings)) {
    if (opening.kind === "windowSliding") continue;
    opening.leaves = OPENING_SYMBOLS[opening.kind].defaultLeaves;
  }
}

/** 既定の画層を土台に、ファイル側の値で上書きする。知らない画層は追加で受け入れる */
function readLayers(
  raw: Record<string, Record<string, unknown>>,
): Record<LayerId, Layer> {
  const layers = defaultLayers();
  const lineTypes: LineType[] = [
    "continuous",
    "dashed",
    "hidden",
    "center",
    "phantom",
  ];
  const roles: WeightRole[] = ["thin", "thick", "extraThick"];

  for (const [id, l] of Object.entries(raw)) {
    if (typeof l !== "object" || l === null) continue;
    const base = layers[id];
    layers[id] = {
      id,
      name: typeof l.name === "string" ? l.name : (base?.name ?? id),
      color: typeof l.color === "string" ? l.color : (base?.color ?? "#3f3f46"),
      aci: clampInt(l.aci, base?.aci ?? 7, 0, 255),
      weightRole: roles.includes(l.weightRole as WeightRole)
        ? (l.weightRole as WeightRole)
        : (base?.weightRole ?? "thin"),
      lineWeightOverride:
        typeof l.lineWeightOverride === "number" &&
        Number.isFinite(l.lineWeightOverride)
          ? l.lineWeightOverride
          : null,
      lineType: lineTypes.includes(l.lineType as LineType)
        ? (l.lineType as LineType)
        : (base?.lineType ?? "continuous"),
      visible: l.visible !== false,
      locked: l.locked === true,
      printable: l.printable !== false,
      opacity: clampOpacity(l.opacity),
    };
  }
  return layers;
}

/**
 * 階の読み取り。**版 8 までの単数の `level` も受ける。**
 *
 * 古いファイルは `level: {floorZ, wallHeight}` を 1 つだけ持つので、
 * それを `DEFAULT_LEVEL_ID` の階として読む。id が固定値なので、
 * `levelId` を持たない実体の行き先が一意に決まる。
 */
function readLevels(scene: Scene, payload: Record<string, unknown>): void {
  const raw = payload.levels;
  const table =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : null;

  if (table && Object.keys(table).length > 0) {
    const levels: Record<Id, Level> = {};
    for (const [id, l] of Object.entries(table)) {
      levels[id] = readLevel(id, l);
    }
    scene.levels = levels;
    const active = payload.activeLevelId;
    scene.activeLevelId =
      typeof active === "string" && levels[active]
        ? active
        : levelsInOrder(scene)[0]!.id;
    return;
  }

  // 版 8 以前。単数の level を 1 件の階に読み替える
  scene.levels = {
    [DEFAULT_LEVEL_ID]: readLevel(DEFAULT_LEVEL_ID, payload.level),
  };
  scene.activeLevelId = DEFAULT_LEVEL_ID;
}

/**
 * 属性の読み取り。**欄ごとに検査する。**
 *
 * `takeoff` だけは閉じた語彙なので表引きで弾く。知らない値を黙って通すと、
 * その行が何を名乗っているか決まらなくなる（`isOpeningKind` と同じ作法）。
 * 残りはホストの識別子や色文字列で、MiniCAD は中身を解釈しない。
 */
function readAttrs(raw: unknown): Attrs {
  const a = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v !== "" ? v : null;
  return {
    groupId: str(a.groupId),
    stampId: str(a.stampId),
    color: str(a.color),
    materialRef: str(a.materialRef),
    takeoff: isTakeoffMode(a.takeoff) ? a.takeoff : null,
    symbolId: str(a.symbolId),
    // 版は id があるときだけ意味を持つ。id なしの版は捨てる
    symbolVersion:
      str(a.symbolId) !== null &&
      typeof a.symbolVersion === "number" &&
      Number.isFinite(a.symbolVersion)
        ? a.symbolVersion
        : null,
  };
}

function readLevel(id: Id, raw: unknown): Level {
  const base = defaultLevel();
  const l = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  return {
    id,
    name:
      typeof l.name === "string" && l.name.trim() !== "" ? l.name : base.name,
    floorZ: numberOr(l.floorZ, base.floorZ),
    wallHeight: Math.max(1, numberOr(l.wallHeight, base.wallHeight)),
  };
}

function readStandard(raw: unknown): DrawingStandard {
  const base = jisStandard();
  if (typeof raw !== "object" || raw === null) return base;
  const s = raw as Record<string, unknown>;
  const text = (
    typeof s.textHeight === "object" && s.textHeight !== null
      ? s.textHeight
      : {}
  ) as Record<string, unknown>;
  return {
    preset: typeof s.preset === "string" ? s.preset : base.preset,
    // 不正な値は lineGroupById / paperById が既定にまとめてくれる
    lineGroupId: lineGroupById(String(s.lineGroupId ?? base.lineGroupId)).id,
    scale:
      numberOr(s.scale, base.scale) > 0
        ? numberOr(s.scale, base.scale)
        : base.scale,
    textHeight: {
      room: numberOr(text.room, base.textHeight.room),
      area: numberOr(text.area, base.textHeight.area),
      dimension: numberOr(text.dimension, base.textHeight.dimension),
      furniture: numberOr(text.furniture, base.textHeight.furniture),
    },
    paperId: paperById(String(s.paperId ?? base.paperId)).id,
    orientation: s.orientation === "portrait" ? "portrait" : "landscape",
    wallFill: s.wallFill !== false,
  };
}

function readSheet(raw: unknown): Sheet {
  const base = defaultSheet();
  if (typeof raw !== "object" || raw === null) return base;
  const s = raw as Record<string, unknown>;
  const block = (
    typeof s.titleBlock === "object" && s.titleBlock !== null
      ? s.titleBlock
      : {}
  ) as Record<string, unknown>;
  const fields = (
    typeof block.fields === "object" && block.fields !== null
      ? block.fields
      : {}
  ) as Record<string, unknown>;
  const origin = (
    typeof s.origin === "object" && s.origin !== null ? s.origin : {}
  ) as Record<string, unknown>;
  const margins = (
    typeof s.margins === "object" && s.margins !== null ? s.margins : null
  ) as Record<string, unknown> | null;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" ? v : fallback;

  return {
    show: s.show === true,
    origin: {
      x: numberOr(origin.x, base.origin.x),
      y: numberOr(origin.y, base.origin.y),
    },
    margins: margins
      ? {
          binding: numberOr(margins.binding, 20),
          top: numberOr(margins.top, 10),
          right: numberOr(margins.right, 10),
          bottom: numberOr(margins.bottom, 10),
        }
      : null,
    titleBlock: {
      enabled: block.enabled !== false,
      width: numberOr(block.width, base.titleBlock.width),
      rowHeight: numberOr(block.rowHeight, base.titleBlock.rowHeight),
      fields: {
        drawingName: str(
          fields.drawingName,
          base.titleBlock.fields.drawingName,
        ),
        drawingNumber: str(fields.drawingNumber, ""),
        company: str(fields.company, ""),
        designer: str(fields.designer, ""),
        date: str(fields.date, ""),
      },
    },
  };
}

/** 上書きがあればその値、無ければ null。「既定に従う」を null 1値で表す既存の流儀に合わせる */
const finiteOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const numberOr = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

function clampInt(
  v: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

export function downloadJson(
  scene: Scene,
  filename = "madori.minicad.json",
): void {
  const blob = new Blob([JSON.stringify(serialize(scene), null, 2)], {
    type: "application/json",
  });
  triggerDownload(blob, filename);
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // revoke はクリック処理が済んでから
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const STORAGE_KEY = "minicad.autosave.v1";

/** 書き出し済みのものをそのまま保存する。ホストが `onChange` で受け取った形 */
export function saveLocalFile(file: SceneFile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
  } catch {
    // 容量超過やプライベートモードでは黙って諦める
  }
}

export function loadLocal(): Scene | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return deserialize(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function clearLocal(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 無視
  }
}
