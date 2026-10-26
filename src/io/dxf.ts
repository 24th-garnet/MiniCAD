import { add, toDeg, vec, type Vec } from '../core/geometry.ts';
import { sceneBounds } from '../core/entity.ts';
import { sheetGeometry, sheetPrimitives } from '../core/sheet.ts';
import { getLayer, LAYER_IDS, type Layer } from '../core/layer.ts';
import { toTatami } from '../core/rooms.ts';
import { wallOutline, type Segment } from '../core/shape.ts';
import { openingPrimitives } from '../core/opening.ts';
import { encodeCp932 } from './cp932.ts';
import { paperToWorld, type DrawingStandard } from '../core/standard.ts';
import {
  dimensionGeometry,
  dimensionPrimitives,
  EXTENSION_OVERSHOOT_PAPER_MM,
  TICK_PAPER_MM,
} from '../core/dimension.ts';
import {
  dimensionBlockName,
  dxfBlock,
  dxfDimension,
  dxfInsert,
  dxfLine,
  dxfPrimitives,
  dxfText,
  fmt,
  normalizeTextDeg,
  LTYPE_NAMES,
} from './dxfPrimitive.ts';
import {
  blockOf,
  instanceLabel,
  instanceSize,
  labelFits,
} from '../core/block.ts';
import { shapePrimitives } from '../core/shapes.ts';
import type { Settings } from '../core/store.ts';
import type { Room, Scene } from '../core/types.ts';

/**
 * DXF R12 (AC1009) で書き出す。
 *
 * R12 を選んだのは、構造が単純でハンドル管理が要らず、LibreCAD / QCAD / JW_CAD /
 * AutoCAD のどれでも素直に開けるためです。代わりに R12 には画層の線幅という概念が
 * ないので、線の太さは **色 (ACI)** で運びます。日本の CAD 運用で昔から使われてきた
 * 「色＝線の太さ」の対応と同じ考え方で、受け取った側はペン設定で太さに戻します。
 * 正確な mm 値は MiniCAD の JSON 側に保持されます。
 *
 * 座標はワールドの mm をそのまま 1:1 で書きます（$INSUNITS = 4 / mm）。
 * 尺度は紙に出すときの話なので、モデル空間は原寸、というCADの流儀に合わせています。
 */
export interface DxfOptions {
  /** 日本語を \U+XXXX に変換して ASCII だけのファイルにする */
  escapeUnicode: boolean;
  /**
   * Shift-JIS (cp932) で書き出す。
   *
   * **Jw_cad は Shift-JIS しか読めない。** UTF-8 のまま渡すと室名も表題欄も
   * 文字化けする。`$DWGCODEPAGE` もこれに合わせて切り替える。
   *
   * AutoCAD など UTF-8 を読む受け手には不要なので、既定は false。
   */
  shiftJis?: boolean;
  /**
   * 寸法を本物の DIMENSION エンティティで書く。
   *
   * false にすると線と文字に分解する（従来の出力）。R12 の DIMENSION を
   * 正しく読めない簡易ビューアや、ブロックを捨てて DIMSTYLE から描き直す
   * 受け手のための逃げ道。
   */
  trueDimension: boolean;
}

/** 線種の定義。長さはワールドの mm（1:100 の紙で見たときに妥当な見た目になる値） */
const LTYPE_DEFS: { name: string; description: string; pattern: number[] }[] = [
  { name: 'CONTINUOUS', description: 'Solid line', pattern: [] },
  { name: 'DASHED', description: '__ __ __ __', pattern: [400, -200] },
  { name: 'HIDDEN', description: '__ __ __ __', pattern: [200, -100] },
  { name: 'CENTER', description: '____ _ ____', pattern: [1200, -200, 200, -200] },
  { name: 'PHANTOM', description: '____ _ _ __', pattern: [1200, -200, 200, -200, 200, -200] },
];

/** 寸法のスタイル名。DIMSTYLE テーブルと各 DIMENSION のコード 3 で使う */
const DIMSTYLE_NAME = 'MINICAD';

/** ヘッダ変数名 → DIMSTYLE テーブル内でのグループコード */
const DIMSTYLE_CODES: Record<string, number> = {
  $DIMSCALE: 40, $DIMASZ: 41, $DIMEXO: 42, $DIMEXE: 44,
  $DIMTXT: 140, $DIMTSZ: 142, $DIMGAP: 147, $DIMLFAC: 144,
  $DIMTAD: 77, $DIMTIH: 73, $DIMTOH: 74, $DIMTOFL: 172, $DIMZIN: 78,
};

