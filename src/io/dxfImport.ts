/**
 * DXF 模型 → MiniCAD の `Scene`。
 *
 * **取り込み先は汎用図形（下図）に限る**という方針です。他所の DXF には通り芯・寸法線・
 * ハッチが混ざっているので、平行線のペアから壁を推定すると誤検出がそのまま
 * 「部屋が検出されない」に化けます。下図として線が見えていれば、既存の壁ツールと
 * スナップでなぞり直すほうが速く、結果も正しくなります。
 * 画層 `A-DRAFT` は元々この用途のためにあります。
 */

import { newId } from '../core/id.ts';
import { dist, vec, type Vec } from '../core/geometry.ts';
import { addLayer, ACI_COLORS, LAYER_IDS, type LayerId } from '../core/layer.ts';
import { sanitizeBlockName } from '../core/block.ts';
import { arcFromPoints, shapeVertices, transformShape, type Shape, type ShapeBody } from '../core/shapes.ts';
import { scaleOf, type Transform } from '../core/transform.ts';
import { emptyScene, type Id, type Scene } from '../core/types.ts';
import type { BlockDef } from '../core/block.ts';
import type { DrawingStandard, LineType } from '../core/standard.ts';
import type { DxfDocument, DxfEntity, DxfKind } from './dxfRead.ts';
import { num } from './dxfTags.ts';

export interface ImportOptions {
  /** mm への倍率。$INSUNITS から推定し、取り込みダイアログで上書きできる */
  unitScale: number;
  /** 'table' = DXF の画層を取り込む / 'draft' = すべて下図画層へ */
  layerMode: 'table' | 'draft';
  /** 'define' = BLOCK をブロック定義として取り込む / 'explode' = 図形に展開する */
  blockMode: 'define' | 'explode';
  /** 図形の中心を原点へ寄せる。測量系の DXF は原点が数百万 mm 先にある */
  recenter: boolean;
  importText: boolean;
  /** 取り込んだ画層をロックする（下図として使うとき） */
  lockImported: boolean;
  maxEntities: number;
}

export interface ImportReport {
  imported: { kind: string; count: number }[];
  skipped: { kind: string; count: number; reason: string }[];
  layersCreated: string[];
  layersReused: string[];
  blocksCreated: string[];
  blocksReused: string[];
  unitNote: string | null;
  warnings: string[];
  shapeCount: number;
  instanceCount: number;
  truncated: boolean;
}

/** $INSUNITS → mm への倍率 */
const INSUNITS_TO_MM: Record<number, number> = {
  1: 25.4, // インチ
  2: 304.8, // フィート
  4: 1, // ミリメートル
  5: 10, // センチメートル
  6: 1000, // メートル
  9: 0.0254, // ミル
  10: 914.4, // ヤード
};

const UNIT_LABELS: Record<number, string> = {
  1: 'インチ', 2: 'フィート', 4: 'ミリメートル', 5: 'センチメートル', 6: 'メートル', 9: 'ミル', 10: 'ヤード',
};

/** 書き出し側 (dxf.ts の LTYPE_NAMES) の逆引き。知らない名前は実線に落とす */
const LINE_TYPE_FROM_DXF: Record<string, LineType> = {
  CONTINUOUS: 'continuous', SOLID: 'continuous', BYLAYER: 'continuous', BYBLOCK: 'continuous',
  DASHED: 'dashed', DASHED2: 'dashed', DASHEDX2: 'dashed', DOT: 'dashed', DOT2: 'dashed',
  HIDDEN: 'hidden', HIDDEN2: 'hidden', HIDDENX2: 'hidden',
  CENTER: 'center', CENTER2: 'center', CENTERX2: 'center', DASHDOT: 'center', DIVIDE: 'center',
  PHANTOM: 'phantom', PHANTOM2: 'phantom', PHANTOMX2: 'phantom',
};

