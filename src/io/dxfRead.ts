/**
 * DXF のレコードを、中立な「DXF 模型」に直す。
 *
 * ここも **MiniCAD のことは知りません**。`Shape` や `Scene` への変換は dxfImport.ts の仕事です。
 * 層を分けておくと、「DXF をどう読むか」と「MiniCAD にどう落とすか」を別々にテストできます。
 *
 * R12 と 2018 以降の違いは、ほとんどが「エンティティの種類が増える」ことと
 * 「サブクラスマーカ(100) やハンドル(5) が差し込まれる」ことです。
 * グループコードを種類ごとに拾う読み方なら、知らないコードは黙って無視されるので
 * どちらの版もそのまま読めます。
 */

import { rotate, vec, type Vec } from '../core/geometry.ts';
import type { TextAlign } from '../core/primitive.ts';
import {
  decodeDxf,
  isMirroredOcs,
  num,
  readTags,
  splitRecords,
  splitSections,
  str,
  type DxfRecord,
  type RawVertex,
} from './dxfTags.ts';

export type DxfKind =
  | 'LINE'
  | 'LWPOLYLINE'
  | 'POLYLINE'
  | 'ARC'
  | 'CIRCLE'
  | 'TEXT'
  | 'MTEXT'
  | 'INSERT'
  | 'DIMENSION'
  | 'ELLIPSE'
  | 'SOLID'
  | 'POINT'
  | '3DFACE';

interface Base {
  layer: string;
}

export type DxfEntity =
  | (Base & { kind: 'LINE'; a: Vec; b: Vec })
  | (Base & { kind: 'LWPOLYLINE'; vertices: RawVertex[]; closed: boolean })
  | (Base & { kind: 'POLYLINE'; vertices: RawVertex[]; closed: boolean })
  | (Base & { kind: 'ARC'; center: Vec; radius: number; startDeg: number; endDeg: number })
  | (Base & { kind: 'CIRCLE'; center: Vec; radius: number })
  | (Base & { kind: 'TEXT'; at: Vec; text: string; height: number; rotationDeg: number; align: TextAlign })
  | (Base & { kind: 'MTEXT'; at: Vec; text: string; height: number; rotationDeg: number; align: TextAlign })
  | (Base & {
      kind: 'INSERT';
      name: string;
      at: Vec;
      scaleX: number;
      scaleY: number;
      rotationDeg: number;
      columns: number;
      rows: number;
      colSpacing: number;
      rowSpacing: number;
    })
  | (Base & { kind: 'DIMENSION'; block: string })
  | (Base & { kind: 'ELLIPSE'; center: Vec; major: Vec; ratio: number; startParam: number; endParam: number })
  | (Base & { kind: 'SOLID'; points: Vec[] })
  | (Base & { kind: 'POINT'; at: Vec })
  | (Base & { kind: '3DFACE'; points: Vec[] });

export interface DxfLayer {
  name: string;
  aci: number;
  lineType: string;
  visible: boolean;
  locked: boolean;
}

export interface DxfBlock {
  name: string;
  base: Vec;
  entities: DxfEntity[];
}

export interface DxfDocument {
  header: Map<string, DxfRecord>;
  layers: Map<string, DxfLayer>;
  blocks: Map<string, DxfBlock>;
  entities: DxfEntity[];
  /** 種別ごとの出現数（読めたものだけ） */
  counts: Map<string, number>;
  /** 読み飛ばした種別と件数 */
  skipped: Map<string, number>;
  warnings: string[];
}

/**
 * エンティティの読み取り表。
 *
 * `{ [K in DxfKind]: … }` のマップ型なので、`DxfKind` に種別を足すと
 * ここが型エラーになります（shapeRead.ts の SHAPE_READERS と同じ流儀）。
 *
 * `follow` は POLYLINE に続く VERTEX レコード。他の種別では常に空です。
 */
type Reader<K extends DxfKind> = (
  r: DxfRecord,
  follow: DxfRecord[],
) => Extract<DxfEntity, { kind: K }> | null;

