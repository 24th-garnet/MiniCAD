import { BlockInsertTool } from '../tools/block-insert.ts';
import { DimensionTool } from '../tools/dimension.ts';
import { MeasureTool } from '../tools/measure.ts';
import { ModifyTool } from '../tools/modify.ts';
import { OpeningTool } from '../tools/opening.ts';
import { RoomTool } from '../tools/room.ts';
import { SelectTool } from '../tools/select.ts';
import { ShapeTool } from '../tools/shape.ts';
import type { Tool, ToolId } from '../tools/tool.ts';
import { TransformTool } from '../tools/transform.ts';
import { WallTool } from '../tools/wall.ts';

/**
 * 何のツールを出すかの表。
 *
 * **`App` のコンストラクタに直書きしてあった配列をここへ移した。**
 * 移す前は「ツールを 1 つ隠す」を書く場所が無く、`App` の中で条件を
 * 組み立てるしかなかった。表にすれば、出し入れの判断は表の 1 欄で済む。
 *
 * **`ToolId` は閉じた union のままにする。** 表を `Record<ToolId, …>` に
 * しておけば、種別を足して登録を忘れたときに `npm run typecheck` が止まる。
 * この codebase が安全でいられる仕掛けを、レジストリに変えたせいで失わない。
 *
 * **並び順は表のキーの順。** JavaScript のオブジェクトは数字でないキーの
 * 挿入順を保つと仕様で決まっていて、`Object.values` もその順で返す。
 * 別に順序の配列を持つと、表と二重管理になってずれる。
 *
 * **区画の表（`section-registry.ts`）とファイルを分けてある。** あちらは
 * インスペクタの区画を読み込み、その 1 つがコンストラクタ引数のプロパティ宣言を
 * 使っている。`npm test` の `node --experimental-strip-types` はそれを
 * 展開できないので、同じファイルに置くとツールの表までテストから読めなくなる。
 */

/** ツール 1 つぶんの記述。グリフもここに置く（表を 2 枚にしないため） */
export interface ToolEntry {
  make(): Tool;
  /** ツールバーのアイコン */
  glyph: string;
}

export const TOOL_REGISTRY: Record<ToolId, ToolEntry> = {
  select: { make: () => new SelectTool(), glyph: '↖' },
  measure: { make: () => new MeasureTool(), glyph: '↔' },
  copy: { make: () => new TransformTool('copy', 'copy', '複写', 'Y'), glyph: '⧉' },
  rotate: { make: () => new TransformTool('rotate', 'rotate', '回転', 'R'), glyph: '↻' },
  mirror: { make: () => new TransformTool('mirror', 'mirror', '鏡像', 'X'), glyph: '⇄' },
  offset: { make: () => new ModifyTool('offset', 'offset', 'オフセット', 'O'), glyph: '⫽' },
  trim: { make: () => new ModifyTool('trim', 'trim', 'トリム', 'U'), glyph: '✂' },
  extend: { make: () => new ModifyTool('extend', 'extend', '延長', 'E'), glyph: '⇥' },
  wall: { make: () => new WallTool(), glyph: '▬' },
  door: { make: () => new OpeningTool('door', 'door', 'ドア', 'D'), glyph: '⌒' },
  window: { make: () => new OpeningTool('window', 'window', '窓', 'S'), glyph: '▤' },
  block: { make: () => new BlockInsertTool(), glyph: '▦' },
  line: { make: () => new ShapeTool('line', 'line', '線', 'L'), glyph: '／' },
  arc: { make: () => new ShapeTool('arc', 'arc', '円・弧', 'C'), glyph: '○' },
  point: { make: () => new ShapeTool('point', 'point', '点', 'Q'), glyph: '・' },
  text: { make: () => new ShapeTool('text', 'text', '文字', 'T'), glyph: 'A' },
  dimension: { make: () => new DimensionTool(), glyph: '↦' },
  room: { make: () => new RoomTool(), glyph: 'あ' },
};

/** 出すツールを順に作る。並びは表のキーの順 */
export function buildTools(): Tool[] {
  return Object.values(TOOL_REGISTRY).map((entry) => entry.make());
}