/** 入れ子ブロックの展開はここで打ち切る。循環参照のあるファイルが実在する */
const MAX_EXPLODE_DEPTH = 8;
/** 楕円・円弧を折れ線に落とすときの刻み。shapes.ts の ARC_STEP と同じ */
const ARC_STEP = Math.PI / 16;

export function defaultImportOptions(doc: DxfDocument): ImportOptions {
  return {
    unitScale: unitScaleOf(doc).scale,
    layerMode: 'table',
    blockMode: 'define',
    recenter: false,
    importText: true,
    lockImported: false,
    maxEntities: 20000,
  };
}

/** $INSUNITS から倍率と、レポートに出す説明を決める */
export function unitScaleOf(doc: DxfDocument): { scale: number; note: string | null } {
  const record = doc.header.get('$INSUNITS');
  const code = record ? Math.round(num(record, 70, 0)) : 0;
  const scale = INSUNITS_TO_MM[code];
  if (scale === undefined) return { scale: 1, note: '単位の指定がありません。ミリメートルとして読みました' };
  if (scale === 1) return { scale: 1, note: null };
  return { scale, note: `単位: ${UNIT_LABELS[code]} → mm (×${scale})` };
}

export function dxfToScene(doc: DxfDocument, options: ImportOptions): { scene: Scene; report: ImportReport } {
  const scene = emptyScene();
  return { scene, report: importDxfInto(scene, doc, options) };
}

/**
 * 既存のシーンへ追記する（破壊的）。`store.commit` の中で呼べば 1 回の undo で取り消せる。
 */
export function importDxfInto(scene: Scene, doc: DxfDocument, options: ImportOptions): ImportReport {
  const report: ImportReport = {
    imported: [],
    skipped: [],
    layersCreated: [],
    layersReused: [],
    blocksCreated: [],
    blocksReused: [],
    unitNote: unitScaleOf(doc).note,
    warnings: [...doc.warnings],
    shapeCount: 0,
    instanceCount: 0,
    truncated: false,
  };

  const ctx: Ctx = {
    scene,
    doc,
    options,
    std: scene.standard,
    report,
    layerCache: new Map(),
    blockCache: new Map(),
    takenBlockNames: new Set(Object.values(scene.blocks).map((b) => b.name)),
    newShapeIds: [],
    newInstanceIds: [],
    counts: new Map(),
  };

  const base: Transform = { a: options.unitScale, b: 0, c: 0, d: options.unitScale, e: 0, f: 0 };
  for (const entity of doc.entities) {
    if (ctx.newShapeIds.length + ctx.newInstanceIds.length >= options.maxEntities) {
      report.truncated = true;
      break;
    }
    convert(ctx, entity, base, resolveLayer(ctx, entity.layer), 0);
  }

  if (options.recenter) recenter(ctx);

  report.imported = [...ctx.counts.entries()].map(([kind, count]) => ({ kind, count })).sort(byCountDesc);
  report.skipped = [...doc.skipped.entries()]
    .map(([kind, count]) => ({ kind, count, reason: SKIP_REASONS[kind] ?? '未対応のエンティティです' }))
    .sort(byCountDesc);
  report.shapeCount = ctx.newShapeIds.length;
  report.instanceCount = ctx.newInstanceIds.length;
  if (report.truncated) {
    report.warnings.push(`${options.maxEntities} 件で打ち切りました。元のファイルにはこれより多くの図形があります`);
  }
  return report;
}

const SKIP_REASONS: Record<string, string> = {
  SPLINE: 'スプラインは未対応です',
  HATCH: 'ハッチは未対応です（境界線も取り込みません）',
  LEADER: '引出線は未対応です',
  MLINE: 'マルチラインは未対応です',
  XLINE: '構築線は未対応です',
  RAY: '放射線は未対応です',
  IMAGE: '画像参照は未対応です',
  OLE2FRAME: '埋め込みオブジェクトは未対応です',
  VIEWPORT: 'ビューポートは図形ではありません',
};

const byCountDesc = (a: { count: number }, b: { count: number }): number => b.count - a.count;