/**
 * 寸法の見た目を決める変数。
 *
 * 長さ系はすべて**ワールドの mm**。モデル空間を原寸で書いて $DIMSCALE = 1 にしている以上、
 * DIM* の長さ量も世界 mm でないと受け手での見た目が合わない。
 * 値は core/dimension.ts が画面に描くときの式と同じものを使う。
 */
function dimVariables(std: DrawingStandard): { name: string; code: number; value: number }[] {
  const tick = paperToWorld(TICK_PAPER_MM, std);
  return [
    { name: '$DIMSCALE', code: 40, value: 1 },
    { name: '$DIMASZ', code: 40, value: tick },
    // DIMTSZ > 0 で矢印ではなく45度の斜線になる（建築の流儀）
    { name: '$DIMTSZ', code: 40, value: tick },
    { name: '$DIMEXO', code: 40, value: 0 },
    { name: '$DIMEXE', code: 40, value: paperToWorld(EXTENSION_OVERSHOOT_PAPER_MM, std) },
    { name: '$DIMTXT', code: 40, value: paperToWorld(std.textHeight.dimension, std) },
    { name: '$DIMGAP', code: 40, value: paperToWorld(std.textHeight.dimension * 0.7, std) },
    { name: '$DIMLFAC', code: 40, value: 1 },
    { name: '$DIMTAD', code: 70, value: 1 }, // 文字は寸法線の上
    { name: '$DIMTIH', code: 70, value: 0 }, // 文字を寸法線と平行に
    { name: '$DIMTOH', code: 70, value: 0 },
    { name: '$DIMTOFL', code: 70, value: 1 }, // 補助線の間に必ず寸法線を引く
    { name: '$DIMZIN', code: 70, value: 0 },
  ];
}