const ENTITY_READERS: { [K in DxfKind]: Reader<K> } = {
  LINE: (r) => {
    const m = isMirroredOcs(r);
    const a = pt(r, 10, 20, m);
    const b = pt(r, 11, 21, m);
    // 長さゼロの線は図面上の意味がないうえ、途中で切れたファイルからも生まれる
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) return null;
    return { kind: 'LINE', layer: layerOf(r), a, b };
  },

  LWPOLYLINE: (r) => {
    const verts = ocsVertices(r);
    if (verts.length < 2) return null;
    return { kind: 'LWPOLYLINE', layer: layerOf(r), vertices: verts, closed: (num(r, 70, 0) & 1) !== 0 };
  },

  POLYLINE: (r, follow) => {
    const flags = num(r, 70, 0);
    // bit3(8)=3Dポリライン / bit4(16)=メッシュ / bit6(64)=ポリフェイスメッシュ。平面図には落とせない
    if ((flags & (8 | 16 | 64)) !== 0) return null;
    const m = isMirroredOcs(r);
    const verts: RawVertex[] = follow.map((v) => {
      const p = pt(v, 10, 20, m);
      return { x: p.x, y: p.y, bulge: num(v, 42, 0) * (m ? -1 : 1) };
    });
    if (verts.length < 2) return null;
    return { kind: 'POLYLINE', layer: layerOf(r), vertices: verts, closed: (flags & 1) !== 0 };
  },

  ARC: (r) => {
    const radius = num(r, 40, 0);
    if (!(radius > 0)) return null;
    const m = isMirroredOcs(r);
    const start = num(r, 50, 0);
    const end = num(r, 51, 0);
    // 鏡像 OCS では掃く向きが逆になる。始終点を入れ替えて「常に反時計回り」を保つ
    return {
      kind: 'ARC',
      layer: layerOf(r),
      center: pt(r, 10, 20, m),
      radius,
      startDeg: m ? 180 - end : start,
      endDeg: m ? 180 - start : end,
    };
  },

  CIRCLE: (r) => {
    const radius = num(r, 40, 0);
    if (!(radius > 0)) return null;
    return { kind: 'CIRCLE', layer: layerOf(r), center: pt(r, 10, 20, isMirroredOcs(r)), radius };
  },

  TEXT: (r) => {
    const text = str(r, 1, '');
    if (text === '') return null;
    const height = num(r, 40, 0);
    if (!(height > 0)) return null;
    const m = isMirroredOcs(r);
    // 72/73 が 0 以外のときは 11/21 が実際の挿入点になる（DXF の仕様）
    const useSecond = num(r, 72, 0) !== 0 || num(r, 73, 0) !== 0;
    const anchor = useSecond ? pt(r, 11, 21, m) : pt(r, 10, 20, m);
    const rotationDeg = m ? 180 - num(r, 50, 0) : num(r, 50, 0);
    return {
      kind: 'TEXT',
      layer: layerOf(r),
      at: toMiddle(anchor, height, rotationDeg, num(r, 73, 0)),
      text: decodeTextCodes(text),
      height,
      rotationDeg,
      align: H_ALIGN[num(r, 72, 0)] ?? 'left',
    };
  },

  MTEXT: (r) => {
    // 250字を超えると 3 に分割され、最後の断片だけが 1 に入る
    const body = r.tags.filter((t) => t.code === 3).map((t) => t.value).join('') + str(r, 1, '');
    if (body === '') return null;
    const height = num(r, 40, 0);
    if (!(height > 0)) return null;
    const attach = num(r, 71, 1);
    return {
      kind: 'MTEXT',
      layer: layerOf(r),
      at: pt(r, 10, 20, isMirroredOcs(r)),
      text: stripMtextFormat(body),
      height,
      rotationDeg: num(r, 50, 0),
      align: MTEXT_ALIGN[(attach - 1) % 3] ?? 'left',
    };
  },

  INSERT: (r) => {
    const name = str(r, 2, '');
    if (name === '') return null;
    const m = isMirroredOcs(r);
    return {
      kind: 'INSERT',
      layer: layerOf(r),
      name,
      at: pt(r, 10, 20, m),
      scaleX: num(r, 41, 1) * (m ? -1 : 1),
      scaleY: num(r, 42, 1),
      rotationDeg: m ? 180 - num(r, 50, 0) : num(r, 50, 0),
      columns: Math.max(1, Math.round(num(r, 70, 1))),
      rows: Math.max(1, Math.round(num(r, 71, 1))),
      colSpacing: num(r, 44, 0),
      rowSpacing: num(r, 45, 0),
    };
  },

  DIMENSION: (r) => {
    const block = str(r, 2, '');
    if (block === '') return null;
    return { kind: 'DIMENSION', layer: layerOf(r), block };
  },

  ELLIPSE: (r) => {
    const m = isMirroredOcs(r);
    const major = pt(r, 11, 21, m);
    if (major.x === 0 && major.y === 0) return null;
    return {
      kind: 'ELLIPSE',
      layer: layerOf(r),
      center: pt(r, 10, 20, m),
      major,
      ratio: num(r, 40, 1),
      startParam: num(r, 41, 0),
      endParam: num(r, 42, Math.PI * 2),
    };
  },

  SOLID: (r) => {
    const m = isMirroredOcs(r);
    // DXF の SOLID は 3 番目と 4 番目の頂点が入れ替わっている。10,11,13,12 の順に回ると輪郭になる
    const corners = [pt(r, 10, 20, m), pt(r, 11, 21, m), pt(r, 13, 23, m), pt(r, 12, 22, m)];
    return { kind: 'SOLID', layer: layerOf(r), points: dedupe(corners) };
  },

  POINT: (r) => ({ kind: 'POINT', layer: layerOf(r), at: pt(r, 10, 20, isMirroredOcs(r)) }),

  '3DFACE': (r) => {
    // 平面（全頂点の z が同じ）のときだけ平面図に落とせる
    const z = [num(r, 30, 0), num(r, 31, 0), num(r, 32, 0), num(r, 33, 0)];
    if (z.some((v) => Math.abs(v - z[0]) > 1e-6)) return null;
    const corners = [pt(r, 10, 20, false), pt(r, 11, 21, false), pt(r, 12, 22, false), pt(r, 13, 23, false)];
    const points = dedupe(corners);
    return points.length >= 3 ? { kind: '3DFACE', layer: layerOf(r), points } : null;
  },
};

