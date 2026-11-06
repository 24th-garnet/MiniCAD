import { BlockInsertTool } from '../tools/block-insert.ts';
import { AssemblyTool } from '../tools/assembly.ts';
import { CommentTool } from '../tools/comment.ts';
import { DimensionTool } from '../tools/dimension.ts';
import { FixtureTool } from '../tools/fixture.ts';
import { MeasureTool } from '../tools/measure.ts';
import { ModifyTool } from '../tools/modify.ts';
import { CornerTool } from '../tools/corner.ts';
import { VertexTool } from '../tools/vertex.ts';
import { ArrayCopyTool } from '../tools/array-copy.ts';
import { EyedropperTool } from '../tools/eyedropper.ts';
import { OpeningTool } from '../tools/opening.ts';
import { RoomTool } from '../tools/room.ts';
import { SelectTool } from '../tools/select.ts';
import { ShapeTool } from '../tools/shape.ts';
import type { Tool, ToolId } from '../tools/tool.ts';
import { TransformTool } from '../tools/transform.ts';
import { WallTool } from '../tools/wall.ts';
import type { Capabilities } from '../host.ts';
import { BOTH_MODES, PRO_ONLY, type Mode } from './mode.ts';

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
  /**
   * ツールを 1 つ作る。
   *
   * **モードを受け取るのは、同じ道具でも出す種類が変わるものがあるため**
   * （作図と角）。実行時にモードを読む仕組みは要らない——`App.setMode` が
   * `setTools` でツールを作り直すので、組み立て時に決まっていれば足りる。
   * `Tool` に `Mode` を持たせると、どこで分岐しているか追えなくなる。
   */
  make(mode: Mode): Tool;
  /** ツールバーのアイコン */
  glyph: string;
  /** どのモードで出すか */
  modes: readonly Mode[];
  /** 図面を書き換えるツールか。閲覧のみのときは出さない */
  edits: boolean;
  /**
   * `edit` 以外に要る権限。いまはコメントだけ。
   *
   * `edits` が `can.edit` を表しているのと同じ形。`keyof Capabilities` に
   * 一般化すると `edits` を書き換えることになるので、要るものだけ足す
   */
  needs?: 'comment';
}

