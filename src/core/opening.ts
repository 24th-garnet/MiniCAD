import { angleOf, sub } from './geometry.ts';
import type { Primitive } from './primitive.ts';
import { doorSwing, openingAt, openingFrame, subFrame, type OpeningFrame, type Segment } from './shape.ts';
import { nonNegativeOr, positiveOr, type Level } from './level.ts';
import type { Opening, OpeningKind, Scene } from './types.ts';
import { OPENING_KINDS } from './types.ts';

/**
 * 建具の平面表示記号。JIS A 0150 の別表「平面表示記号」に倣う。
 *
 * `Record<OpeningKind, …>` で持つので、`OPENING_KINDS`（types.ts）に種別を足すと
 * **ここだけが型エラーになる**。以前は renderer / svg / dxf / インスペクタ / 読み込みの
 * 5 箇所に同じ分岐が散らばっていて、どれも足し忘れても型エラーが出なかった。
 *
 * 記号はブロック（INSERT）ではなく関数で組む。召し合わせの印や戸袋の見切りは
 * 開口幅に依存しない一方、障子線の長さだけが幅に比例するので、
 * 2 軸の尺度しか持たない INSERT では表せないため。
 * 円弧を含む記号は非一様尺度で楕円になってしまう、という事情もある。
 */
export interface OpeningSymbol {
  label: string;
  /** どちらのツールから置けるか */
  family: 'door' | 'window';
  defaultWidth: number;
  /** 吊元・引き勝手の反転（X キー）が意味を持つか */
  usesFlipX: boolean;
  /** 開き勝手の反転（Y キー）が意味を持つか */
  usesFlipY: boolean;
  /**
   * 枚数で記号が変わるか。
   *
   * **変わらない種別で欄を出さない**ための札。片開き戸に「枚数」を出すと、
   * 直しても図面が変わらない欄が残り、使う側が何かが壊れたと思う。
   */
  usesLeaves: boolean;
  primitives(frame: OpeningFrame, opening: Opening): Primitive[];
}

/**
 * 窓の障子線を置く位置。壁厚に対する比。
 * 引戸の障子線は壁芯の上（v = 0）に 1 本引く、というのが規格の描き方で、
 * 2 本に分かれるのは窓だけ。
 */
const LANE = 0.25;

/**
 * 召し合わせ（戸が重なる位置）の印の長さ。壁厚に対する比で、開口幅に依存しない。
 * 窓の障子線（±LANE）より外まで伸ばさないと、引違い窓で印が埋もれて見えない。
 */
const TICK = 0.45;

/** 戸袋の見付け。壁厚に対する比 */
const POCKET = 0.3;

/** 折戸の山の深さ。開口幅に対する比 */
const FOLD = 1 / 6;

/** 親子扉の子扉が占める割合 */
const CHILD = 1 / 3;

/** 建具符号を壁芯から逃がす距離。壁厚に対する比 */
const DESIGNATION_OFFSET = 1.1;