const DXF_KINDS = new Set(Object.keys(ENTITY_READERS));

/** TEXT の 72（水平位置） */
const H_ALIGN: Record<number, TextAlign> = { 0: 'left', 1: 'center', 2: 'right', 3: 'left', 4: 'center', 5: 'left' };
/** MTEXT の 71（基点）は 1..9 で、3 で割った余りが左/中央/右 */
const MTEXT_ALIGN: TextAlign[] = ['left', 'center', 'right'];

export function parseDxfBytes(bytes: Uint8Array): DxfDocument {
  return parseDxf(decodeDxf(bytes));
}

export function parseDxf(text: string): DxfDocument {
  const warnings: string[] = [];
  const sections = splitSections(readTags(text));
  if (sections.size === 0) warnings.push('SECTION が見つかりません。DXF ではない可能性があります。');

  const doc: DxfDocument = {
    header: readHeader(sections.get('HEADER') ?? []),
    layers: readLayers(sections.get('TABLES') ?? []),
    blocks: new Map(),
    entities: [],
    counts: new Map(),
    skipped: new Map(),
    warnings,
  };

  readBlocks(doc, sections.get('BLOCKS') ?? []);
  doc.entities = readEntities(doc, splitRecords(sections.get('ENTITIES') ?? []));
  return doc;
}

/** $変数名 → そのレコード。HEADER は「9 $名前」に続けて値のタグが並ぶ */
function readHeader(tags: ReturnType<typeof readTags>): Map<string, DxfRecord> {
  const header = new Map<string, DxfRecord>();
  let current: DxfRecord | null = null;
  for (const tag of tags) {
    if (tag.code === 9) {
      current = { type: tag.value, tags: [] };
      header.set(tag.value.toUpperCase(), current);
    } else if (current) {
      current.tags.push(tag);
    }
  }
  return header;
}

function readLayers(tags: ReturnType<typeof readTags>): Map<string, DxfLayer> {
  const layers = new Map<string, DxfLayer>();
  for (const r of splitRecords(tags)) {
    if (r.type !== 'LAYER') continue;
    const name = str(r, 2, '');
    if (name === '') continue;
    const color = num(r, 62, 7);
    const flags = num(r, 70, 0);
    layers.set(name, {
      name,
      // 負の色番号は「非表示」を表す（MiniCAD 自身も書き出しでそうしている）
      aci: Math.abs(Math.round(color)) || 7,
      lineType: str(r, 6, 'CONTINUOUS'),
      visible: color >= 0 && (flags & 1) === 0,
      locked: (flags & 4) !== 0,
    });
  }
  return layers;
}