interface Ctx {
  scene: Scene;
  doc: DxfDocument;
  options: ImportOptions;
  std: DrawingStandard;
  report: ImportReport;
  /** DXF の画層名 → MiniCAD の画層 ID */
  layerCache: Map<string, LayerId>;
  /** DXF のブロック名 → ブロック定義 ID。null は「定義にできないので展開する」 */
  blockCache: Map<string, Id | null>;
  takenBlockNames: Set<string>;
  newShapeIds: Id[];
  newInstanceIds: Id[];
  counts: Map<string, number>;
}

// --- エンティティの変換表 --------------------------------------------------

/**
 * `{ [K in DxfKind]: … }` のマップ型なので、`DxfKind` に種別を足すと
 * ここが型エラーになる。
 */
type Converter<K extends DxfKind> = (
  ctx: Ctx,
  e: Extract<DxfEntity, { kind: K }>,
  t: Transform,
  layerId: LayerId,
  depth: number,
) => void;

const CONVERTERS: { [K in DxfKind]: Converter<K> } = {
  LINE: (ctx, e, t, layerId) => add(ctx, { shape: 'line', a: e.a, b: e.b }, t, layerId),

  LWPOLYLINE: (ctx, e, t, layerId) => addPolyline(ctx, e.vertices, e.closed, t, layerId),
  POLYLINE: (ctx, e, t, layerId) => addPolyline(ctx, e.vertices, e.closed, t, layerId),

  ARC: (ctx, e, t, layerId) => {
    const from = polar(e.center, e.radius, e.startDeg);
    const to = polar(e.center, e.radius, e.endDeg);
    add(ctx, { shape: 'arc', ...arcFromPoints(e.center, from, to) }, t, layerId);
  },

  CIRCLE: (ctx, e, t, layerId) => add(ctx, { shape: 'circle', center: e.center, radius: e.radius }, t, layerId),

  TEXT: (ctx, e, t, layerId) => addText(ctx, e.text, e.at, e.height, e.rotationDeg, e.align, t, layerId),

  MTEXT: (ctx, e, t, layerId) => {
    // MiniCAD の文字は 1 行なので、改行で分けて行間 1.4 倍で積む
    const lines = e.text.split('\n');
    const step = e.height * 1.4;
    lines.forEach((line, i) => {
      if (line === '') return;
      const at = vec(e.at.x, e.at.y - i * step);
      addText(ctx, line, at, e.height, e.rotationDeg, e.align, t, layerId);
    });
  },

  INSERT: (ctx, e, t, layerId, depth) => {
    const blockId = ctx.options.blockMode === 'define' ? resolveBlock(ctx, e.name, depth) : null;
    // 矩形配列挿入 (70/71/44/45) は、セルごとに 1 つずつ置く
    for (let col = 0; col < e.columns; col++) {
      for (let row = 0; row < e.rows; row++) {
        const at = vec(e.at.x + col * e.colSpacing, e.at.y + row * e.rowSpacing);
        const local = insertTransform(at, e.scaleX, e.scaleY, e.rotationDeg);
        if (blockId) placeInstance(ctx, blockId, e, at, t, layerId);
        else explode(ctx, e.name, compose(t, local), layerId, depth + 1);
      }
    }
  },

  // 寸法の実体は参照先の無名ブロック (*D0 …) に入っている。恒等変換で展開すれば線と文字になる
  DIMENSION: (ctx, e, t, layerId, depth) => explode(ctx, e.block, t, layerId, depth + 1),

  ELLIPSE: (ctx, e, t, layerId) => addEllipse(ctx, e, t, layerId),

  SOLID: (ctx, e, t, layerId) => {
    if (e.points.length < 3) return;
    add(ctx, { shape: 'polyline', points: e.points, closed: true }, t, layerId);
  },

  POINT: (ctx, e, t, layerId) => add(ctx, { shape: 'point', at: e.at }, t, layerId),

  '3DFACE': (ctx, e, t, layerId) =>
    add(ctx, { shape: 'polyline', points: e.points, closed: true }, t, layerId),
};

