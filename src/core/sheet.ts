import { add, vec, type Bounds, type Vec } from './geometry.ts';
import type { Primitive, TextAlign } from './primitive.ts';
import type { Segment } from './shape.ts';
import { PLAN_SCALES, paperById, paperToWorld, type DrawingStandard } from './standard.ts';

/**
 * 輪郭線の余白（紙の上の mm）。
 * JIS Z 8311 では A0・A1 が四辺 20mm、A2〜A4 が 10mm。
 * とじ代は一律 20mm で、横置きなら左辺に取る。
 */
export interface SheetMargins {
  binding: number;
  top: number;
  right: number;
  bottom: number;
}

export function jisMargins(paperId: string): SheetMargins {
  const wide = paperId === 'A0' || paperId === 'A1';
  const m = wide ? 20 : 10;
  return { binding: 20, top: m, right: m, bottom: m };
}

export interface TitleBlockFields {
  drawingName: string;
  drawingNumber: string;
  company: string;
  designer: string;
  /** ISO 文字列ではなく、そのまま表示する文字列 */
  date: string;
}

export interface TitleBlock {
  enabled: boolean;
  /** 幅（紙の上の mm）。JIS/ISO は 170〜180 */
  width: number;
  rowHeight: number;
  fields: TitleBlockFields;
}

export interface Sheet {
  /** 画面に枠を出すか */
  show: boolean;
  /** 用紙の左下隅のワールド座標 */
  origin: Vec;
  /** null なら jisMargins() を使う */
  margins: SheetMargins | null;
  titleBlock: TitleBlock;
}

export function defaultSheet(): Sheet {
  return {
    show: false,
    origin: vec(0, 0),
    margins: null,
    titleBlock: {
      enabled: true,
      width: 170,
      rowHeight: 8,
      fields: { drawingName: '平面図', drawingNumber: '', company: '', designer: '', date: '' },
    },
  };
}

/** 用紙の実寸（紙の上の mm）。向きを解決する */
export function paperDimensions(std: DrawingStandard): { w: number; h: number } {
  const paper = paperById(std.paperId);
  return std.orientation === 'portrait'
    ? { w: paper.short, h: paper.long }
    : { w: paper.long, h: paper.short };
}

export interface SheetGeometry {
  /** いずれもワールド mm */
  paper: Bounds;
  frame: Bounds;
  titleBox: Bounds | null;
  /** 用紙の外形 */
  paperOutline: Segment[];
  /** 輪郭線 */
  frameOutline: Segment[];
  /** 表題欄の罫線 */
  rules: Segment[];
  /** 表題欄の文字。高さは紙の上の mm */
  texts: { text: string; at: Vec; paperMm: number; align: TextAlign; weight: number }[];
}

const rect = (b: Bounds): Segment[] => {
  const corners = [b.min, vec(b.max.x, b.min.y), b.max, vec(b.min.x, b.max.y)];
  return corners.map((a, i) => ({ a, b: corners[(i + 1) % 4] }));
};

/**
 * 用紙枠・輪郭線・表題欄をワールド座標の線分と文字に落とす。
 * 画面・SVG・DXF がこの1つの結果を共有するので、3箇所で食い違わない。
 */