function readBlocks(doc: DxfDocument, tags: ReturnType<typeof readTags>): void {
  const records = splitRecords(tags);
  let i = 0;
  while (i < records.length) {
    if (records[i].type !== 'BLOCK') {
      i++;
      continue;
    }
    const head = records[i];
    const body: DxfRecord[] = [];
    let j = i + 1;
    for (; j < records.length && records[j].type !== 'ENDBLK'; j++) body.push(records[j]);
    const name = str(head, 2, '');
    if (name !== '') {
      doc.blocks.set(name, {
        name,
        base: pt(head, 10, 20, false),
        entities: readEntities(doc, body),
      });
    }
    i = j + 1;
  }
}

function readEntities(doc: DxfDocument, records: DxfRecord[]): DxfEntity[] {
  const out: DxfEntity[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.type === 'VERTEX' || r.type === 'SEQEND' || r.type === 'ATTRIB') continue;

    if (!DXF_KINDS.has(r.type)) {
      bump(doc.skipped, r.type);
      continue;
    }

    // POLYLINE は続く VERTEX レコードに頂点が入っている
    const follow: DxfRecord[] = [];
    if (r.type === 'POLYLINE') {
      for (let j = i + 1; j < records.length && records[j].type === 'VERTEX'; j++) follow.push(records[j]);
    }

    const kind = r.type as DxfKind;
    const entity = (ENTITY_READERS[kind] as Reader<DxfKind>)(r, follow);
    if (entity) {
      out.push(entity);
      bump(doc.counts, r.type);
    } else {
      bump(doc.skipped, r.type);
    }
  }
  return out;
}

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

function layerOf(r: DxfRecord): string {
  return str(r, 8, '0');
}

function pt(r: DxfRecord, xCode: number, yCode: number, mirrored: boolean): Vec {
  const x = num(r, xCode, 0);
  return vec(mirrored ? -x : x, num(r, yCode, 0));
}

function ocsVertices(r: DxfRecord): RawVertex[] {
  const mirrored = isMirroredOcs(r);
  const out: RawVertex[] = [];
  for (const t of r.tags) {
    const n = Number(t.value);
    const v = Number.isFinite(n) ? n : 0;
    if (t.code === 10) out.push({ x: mirrored ? -v : v, y: 0, bulge: 0 });
    else if (t.code === 20 && out.length > 0) out[out.length - 1].y = v;
    else if (t.code === 42 && out.length > 0) out[out.length - 1].bulge = mirrored ? -v : v;
  }
  return out;
}

function dedupe(points: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-9 && Math.abs(last.y - p.y) < 1e-9) continue;
    out.push(p);
  }
  return out;
}

/**
 * MiniCAD の文字は常に縦中央（textBaseline = 'middle'）に置かれる。
 * DXF の 73（0=ベースライン / 1=下 / 2=中央 / 3=上）から中央位置へ寄せ直す。
 */
function toMiddle(anchor: Vec, height: number, rotationDeg: number, vAlign: number): Vec {
  const shift = vAlign === 2 ? 0 : vAlign === 3 ? -height / 2 : height / 2;
  if (shift === 0) return anchor;
  const d = rotate(vec(0, shift), (rotationDeg * Math.PI) / 180);
  return vec(anchor.x + d.x, anchor.y + d.y);
}

/** %%d などの古い制御コードを実際の文字に戻す */
function decodeTextCodes(s: string): string {
  return s.replace(/%%d/gi, '°').replace(/%%c/gi, '⌀').replace(/%%p/gi, '±').replace(/%%%/g, '%');
}

/** MTEXT の書式コードを剥ぎ、改行を \n にする */
export function stripMtextFormat(s: string): string {
  return decodeTextCodes(
    s
      .replace(/\\P/g, '\n')
      .replace(/\\~/g, ' ')
      .replace(/\{\\[^;]*;/g, '')
      .replace(/\\[fF][^;]*;/g, '')
      .replace(/\\[HWQTAC][^;]*;/g, '')
      .replace(/\\S([^;]*);/g, '$1')
      .replace(/\\[LlOoKkNnXx]/g, '')
      .replace(/[{}]/g, '')
      .replace(/\\\\/g, '\\'),
  );
}