function convert(ctx: Ctx, e: DxfEntity, t: Transform, layerId: LayerId, depth: number): void {
  if (e.kind === 'TEXT' || e.kind === 'MTEXT') {
    if (!ctx.options.importText) {
      bump(ctx.doc.skipped, e.kind);
      return;
    }
  }
  (CONVERTERS[e.kind] as Converter<DxfKind>)(ctx, e, t, layerId, depth);
}

// --- 図形の組み立て --------------------------------------------------------

function add(ctx: Ctx, body: ShapeBody, t: Transform, layerId: LayerId): void {
  const id = newId('sh');
  const shape = { ...body, id, layerId } as Shape;
  ctx.scene.shapes[id] = transformShape(ctx.scene, shape, t, null);
  ctx.newShapeIds.push(id);
  bump(ctx.counts, LABELS[body.shape] ?? body.shape);
}

const LABELS: Record<string, string> = {
  line: '線', polyline: 'ポリライン', arc: '円弧', circle: '円', text: '文字', point: '点', dimension: '寸法',
};

function addText(
  ctx: Ctx,
  text: string,
  at: Vec,
  dxfHeight: number,
  rotationDeg: number,
  align: 'left' | 'center' | 'right',
  t: Transform,
  layerId: LayerId,
): void {
  // DXF の文字高はワールド mm、MiniCAD の TextShape.height は**紙の上の mm**。
  // 尺度で割って紙の土俵に戻す。ここを逆向きにすると文字が 100 倍になる
  const height = (dxfHeight * scaleOf(t)) / ctx.std.scale;
  if (!(height > 0)) return;
  add(ctx, { shape: 'text', at, text, height, angle: (rotationDeg * Math.PI) / 180, align }, t, layerId);
}

/** bulge 付きの頂点列を、折れ線と円弧に分解する */
function addPolyline(
  ctx: Ctx,
  verts: { x: number; y: number; bulge: number }[],
  closed: boolean,
  t: Transform,
  layerId: LayerId,
): void {
  const points = verts.map((v) => vec(v.x, v.y));
  if (verts.every((v) => v.bulge === 0)) {
    if (points.length >= 2) add(ctx, { shape: 'polyline', points, closed }, t, layerId);
    return;
  }
  // MiniCAD のポリラインは bulge を持てないので、区間ごとに線分と円弧に割る
  const last = closed ? verts.length : verts.length - 1;
  for (let i = 0; i < last; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const bulge = verts[i].bulge;
    if (bulge === 0) {
      add(ctx, { shape: 'line', a, b }, t, layerId);
      continue;
    }
    const arc = bulgeToArc(a, b, bulge);
    if (arc) add(ctx, { shape: 'arc', ...arc }, t, layerId);
    else add(ctx, { shape: 'line', a, b }, t, layerId);
  }
}

/**
 * bulge = tan(内角/4)。正なら a → b が反時計回り。
 * 中心は弦の中点から法線方向へ `(半弦)·(1/bulge − bulge)/2` だけ離れた位置にある。
 */
export function bulgeToArc(a: Vec, b: Vec, bulge: number): { center: Vec; radius: number; startAngle: number; endAngle: number } | null {
  const chord = dist(a, b);
  if (chord < 1e-9 || !Number.isFinite(bulge) || bulge === 0) return null;
  const half = chord / 2;
  const offset = (half * (1 / bulge - bulge)) / 2;
  const nx = -(b.y - a.y) / chord;
  const ny = (b.x - a.x) / chord;
  const center = vec((a.x + b.x) / 2 + nx * offset, (a.y + b.y) / 2 + ny * offset);
  // bulge が負なら a → b は時計回り。始終点を入れ替えて「常に反時計回り」の不変条件を保つ
  return arcFromPoints(center, bulge > 0 ? a : b, bulge > 0 ? b : a);
}