export const OPENING_SYMBOLS: Record<OpeningKind, OpeningSymbol> = {
  door: {
    label: '片開き戸',
    family: 'door',
    defaultWidth: 800,
    usesFlipX: true,
    usesFlipY: true,
    usesLeaves: false,
    primitives: (f, op) => swing(f, op.flipX, op.flipY),
  },

  doubleDoor: {
    label: '両開き戸',
    family: 'door',
    defaultWidth: 1600,
    usesFlipX: false,
    usesFlipY: true,
    usesLeaves: false,
    primitives: (f, op) => leaves(f, 0, op.flipY),
  },

  // 子扉を 1/3、親扉を 2/3 に割る。flipX でどちら側が子かが入れ替わる
  unequalDoor: {
    label: '親子扉',
    family: 'door',
    defaultWidth: 1200,
    usesFlipX: true,
    usesFlipY: true,
    usesLeaves: false,
    primitives: (f, op) => leaves(f, f.width * (op.flipX ? 0.5 - CHILD : CHILD - 0.5), op.flipY),
  },

  slidingDouble: {
    label: '引違い戸',
    family: 'door',
    defaultWidth: 1650,
    usesFlipX: false,
    usesFlipY: false,
    usesLeaves: false,
    primitives: (f) => {
      const at = openingAt(f);
      return [{ kind: 'segments', segments: [{ a: at(-f.width / 2, 0), b: at(f.width / 2, 0) }, meetTick(f)] }];
    },
  },

  // 片引き戸(I)。引き残し側を破線にして、戸がどちらへ引けるかを示す
  slidingSingle: {
    label: '片引き戸',
    family: 'door',
    defaultWidth: 1600,
    usesFlipX: true,
    usesFlipY: false,
    usesLeaves: false,
    primitives: (f, op) => {
      const at = openingAt(f);
      const s = op.flipX ? -1 : 1;
      return [
        { kind: 'segments', segments: [{ a: at(0, 0), b: at((s * f.width) / 2, 0) }, meetTick(f)] },
        { kind: 'segments', segments: [{ a: at((-s * f.width) / 2, 0), b: at(0, 0) }], lineType: 'hidden' },
      ];
    },
  },

  // 引込戸。戸袋を壁の中に箱で描き、引き込まれた戸を破線で入れる
  slidingPocket: {
    label: '引込み戸',
    family: 'door',
    defaultWidth: 1600,
    usesFlipX: true,
    usesFlipY: false,
    usesLeaves: false,
    primitives: (f, op) => {
      const at = openingAt(f);
      const s = op.flipX ? -1 : 1;
      const edge = (s * f.width) / 2;
      const p = f.thickness * POCKET;
      return [
        {
          kind: 'segments',
          segments: [
            { a: at(-edge, 0), b: at(0, 0) },
            { a: at(0, p), b: at(edge, p) },
            { a: at(0, -p), b: at(edge, -p) },
            { a: at(edge, p), b: at(edge, -p) },
          ],
        },
        { kind: 'segments', segments: [{ a: at(0, 0), b: at(edge, 0) }], lineType: 'hidden' },
      ];
    },
  },

  folding: {
    label: '折戸',
    family: 'door',
    defaultWidth: 1200,
    usesFlipX: false,
    usesFlipY: true,
    usesLeaves: false,
    primitives: (f, op) => {
      const at = openingAt(f);
      const w = f.width;
      const d = w * FOLD * (op.flipY ? -1 : 1);
      const points = [at(-w / 2, 0), at(-w / 4, d), at(0, 0), at(w / 4, d), at(w / 2, 0)];
      return [{ kind: 'segments', segments: chain(points) }];
    },
  },

  // 出入口一般。建具の種類を決めないときの記号で、召し合わせの印だけを置く
  opening: {
    label: '出入口（建具なし）',
    family: 'door',
    defaultWidth: 900,
    usesFlipX: false,
    usesFlipY: false,
    usesLeaves: false,
    primitives: (f) => [{ kind: 'segments', segments: [meetTick(f)] }],
  },

  // はめごろし・上げ下げ・すべり出し・回転なども平面では同じ記号になる（規格どおり）
  window: {
    label: '窓',
    family: 'window',
    defaultWidth: 1700,
    usesFlipX: false,
    usesFlipY: false,
    usesLeaves: false,
    primitives: (f) => [{ kind: 'segments', segments: sashes(f) }],
  },

  windowSliding: {
    label: '引違い窓',
    family: 'window',
    defaultWidth: 1700,
    usesFlipX: false,
    usesFlipY: false,
    // 4 枚建てはここで出す。**種別を増やさない**
    usesLeaves: true,
    primitives: (f, op) => [{ kind: 'segments', segments: [...sashes(f), ...meetTicks(f, op.leaves)] }],
  },
};

/**
 * 建具の縦方向の寸法。床 (FL) からの高さ (mm)。
 *
 * `OPENING_SYMBOLS` と同じく `Record<OpeningKind, …>` なので、
 * `OPENING_KINDS` に種別を足すとこの表も型エラーになる。
 * 平面の記号と縦方向の寸法を1つのファイルに置いておけば、
 * 種別を足すときに見る場所が1箇所で済む。
 */
export interface OpeningProfile {
  /** 床から開口下端（窓台） */
  sillHeight: number;
  /** 開口の高さ。頭（まぐさの下端）は sillHeight + height */
  height: number;
}

export const OPENING_PROFILES: Record<OpeningKind, OpeningProfile> = {
  // 戸はすべて床から。既製内部建具の枠内法高さは 2000 が最頻
  door: { sillHeight: 0, height: 2000 },
  doubleDoor: { sillHeight: 0, height: 2000 },
  unequalDoor: { sillHeight: 0, height: 2000 },
  slidingDouble: { sillHeight: 0, height: 2000 },
  slidingSingle: { sillHeight: 0, height: 2000 },
  slidingPocket: { sillHeight: 0, height: 2000 },
  folding: { sillHeight: 0, height: 2000 },
  opening: { sillHeight: 0, height: 2000 },
  // 腰窓。窓台 800 は FL から下枠までの標準で、高さ 1100 は引違いサッシの一般的な寸法。
  // 頭が 1900 になり、建具の頭 2000 の下に収まってまぐさの見え方が自然になる。
  // 掃き出し窓は種別を足さず、その開口の sillHeight を 0 に上書きして表す
  window: { sillHeight: 800, height: 1100 },
  windowSliding: { sillHeight: 800, height: 1100 },
};

/**
 * 開口の上端と下端 (mm)。開口ごとの上書きがあればそれを使う。
 * 負値や NaN は既定に落とす（`deserialize` を通らない手書き JSON への保険）。
 */