export function sceneToDxf(scene: Scene, rooms: Room[], settings: Settings, options: DxfOptions): string {
  const std = scene.standard;
  const out: string[] = [];
  const g = (code: number, value: string | number) => {
    out.push(String(code));
    out.push(typeof value === 'number' ? fmt(value) : value);
  };
  const text = (s: string) => (options.escapeUnicode ? escapeUnicode(s) : s);

  const layerOf = (id: string | undefined, fallback: string): Layer => getLayer(scene.layers, id, fallback);
  const printable = (layer: Layer): boolean => layer.visible && layer.printable;

  // --- エンティティを先に組み立てて、図面範囲を確定させる ---
  const entities: string[][] = [];
  const pushLine = (a: Vec, b: Vec, layer: Layer) => {
    entities.push(dxfLine(a, b, layer.name));
  };
  const pushSegments = (segments: Segment[], layer: Layer) => {
    for (const s of segments) pushLine(s.a, s.b, layer);
  };
  const pushText = (value: string, at: Vec, height: number, rotationDeg: number, layer: Layer) => {
    entities.push(dxfText(text(value), at, height, rotationDeg, layer.name));
  };

  // 壁
  for (const wall of Object.values(scene.walls)) {
    const layer = layerOf(wall.layerId, LAYER_IDS.wall);
    if (!printable(layer)) continue;
    pushSegments(wallOutline(scene, wall), layer);
  }

  // 建具。小口（ジャム）は wallOutline が壁側で出しているので、ここで足すと二重線になる
  for (const op of Object.values(scene.openings)) {
    const layer = layerOf(op.layerId, LAYER_IDS.opening);
    if (!printable(layer)) continue;
    entities.push(...dxfPrimitives(openingPrimitives(scene, op), layer, std, text));
  }

  // ブロックの挿入。同じ定義は1つだけ書き、INSERT で使い回す
  const usedBlocks = new Map<string, string[]>();
  const furnitureSize = paperToWorld(std.textHeight.furniture, std);
  for (const inst of Object.values(scene.instances)) {
    const layer = layerOf(inst.layerId, LAYER_IDS.furniture);
    if (!printable(layer)) continue;
    const def = blockOf(scene, inst);
    if (!def) continue;

    if (!usedBlocks.has(def.name)) {
      // 定義の中身は画層 0 に置いて、INSERT 側の画層を継承させる
      const zeroLayer = { ...layer, name: '0' };
      const body = Object.values(def.shapes).flatMap((shape) =>
        dxfPrimitives(shapePrimitives({ ...scene, shapes: def.shapes }, shape, std), zeroLayer, std, text),
      );
      usedBlocks.set(def.name, dxfBlock(def.name, vec(0, 0), body));
    }
    entities.push(dxfInsert(def.name, vec(inst.x, inst.y), inst.scaleX, inst.scaleY, toDeg(inst.angle), layer.name));

    const label = instanceLabel(scene, inst);
    if (labelFits(label, instanceSize(def, inst), furnitureSize)) {
      pushText(label, vec(inst.x, inst.y), furnitureSize, normalizeTextDeg(toDeg(inst.angle)), layer);
    }
  }

  // 用紙枠と表題欄
  const sheetLayer = layerOf(LAYER_IDS.sheet, LAYER_IDS.sheet);
  if (scene.sheet.show && printable(sheetLayer)) {
    entities.push(...dxfPrimitives(sheetPrimitives(scene.sheet, std), sheetLayer, std, text));
  }

  // 汎用図形。寸法だけは本物の DIMENSION エンティティとして別経路で出す
  let dimSeq = 0;
  for (const shape of Object.values(scene.shapes)) {
    const layer = layerOf(shape.layerId, LAYER_IDS.shape);
    if (!printable(layer)) continue;

    if (shape.shape === 'dimension' && options.trueDimension) {
      const g = dimensionGeometry(scene, shape, std);
      if (!g) continue;
      // 実体は無名ブロックに入れる。本体は画層 0 に置き、DIMENSION 側の画層を継がせる
      const name = dimensionBlockName(dimSeq++);
      const body = dxfPrimitives(dimensionPrimitives(scene, shape, std), { ...layer, name: '0' }, std, text);
      usedBlocks.set(name, dxfBlock(name, vec(0, 0), body, 1));
      entities.push(
        dxfDimension({
          blockName: name,
          layerName: layer.name,
          styleName: DIMSTYLE_NAME,
          defPoint: g.line.b,
          textMid: g.textAt,
          ext1: g.a,
          ext2: g.b,
          text: text(g.text),
          measurement: g.value,
        }),
      );
      continue;
    }

    entities.push(...dxfPrimitives(shapePrimitives(scene, shape, std), layer, std, text));
  }

  // 室名・面積
  const nameLayer = layerOf(LAYER_IDS.roomName, LAYER_IDS.roomName);
  if (printable(nameLayer)) {
    const nameSize = paperToWorld(std.textHeight.room, std);
    const areaSize = paperToWorld(std.textHeight.area, std);
    for (const room of rooms) {
      const area = settings.innerArea ? room.innerArea : room.area;
      if (room.name) pushText(room.name, add(room.center, vec(0, areaSize * 0.8)), nameSize, 0, nameLayer);
      pushText(
        `${area.toFixed(2)}m2 (${toTatami(area).toFixed(1)})`,
        add(room.center, vec(0, room.name ? -nameSize * 0.6 : 0)),
        areaSize,
        0,
        nameLayer,
      );
    }
  }

  let bounds = sceneBounds(scene) ?? { min: vec(0, 0), max: vec(1000, 1000) };
  if (scene.sheet.show) {
    // 用紙を出しているなら、図面範囲は用紙を含む
    const paper = sheetGeometry(scene.sheet, std).paper;
    bounds = {
      min: vec(Math.min(bounds.min.x, paper.min.x), Math.min(bounds.min.y, paper.min.y)),
      max: vec(Math.max(bounds.max.x, paper.max.x), Math.max(bounds.max.y, paper.max.y)),
    };
  }

  // --- HEADER ---
  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER');
  g(1, 'AC1009');
  // **宣言と中身を食い違わせない。** 受け手は これを見て読み方を決める
  g(9, '$DWGCODEPAGE');
  g(1, options.shiftJis ? 'ANSI_932' : 'UTF-8');
  g(9, '$INSUNITS'); // 4 = ミリメートル
  g(70, 4);
  g(9, '$MEASUREMENT'); // 1 = メートル法
  g(70, 1);
  g(9, '$LUNITS'); // 2 = 十進表記
  g(70, 2);
  g(9, '$DIMSTYLE');
  g(2, DIMSTYLE_NAME);
  for (const v of dimVariables(std)) {
    g(9, v.name);
    g(v.code, v.value);
  }
  g(9, '$EXTMIN');
  g(10, bounds.min.x);
  g(20, bounds.min.y);
  g(30, 0);
  g(9, '$EXTMAX');
  g(10, bounds.max.x);
  g(20, bounds.max.y);
  g(30, 0);
  g(0, 'ENDSEC');

  // --- TABLES ---
  g(0, 'SECTION');
  g(2, 'TABLES');

  g(0, 'TABLE');
  g(2, 'LTYPE');
  g(70, LTYPE_DEFS.length);
  for (const def of LTYPE_DEFS) {
    g(0, 'LTYPE');
    g(2, def.name);
    g(70, 64);
    g(3, def.description);
    g(72, 65);
    g(73, def.pattern.length);
    g(40, def.pattern.reduce((s, v) => s + Math.abs(v), 0));
    for (const v of def.pattern) g(49, v);
  }
  g(0, 'ENDTAB');

  const layers = Object.values(scene.layers);
  g(0, 'TABLE');
  g(2, 'LAYER');
  g(70, layers.length);
  for (const layer of layers) {
    g(0, 'LAYER');
    g(2, layer.name);
    g(70, layer.locked ? 4 : 0);
    // 色番号を負にすると、その画層は非表示として読み込まれる
    g(62, layer.visible ? layer.aci : -layer.aci);
    g(6, LTYPE_NAMES[layer.lineType]);
  }
  g(0, 'ENDTAB');

  g(0, 'TABLE');
  g(2, 'STYLE');
  g(70, 1);
  g(0, 'STYLE');
  g(2, 'STANDARD');
  g(70, 0);
  g(40, 0);
  g(41, 1);
  g(50, 0);
  g(71, 0);
  g(42, 2.5);
  g(3, 'txt');
  g(4, '');
  g(0, 'ENDTAB');

  // DIMSTYLE。R13 以降にしかない変数（DIMDEC など）は書かない
  g(0, 'TABLE');
  g(2, 'DIMSTYLE');
  g(70, 1);
  g(0, 'DIMSTYLE');
  g(2, DIMSTYLE_NAME);
  g(70, 0);
  for (const v of dimVariables(std)) {
    // ヘッダ変数名 $DIMxxx を DIMSTYLE のグループコードに読み替える
    g(DIMSTYLE_CODES[v.name], v.value);
  }
  g(0, 'ENDTAB');

  g(0, 'ENDSEC');

  g(0, 'SECTION');
  g(2, 'BLOCKS');
  for (const block of usedBlocks.values()) out.push(...block);
  g(0, 'ENDSEC');

  g(0, 'SECTION');
  g(2, 'ENTITIES');
  for (const e of entities) out.push(...e);
  g(0, 'ENDSEC');

  g(0, 'EOF');

  // DXF の行区切りは CRLF
  return out.join('\r\n') + '\r\n';
}