export const TOOL_REGISTRY: Record<ToolId, ToolEntry> = {
  select: { make: () => new SelectTool(), glyph: '↖', modes: BOTH_MODES, edits: false },
  // 計測は Phase 5 から図面に残るので、閲覧のみでは出さない。
  // 出すと `Store.readOnly` に弾かれて、測っても何も残らない
  measure: { make: () => new MeasureTool(), glyph: '↔', modes: BOTH_MODES, edits: true },
  copy: { make: () => new TransformTool('copy', 'copy', '複写', 'Y'), glyph: '⧉', modes: BOTH_MODES, edits: true },
  rotate: { make: () => new TransformTool('rotate', 'rotate', '回転', 'R'), glyph: '↻', modes: BOTH_MODES, edits: true },
  mirror: { make: () => new TransformTool('mirror', 'mirror', '鏡像', 'X'), glyph: '⇄', modes: BOTH_MODES, edits: true },
  offset: { make: () => new ModifyTool('offset', 'offset', 'オフセット', 'O'), glyph: '⫽', modes: PRO_ONLY, edits: true },
  trim: { make: () => new ModifyTool('trim', 'trim', 'トリム', 'U'), glyph: '✂', modes: PRO_ONLY, edits: true },
  extend: { make: () => new ModifyTool('extend', 'extend', '延長', 'E'), glyph: '⇥', modes: PRO_ONLY, edits: true },
  // 分割と消しゴムは「1 つの対象を切る」で同じなので、1 ツールにまとめた。
  // ショートカットの文字が足りず、変形に 1 つ空ける必要もあった
  split: {
    make: () => new ModifyTool(['split', 'erase'], 'split', '切断', 'P'),
    glyph: '⨉', modes: PRO_ONLY, edits: true,
  },
  /**
   * 角と結合。**結合だけは通常モードにも出す。**
   *
   * ワイヤー 7 枚目が「例）壁、円弧壁、**壁結合**などは、**通常モードを
   * 利用する前提**」と書いている。角の丸めと面取りは 7 枚目（プロの 2D）に
   * しか無いので、プロだけ。通常モードでは名前も「結合」にする——
   * 「角」という名前で結合しかしない道具は嘘になる。
   */
  corner: {
    make: (mode) =>
      mode === 'pro'
        ? new CornerTool(['fillet', 'chamfer', 'join'], '角')
        : new CornerTool(['join'], '結合'),
    glyph: '◝', modes: BOTH_MODES, edits: true,
  },
  vertex: { make: () => new VertexTool(), glyph: '◆', modes: PRO_ONLY, edits: true },
  // 3D のソリッドとは無関係。2D でも 3D でも同じものが動く
  array: { make: () => new ArrayCopyTool(), glyph: '⠿', modes: PRO_ONLY, edits: true },
  /** スポイト。**キーを持たない**——A〜Z に空きが 1 つも無い */
  eyedrop: { make: () => new EyedropperTool(), glyph: '⬩', modes: PRO_ONLY, edits: true },
  wall: { make: () => new WallTool(), glyph: '▬', modes: BOTH_MODES, edits: true },
  // **構造は建具より上に並べる**（ワイヤーの奥谷さんの指摘）。
  // 躯体を決めてから建具を入れるのが実際の手順
  fixture: { make: () => new FixtureTool('structure', 'fixture', '構造', 'K'), glyph: '◫', modes: BOTH_MODES, edits: true },
  /**
   * 汎用ソリッド。**キーを持たない。** A〜Z が埋まっていて、しかも配列複写と同じく
   * 「種類を選んで置く」操作なので、指の記憶で呼ぶものではない
   */
  solid: { make: () => new FixtureTool('solid', 'solid', 'ソリッド', ''), glyph: '◧', modes: PRO_ONLY, edits: true },
  door: { make: () => new OpeningTool('door', 'door', 'ドア', 'D'), glyph: '⌒', modes: BOTH_MODES, edits: true },
  window: { make: () => new OpeningTool('window', 'window', '窓', 'S'), glyph: '▤', modes: BOTH_MODES, edits: true },
  block: { make: () => new BlockInsertTool(), glyph: '▦', modes: BOTH_MODES, edits: true },
  // シンボルは置いた瞬間に実体へ展開される（スタンプ）
  assembly: { make: () => new AssemblyTool(), glyph: '⊞', modes: BOTH_MODES, edits: true },
  line: { make: () => new ShapeTool('line', 'line', '線', 'L'), glyph: '／', modes: BOTH_MODES, edits: true },
  /**
   * 作図。**1 種別 1 ツールにするとツールバーが破綻する**ので、建具と同じく
   * 「種類」セレクタで切り替える。
   *
   * **出す種類はモードで変わる。** ワイヤー 8 枚目（通常モードの 2D）の
   * 「ペイント」は **直線 / 矩形 / 曲線 / 外部領域** の 4 つだけで、
   * 長い作図一覧は 7 枚目（プロの 2D）にしかない。直線は `line` ツールが
   * 受け持つので、ここに出すのは矩形と曲線。
   */
  shape: {
    make: (mode) =>
      new ShapeTool(mode === 'pro' ? PRO_SHAPES : PAINT_SHAPES, 'shape', '作図', 'F'),
    glyph: '▭', modes: BOTH_MODES, edits: true,
  },
  arc: { make: () => new ShapeTool('arc', 'arc', '円・弧', 'C'), glyph: '○', modes: BOTH_MODES, edits: true },
  point: { make: () => new ShapeTool('point', 'point', '点', 'Q'), glyph: '・', modes: PRO_ONLY, edits: true },
  text: { make: () => new ShapeTool('text', 'text', '文字', 'T'), glyph: 'A', modes: BOTH_MODES, edits: true },
  dimension: { make: () => new DimensionTool(), glyph: '↦', modes: BOTH_MODES, edits: true },
  room: { make: () => new RoomTool(), glyph: 'あ', modes: BOTH_MODES, edits: true },
  // **コメントは図面を変えない。** 閲覧のみでも置ける（権限は `comment` が決める）
  comment: { make: () => new CommentTool(), glyph: '💬', modes: BOTH_MODES, edits: false, needs: 'comment' },
};

/** ワイヤー 8 枚目「ペイント」のうち、作図ツールが受け持つもの（直線は `line`） */
const PAINT_SHAPES = ['rect', 'spline'] as const;

/** ワイヤー 7 枚目（プロの 2D）の作図一覧 */
const PRO_SHAPES = [
  'rect', 'roundRect', 'ngon', 'ellipse', 'spline', 'doubleLine', 'leader',
] as const;

/** そのモードとできることで出すツールを順に作る。並びは表のキーの順 */
export function buildTools(mode: Mode, can: Capabilities): Tool[] {
  return Object.values(TOOL_REGISTRY)
    .filter((entry) => entry.modes.includes(mode))
    .filter((entry) => can.edit || !entry.edits)
    .filter((entry) => !entry.needs || can[entry.needs])
    .map((entry) => entry.make(mode));
}