function addEllipse(
  ctx: Ctx,
  e: Extract<DxfEntity, { kind: 'ELLIPSE' }>,
  t: Transform,
  layerId: LayerId,
): void {
  const major = Math.hypot(e.major.x, e.major.y);
  if (major < 1e-9) return;
  const full = Math.abs(e.endParam - e.startParam) >= Math.PI * 2 - 1e-6;

  // 比がほぼ 1 なら真円。円・円弧として持てば編集もスナップも効く
  if (Math.abs(e.ratio - 1) < 1e-6) {
    if (full) {
      add(ctx, { shape: 'circle', center: e.center, radius: major }, t, layerId);
    } else {
      const tilt = Math.atan2(e.major.y, e.major.x);
      const from = polarRad(e.center, major, tilt + e.startParam);
      const to = polarRad(e.center, major, tilt + e.endParam);
      add(ctx, { shape: 'arc', ...arcFromPoints(e.center, from, to) }, t, layerId);
    }
    return;
  }

  const sweep = full ? Math.PI * 2 : e.endParam - e.startParam;
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / ARC_STEP));
  const cos = e.major.x / major;
  const sin = e.major.y / major;
  const points: Vec[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = e.startParam + (sweep * i) / steps;
    const x = major * Math.cos(p);
    const y = major * e.ratio * Math.sin(p);
    points.push(vec(e.center.x + x * cos - y * sin, e.center.y + x * sin + y * cos));
  }
  if (full) points.pop();
  add(ctx, { shape: 'polyline', points, closed: full }, t, layerId);
}

// --- ブロック --------------------------------------------------------------

function placeInstance(
  ctx: Ctx,
  blockId: Id,
  e: Extract<DxfEntity, { kind: 'INSERT' }>,
  at: Vec,
  t: Transform,
  layerId: LayerId,
): void {
  const world = applyPoint(t, at);
  const id = newId('in');
  ctx.scene.instances[id] = {
    id,
    blockId,
    layerId,
    levelId: ctx.scene.activeLevelId,
    x: world.x,
    y: world.y,
    scaleX: e.scaleX,
    scaleY: e.scaleY,
    angle: (e.rotationDeg * Math.PI) / 180,
    label: null,
  };
  ctx.newInstanceIds.push(id);
  bump(ctx.counts, 'ブロック挿入');
}

/**
 * DXF の BLOCK をブロック定義に直す。直せないものは null を返し、呼び出し側が展開に回る。
 *
 * `defineBlock`（block.ts）は「シーン上の図形を定義に移す」関数なのでここでは使わず、
 * `builtinBlocks()` と同じ要領で手で組み立てる。
 */
function resolveBlock(ctx: Ctx, name: string, depth: number): Id | null {
  const cached = ctx.blockCache.get(name);
  if (cached !== undefined) return cached;
  ctx.blockCache.set(name, null); // 循環参照でも戻って来られるように先に入れておく

  const block = ctx.doc.blocks.get(name);
  // 無名ブロック（*D0 など）は定義として持つ意味がないので展開に回す
  if (!block || name.startsWith('*') || depth >= MAX_EXPLODE_DEPTH) return null;
  if (block.entities.length === 0 || block.entities.some((e) => e.kind === 'INSERT')) return null;

  // 画層と同じく、同名の定義があれば再利用する。
  // これで自分で書き出した家具が元の標準ブロックに戻り、読み込みを繰り返しても定義が増えない
  const existing = Object.values(ctx.scene.blocks).find((b) => b.name === name || b.label === name);
  if (existing) {
    ctx.blockCache.set(name, existing.id);
    ctx.report.blocksReused.push(name);
    return existing.id;
  }

  // 定義の中身は基点を原点に、mm に直した局所座標で持つ
  const local: Transform = {
    a: ctx.options.unitScale, b: 0, c: 0, d: ctx.options.unitScale,
    e: -block.base.x * ctx.options.unitScale,
    f: -block.base.y * ctx.options.unitScale,
  };
  const probe: Ctx = { ...ctx, scene: { ...ctx.scene, shapes: {} }, newShapeIds: [], newInstanceIds: [], counts: new Map() };
  probe.scene.shapes = {};
  for (const e of block.entities) convert(probe, e, local, LAYER_IDS.shape, depth + 1);
  const shapes = probe.scene.shapes;
  if (Object.keys(shapes).length === 0) return null;

  const bounds = boundsOf(probe.scene, Object.values(shapes));
  const def: BlockDef = {
    id: newId('bd'),
    name: sanitizeBlockName(name, ctx.takenBlockNames),
    label: name,
    size: bounds ? { w: bounds.w, h: bounds.h } : { w: 1, h: 1 },
    shapes,
    source: 'user',
  };
  ctx.takenBlockNames.add(def.name);
  ctx.scene.blocks[def.id] = def;
  ctx.blockCache.set(name, def.id);
  ctx.report.blocksCreated.push(name);
  return def.id;
}