export function sheetGeometry(sheet: Sheet, std: DrawingStandard): SheetGeometry {
  const { w, h } = paperDimensions(std);
  const margins = sheet.margins ?? jisMargins(std.paperId);
  const mm = (v: number) => paperToWorld(v, std);

  const paper: Bounds = { min: sheet.origin, max: add(sheet.origin, vec(mm(w), mm(h))) };
  const frame: Bounds = {
    min: add(sheet.origin, vec(mm(margins.binding), mm(margins.bottom))),
    max: add(sheet.origin, vec(mm(w - margins.right), mm(h - margins.top))),
  };

  const rules: Segment[] = [];
  const texts: SheetGeometry['texts'] = [];
  let titleBox: Bounds | null = null;

  if (sheet.titleBlock.enabled) {
    const block = sheet.titleBlock;
    const rows: { label: string; value: string }[] = [
      { label: '図面名称', value: block.fields.drawingName },
      { label: '図面番号', value: block.fields.drawingNumber },
      { label: '企業(団体)名', value: block.fields.company },
      { label: '責任者', value: block.fields.designer },
      { label: '尺度 / 作成年月日', value: `1:${std.scale}   ${block.fields.date}`.trim() },
    ];
    const boxW = mm(Math.min(block.width, w - margins.binding - margins.right));
    const boxH = mm(block.rowHeight) * rows.length;
    // 表題欄は輪郭内の右下
    titleBox = { min: vec(frame.max.x - boxW, frame.min.y), max: vec(frame.max.x, frame.min.y + boxH) };
    rules.push(...rect(titleBox));

    const labelW = mm(40);
    const pad = mm(2);
    for (let i = 0; i < rows.length; i++) {
      // 行は下から積む（最後の行＝尺度が一番下）
      const y = titleBox.min.y + mm(block.rowHeight) * (rows.length - 1 - i);
      const top = y + mm(block.rowHeight);
      if (i > 0) rules.push({ a: vec(titleBox.min.x, top), b: vec(titleBox.max.x, top) });
      rules.push({ a: vec(titleBox.min.x + labelW, y), b: vec(titleBox.min.x + labelW, top) });

      const center = y + mm(block.rowHeight) / 2;
      texts.push({
        text: rows[i].label,
        at: vec(titleBox.min.x + pad, center),
        paperMm: 2.5,
        align: 'left',
        weight: 400,
      });
      if (rows[i].value) {
        texts.push({
          text: rows[i].value,
          at: vec(titleBox.min.x + labelW + pad, center),
          paperMm: i === 0 ? 5 : 3.5,
          align: 'left',
          weight: i === 0 ? 600 : 400,
        });
      }
    }
  }

  return {
    paper,
    frame,
    titleBox,
    paperOutline: rect(paper),
    frameOutline: rect(frame),
    rules,
    texts,
  };
}

export function sheetPrimitives(sheet: Sheet, std: DrawingStandard): Primitive[] {
  const g = sheetGeometry(sheet, std);
  return [
    { kind: 'segments', segments: [...g.frameOutline, ...g.rules] },
    ...g.texts.map(
      (t): Primitive => ({
        kind: 'text',
        text: t.text,
        at: t.at,
        paperMm: t.paperMm,
        angle: 0,
        align: t.align,
      }),
    ),
  ];
}

/** 図面の中身が輪郭の中央に来るように、用紙の左下を決める */
export function centerSheetOn(bounds: Bounds | null, sheet: Sheet, std: DrawingStandard): Vec {
  const { w, h } = paperDimensions(std);
  const margins = sheet.margins ?? jisMargins(std.paperId);
  const mm = (v: number) => paperToWorld(v, std);

  // 用紙の左下から見た輪郭の中心
  const frameCenter = vec(mm((margins.binding + w - margins.right) / 2), mm((margins.bottom + h - margins.top) / 2));
  if (!bounds) return vec(-frameCenter.x, -frameCenter.y);

  const contentCenter = vec((bounds.min.x + bounds.max.x) / 2, (bounds.min.y + bounds.max.y) / 2);
  return vec(contentCenter.x - frameCenter.x, contentCenter.y - frameCenter.y);
}

/**
 * 中身が輪郭に収まるか。収まらなければ収まる尺度の候補を返す。
 * 尺度と用紙の設定に意味を与えるのがこの関数の役割。
 */
export function fitsInFrame(
  bounds: Bounds | null,
  sheet: Sheet,
  std: DrawingStandard,
): { fits: boolean; suggestedScale: number | null } {
  if (!bounds) return { fits: true, suggestedScale: null };
  const { w, h } = paperDimensions(std);
  const margins = sheet.margins ?? jisMargins(std.paperId);
  const usableW = w - margins.binding - margins.right;
  const usableH = h - margins.top - margins.bottom;
  const contentW = bounds.max.x - bounds.min.x;
  const contentH = bounds.max.y - bounds.min.y;

  const fitsAt = (scale: number) => contentW <= usableW * scale && contentH <= usableH * scale;
  if (fitsAt(std.scale)) return { fits: true, suggestedScale: null };
  const suggested = PLAN_SCALES.find((s) => s > std.scale && fitsAt(s)) ?? null;
  return { fits: false, suggestedScale: suggested };
}