export function openingVertical(opening: Opening, level: Level): { sill: number; head: number } {
  const profile = OPENING_PROFILES[opening.kind];
  const sill = nonNegativeOr(opening.sillHeight, profile.sillHeight);
  const height = positiveOr(opening.height, profile.height);
  return { sill: level.floorZ + sill, head: level.floorZ + sill + height };
}

/**
 * 片開きの戸と、その開き軌跡。
 *
 * 円弧の向きの約束（ワールドは y 上向き・`Primitive.arc` は start から end へ反時計回り）を
 * **この 1 箇所**に閉じ込める。以前は 3 つのバックエンドが各自で変換していて、
 * 取り違えによってドアの軌跡が 270 度になるバグを出したことがある。
 */
function swing(frame: OpeningFrame, flipX: boolean, flipY: boolean): Primitive[] {
  const s = doorSwing(frame, flipX, flipY);
  const openAngle = angleOf(sub(s.open, s.hinge));
  const closedAngle = angleOf(sub(s.closed, s.hinge));
  const [startAngle, endAngle] = s.ccwFromOpenToClosed ? [openAngle, closedAngle] : [closedAngle, openAngle];
  return [
    { kind: 'segments', segments: [{ a: s.hinge, b: s.open }] },
    { kind: 'arc', center: s.hinge, radius: s.radius, startAngle, endAngle },
  ];
}

/**
 * 突き合わせの 2 枚戸（両開き・親子）。`meet` は突き合わせ位置（開口の中心が 0）。
 * 左右それぞれを 1 枚の片開き戸として `swing` に流すので、
 * 90 度という不変条件も円弧の向きの約束も自動的に守られる。
 */
function leaves(frame: OpeningFrame, meet: number, flipY: boolean): Primitive[] {
  const half = frame.width / 2;
  return [
    ...swing(subFrame(frame, -half, meet), false, flipY),
    ...swing(subFrame(frame, meet, half), true, flipY),
  ];
}

/** 召し合わせの印。壁芯を横切る短い線 */
function meetTick(frame: OpeningFrame): Segment {
  const at = openingAt(frame);
  const t = frame.thickness * TICK;
  return { a: at(0, t), b: at(0, -t) };
}

/** 窓の障子線。壁厚の中に 2 本 */
function sashes(frame: OpeningFrame): Segment[] {
  const at = openingAt(frame);
  const t = frame.thickness * LANE;
  const half = frame.width / 2;
  return [
    { a: at(-half, t), b: at(half, t) },
    { a: at(-half, -t), b: at(half, -t) },
  ];
}

/**
 * 召し合わせの印を枚数ぶん。**2 枚なら真ん中に 1 本**で、今までと同じ。
 *
 * 戸は等分に並ぶものとし、内側の分かれ目（枚数 − 1 箇所）に印を置く。
 * 4 枚建ての引違い窓のために種別を増やさずに済ませるための一般化。
 */
function meetTicks(frame: OpeningFrame, leaves: number): Segment[] {
  const n = Math.max(1, Math.round(leaves));
  if (n < 2) return [];
  const at = openingAt(frame);
  const t = frame.thickness * TICK;
  const half = frame.width / 2;
  const out: Segment[] = [];
  for (let i = 1; i < n; i++) {
    const along = -half + (frame.width * i) / n;
    out.push({ a: at(along, t), b: at(along, -t) });
  }
  return out;
}

const chain = (points: { x: number; y: number }[]): Segment[] =>
  points.slice(0, -1).map((a, i) => ({ a, b: points[i + 1] }));

/** 画面・SVG・DXF が共通で呼ぶ入口 */
export function openingPrimitives(scene: Scene, opening: Opening): Primitive[] {
  const frame = openingFrame(scene, opening);
  if (!frame) return [];
  const out = OPENING_SYMBOLS[opening.kind].primitives(frame, opening);
  // **符号は図面に出す。** 持っているのに出さないと、インスペクタを開かないと
  // 分からない情報になり、紙に落ちた瞬間に消える
  if (opening.designation.length > 0) {
    const at = openingAt(frame);
    out.push({
      kind: 'text',
      text: opening.designation,
      // 壁の外側へ少し逃がす。障子線や召し合わせと重ならない位置
      at: at(0, frame.thickness * DESIGNATION_OFFSET),
      paperMm: scene.standard.textHeight.dimension,
      angle: angleOf(frame.dir),
      align: 'center',
    });
  }
  return out;
}

/** 種別セレクタ用。ツールの系統で絞り込む */
export const openingKindsOf = (family: 'door' | 'window'): OpeningKind[] =>
  OPENING_KINDS.filter((k) => OPENING_SYMBOLS[k].family === family);