/** ブロックの中身をその場に展開する。入れ子は MAX_EXPLODE_DEPTH で打ち切る */
function explode(ctx: Ctx, name: string, t: Transform, layerId: LayerId, depth: number): void {
  if (depth > MAX_EXPLODE_DEPTH) {
    ctx.report.warnings.push(`ブロック「${name}」の入れ子が深すぎるため、途中で打ち切りました`);
    return;
  }
  const block = ctx.doc.blocks.get(name);
  if (!block) {
    bump(ctx.doc.skipped, 'INSERT');
    return;
  }
  const local: Transform = { a: 1, b: 0, c: 0, d: 1, e: -block.base.x, f: -block.base.y };
  for (const e of block.entities) {
    // 画層 0 の中身は挿入側の画層を継ぐ、というのが DXF の約束
    const inner = e.layer === '0' ? layerId : resolveLayer(ctx, e.layer);
    convert(ctx, e, compose(t, local), inner, depth);
  }
}

function insertTransform(at: Vec, scaleX: number, scaleY: number, rotationDeg: number): Transform {
  const r = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { a: scaleX * cos, b: scaleX * sin, c: -scaleY * sin, d: scaleY * cos, e: at.x, f: at.y };
}

// --- 画層 ------------------------------------------------------------------

/**
 * DXF の画層名を MiniCAD の画層に対応づける。
 *
 * **同名の画層があれば再利用する**。`A-WALL` を持つ DXF が MiniCAD の壁画層に乗るのが
 * 期待される挙動で、自分で書き出したファイルを読み戻したときも素直に元へ戻ります。
 * ただし既存画層の色や線種は**上書きしない** — 読み込みで手元の図面の見た目が
 * 変わるのは事故なので。
 */
function resolveLayer(ctx: Ctx, name: string): LayerId {
  if (ctx.options.layerMode === 'draft') return LAYER_IDS.draft;

  const cached = ctx.layerCache.get(name);
  if (cached !== undefined) return cached;

  const existing = Object.values(ctx.scene.layers).find((l) => l.name === name);
  if (existing) {
    ctx.layerCache.set(name, existing.id);
    ctx.report.layersReused.push(name);
    return existing.id;
  }

  const source = ctx.doc.layers.get(name);
  const layer = addLayer(ctx.scene.layers, {
    name,
    aci: source ? nearestAci(source.aci) : 7,
    color: hexOf(source ? nearestAci(source.aci) : 7),
    lineType: source ? LINE_TYPE_FROM_DXF[source.lineType.toUpperCase()] ?? 'continuous' : 'continuous',
    visible: source ? source.visible : true,
    locked: ctx.options.lockImported || (source?.locked ?? false),
    weightRole: 'thin',
  });
  ctx.layerCache.set(name, layer.id);
  ctx.report.layersCreated.push(layer.name);
  return layer.id;
}

/** MiniCAD の色欄は ACI 1〜9 しか持たないので、それ以外は 7（白/黒）に丸める */
function nearestAci(aci: number): number {
  return ACI_COLORS.some((c) => c.aci === aci) ? aci : 7;
}