/** ASCII 以外を \U+XXXX に変換する。文字コードの取り違えで化けるのを避けたいとき用 */
function escapeUnicode(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 128 ? ch : `\\U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/**
 * DXF をファイルとして書き出す。
 *
 * `shiftJis` のときは cp932 のバイト列にしてから Blob にする。文字列のまま
 * Blob に渡すとブラウザが UTF-8 で書いてしまい、`$DWGCODEPAGE` の宣言と
 * 中身が食い違う。
 *
 * 収まらなかった字は `?` になるので、**黙って落とさずに数を返す**。
 */
/**
 * 書き出しで落ちるものを数える。
 *
 * **持っていないものは、持っていないと書く。** 透過は R12 の LAYER に
 * 無く、R2004+ のグループコード 440 が要る。黙って落とすと、受け取った側が
 * 「透かしたはずの図面が透けていない」理由を追えない。
 * Shift-JIS の欠字報告と同じ扱い。
 */
export function exportLossReport(scene: Scene): string[] {
  const out: string[] = [];
  const faded = Object.values(scene.layers).filter((l) => l.visible && l.opacity < 1);
  if (faded.length > 0) {
    out.push(
      `透過を落としました（DXF R12 にも SVG の書き出しにも乗せていません）: `
      + faded.map((l) => `${l.name} ${Math.round(l.opacity * 100)}%`).join(' / '),
    );
  }
  if (Object.keys(scene.views).length > 1) {
    out.push(
      `図面は ${Object.keys(scene.views).length} 枚ありますが、`
      + `書き出したのは作業中の 1 枚だけです。`,
    );
  }
  return out;
}

export function downloadDxf(
  scene: Scene,
  rooms: Room[],
  settings: Settings,
  options: DxfOptions,
  filename = 'madori.dxf',
): string[] {
  const dxf = sceneToDxf(scene, rooms, settings, options);
  let dropped: string[] = [];
  let body: BlobPart = dxf;
  if (options.shiftJis) {
    const got = encodeCp932(dxf);
    body = got.bytes.buffer as ArrayBuffer;
    dropped = got.dropped;
  }
  const blob = new Blob([body], { type: 'application/dxf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return dropped;
}