function hexOf(aci: number): string {
  return ACI_COLORS.find((c) => c.aci === aci)?.hex ?? '#3f3f46';
}

// --- 後処理 ----------------------------------------------------------------

function recenter(ctx: Ctx): void {
  const shapes = ctx.newShapeIds.map((id) => ctx.scene.shapes[id]).filter(Boolean);
  const bounds = boundsOf(ctx.scene, shapes);
  const instances = ctx.newInstanceIds.map((id) => ctx.scene.instances[id]).filter(Boolean);
  if (!bounds && instances.length === 0) return;

  let { minX, minY, maxX, maxY } = bounds ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, w: 0, h: 0 };
  for (const inst of instances) {
    minX = Math.min(minX, inst.x);
    minY = Math.min(minY, inst.y);
    maxX = Math.max(maxX, inst.x);
    maxY = Math.max(maxY, inst.y);
  }
  if (!Number.isFinite(minX)) return;

  const delta = vec(-(minX + maxX) / 2, -(minY + maxY) / 2);
  if (Math.abs(delta.x) < 1e-6 && Math.abs(delta.y) < 1e-6) return;
  const t: Transform = { a: 1, b: 0, c: 0, d: 1, e: delta.x, f: delta.y };
  for (const id of ctx.newShapeIds) {
    const shape = ctx.scene.shapes[id];
    if (shape) ctx.scene.shapes[id] = transformShape(ctx.scene, shape, t, null);
  }
  for (const inst of instances) {
    inst.x += delta.x;
    inst.y += delta.y;
  }
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  w: number;
  h: number;
}

function boundsOf(scene: Scene, shapes: Shape[]): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    for (const p of shapeVertices(scene, shape)) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

// --- 小物 ------------------------------------------------------------------

const compose = (outer: Transform, inner: Transform): Transform => ({
  a: outer.a * inner.a + outer.c * inner.b,
  b: outer.b * inner.a + outer.d * inner.b,
  c: outer.a * inner.c + outer.c * inner.d,
  d: outer.b * inner.c + outer.d * inner.d,
  e: outer.a * inner.e + outer.c * inner.f + outer.e,
  f: outer.b * inner.e + outer.d * inner.f + outer.f,
});

const applyPoint = (t: Transform, p: Vec): Vec => vec(t.a * p.x + t.c * p.y + t.e, t.b * p.x + t.d * p.y + t.f);

const polar = (center: Vec, r: number, deg: number): Vec => polarRad(center, r, (deg * Math.PI) / 180);
const polarRad = (center: Vec, r: number, rad: number): Vec =>
  vec(center.x + r * Math.cos(rad), center.y + r * Math.sin(rad));

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

/** レポートを人が読める日本語にする */
export function formatReport(r: ImportReport): string {
  const lines: string[] = [];
  if (r.unitNote) lines.push(r.unitNote);
  if (r.imported.length === 0) lines.push('取り込めた図形はありませんでした。');
  else lines.push(`取り込み: ${r.imported.map((i) => `${i.kind} ${i.count} 件`).join(' / ')}`);
  if (r.skipped.length > 0) {
    lines.push(`読み飛ばし: ${r.skipped.map((s) => `${s.kind} ${s.count} 件（${s.reason}）`).join(' / ')}`);
  }
  if (r.layersCreated.length > 0) lines.push(`画層を追加: ${r.layersCreated.join(', ')}`);
  if (r.layersReused.length > 0) lines.push(`既存の画層を使用: ${[...new Set(r.layersReused)].join(', ')}`);
  if (r.blocksCreated.length > 0) lines.push(`ブロックを追加: ${r.blocksCreated.join(', ')}`);
  if (r.blocksReused.length > 0) lines.push(`既存のブロックを使用: ${[...new Set(r.blocksReused)].join(', ')}`);
  for (const w of r.warnings) lines.push(`注意: ${w}`);
  return lines.join('\n');
}
