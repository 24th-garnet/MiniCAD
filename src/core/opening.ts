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
  /**
   * 置いたときの枚数。**種別ごとに違う。**
   *
   * 片引き戸は 1 枚、引違いは 2 枚、折戸は 4 枚が普通で、
   * 全部を同じ数で置くと置いた直後の図が間違っている。
   * 枚数を読まない種別でも、結合の判定（`sameOpening`）が枚数を見るので
   * 値は要る。そこは従来どおり 2 を書く。
   */
  defaultLeaves: number;
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

/**
 * 折戸の山の深さ。**戸 1 枚の幅**に対する比。
 *
 * 開口幅に対する比にすると、枚数を増やしたときに山だけが深いままになる。
 * 4 枚のときに開口幅の 1/6 になる値を選んであるので、既定の見た目は変わらない。
 */
const FOLD = 2 / 3;

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
    // 開き戸(〇枚開き)。**種別を増やさずにここで出す**
    usesLeaves: true,
    defaultLeaves: 1,
    primitives: (f, op) => swingRow(f, op.flipX, op.flipY, op.leaves),
  },

  doubleDoor: {
    label: '両開き戸',
    family: 'door',
    defaultWidth: 1600,
    usesFlipX: false,
    usesFlipY: true,
    usesLeaves: true,
    defaultLeaves: 2,
    primitives: (f, op) => swingLeaves(f, 0, op.flipY, op.leaves),
  },

  // 子扉を 1/3、親扉を 2/3 に割る。flipX でどちら側が子かが入れ替わる
  unequalDoor: {
    label: '親子扉',
    family: 'door',
    defaultWidth: 1200,
    usesFlipX: true,
    usesFlipY: true,
    // 親子は 2 枚と決まっている。枚数を選ばせない
    usesLeaves: false,
    defaultLeaves: 2,
    primitives: (f, op) => swingLeaves(f, f.width * (op.flipX ? 0.5 - CHILD : CHILD - 0.5), op.flipY, 2),
  },

  slidingDouble: {
    label: '引違い戸',
    family: 'door',
    defaultWidth: 1650,
    usesFlipX: false,
    usesFlipY: false,
    // 引き戸(〇枚開き)。4 枚建ては召し合わせが 3 本になる
    usesLeaves: true,
    defaultLeaves: 2,
    primitives: (f, op) => {
      const at = openingAt(f);
      return [{
        kind: 'segments',
        segments: [{ a: at(-f.width / 2, 0), b: at(f.width / 2, 0) }, ...meetTicks(f, op.leaves)],
      }];
    },
  },

  // 片引き戸(I)。引き残し側を破線にして、戸がどちらへ引けるかを示す
  slidingSingle: {
    label: '片引き戸',
    family: 'door',
    defaultWidth: 1600,
    usesFlipX: true,
    usesFlipY: false,
    usesLeaves: true,
    defaultLeaves: 1,
    primitives: (f, op) => {
      const at = openingAt(f);
      const s = op.flipX ? -1 : 1;
      const edge = (s * f.width) / 2;
      // 中央の印は**戸の閉まる側の端**で、枚数とは関係なく常に要る。
      // 枚数の分かれ目は実線側（戸そのもの）の中に入る
      return [
        {
          kind: 'segments',
          segments: [{ a: at(0, 0), b: at(edge, 0) }, meetTick(f), ...meetTicks(subFrame(f, 0, edge), op.leaves)],
        },
        { kind: 'segments', segments: [{ a: at(-edge, 0), b: at(0, 0) }], lineType: 'hidden' },
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
    usesLeaves: true,
    defaultLeaves: 1,
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
            // 戸袋に引き込まれた戸の分かれ目。1 枚なら 1 本も出ない
            ...meetTicks(subFrame(f, 0, edge), op.leaves),
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
    // 折れ戸(〇枚開き)。山の数が枚数の半分になる
    usesLeaves: true,
    defaultLeaves: 4,
    primitives: (f, op) => {
      const at = openingAt(f);
      const w = f.width;
      const n = leafCount(op.leaves);
      const d = (w / n) * FOLD * (op.flipY ? -1 : 1);
      // 戸を等分し、折り目を交互に山と谷にする。4 枚なら今までと同じ 2 山
      const points = [];
      for (let i = 0; i <= n; i++) points.push(at(-w / 2 + (w * i) / n, i % 2 === 1 ? d : 0));
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
    defaultLeaves: 2,
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
    defaultLeaves: 2,
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
    defaultLeaves: 2,
    primitives: (f, op) => [{ kind: 'segments', segments: [...sashes(f), ...meetTicks(f, op.leaves)] }],
  },

  /**
   * 丸窓（FIX窓(丸窓)）。**記号そのものが違うので、ここだけは種別が要る。**
   * 符号で分けていた片開き・上げ下げ・FIX とは事情が違う。
   *
   * **穴は丸くならない。** 開口は壁の上の 1 次元区間として持っているので、
   * 3D の抜きも立面図の穴も矩形のまま。平面図だけが丸い。
   * 丸い穴にするには `wallSpans` と `extrudeWall` が区間ではなく
   * 形を受け取る造りに変わる。
   */
  windowRound: {
    label: '丸窓',
    family: 'window',
    defaultWidth: 600,
    usesFlipX: false,
    usesFlipY: false,
    usesLeaves: false,
    defaultLeaves: 2,
    primitives: (f) => [{ kind: 'circle', center: f.center, radius: f.width / 2 }],
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
  // 丸窓は高さと幅が同じ。**既定の高さは直径ではなく既定幅に合わせる**
  // （幅を変えたときに縦横が食い違うが、縦は 3D の矩形の穴にしか効かない）
  windowRound: { sillHeight: 1200, height: 600 },
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

/** 枚数を 1 以上の整数に丸める。読み込み側でも丸めているが、計算の前でもう一度 */
const leafCount = (leaves: number): number => Math.max(1, Math.round(leaves));

/**
 * 片開き戸を枚数ぶん横に並べる。**吊元はすべて同じ側。**
 *
 * 突き合わせの両開き（`swingLeaves`）が「両端から中へ」なのに対し、
 * こちらは「片側から順に」。1 枚なら開口いっぱいの片開き戸そのもので、
 * 今までの図と 1 本も変わらない。
 */
function swingRow(frame: OpeningFrame, flipX: boolean, flipY: boolean, leaves: number): Primitive[] {
  const n = leafCount(leaves);
  if (n < 2) return swing(frame, flipX, flipY);
  const half = frame.width / 2;
  const out: Primitive[] = [];
  for (let i = 0; i < n; i++) {
    const u0 = -half + (frame.width * i) / n;
    out.push(...swing(subFrame(frame, u0, u0 + frame.width / n), flipX, flipY));
  }
  return out;
}

/**
 * 突き合わせの戸（両開き・親子）。`meet` は突き合わせ位置（開口の中心が 0）。
 * 左右それぞれを `swingRow` に流すので、90 度という不変条件も
 * 円弧の向きの約束も自動的に守られる。
 *
 * 枚数は**幅の比で左右に割る**。両開き 4 枚なら 2 枚ずつ、
 * 親子は 2 枚固定なので今までどおり 1 枚ずつになる。
 */
function swingLeaves(frame: OpeningFrame, meet: number, flipY: boolean, leaves: number): Primitive[] {
  const n = leafCount(leaves);
  const half = frame.width / 2;
  if (n < 2) return swing(frame, false, flipY);
  const left = Math.min(n - 1, Math.max(1, Math.round((n * (meet + half)) / frame.width)));
  return [
    ...swingRow(subFrame(frame, -half, meet), false, flipY, left),
    ...swingRow(subFrame(frame, meet, half), true, flipY, n - left),
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

/**
 * 建具の同一性。**位置と幅以外のすべて。**
 *
 * 結合（`mergeOpeningSpan`）が「融かしてよいか」を決めるのに使う。
 * 融かした結果は `Opening` 1 つなので、**食い違う欄はどれも失われる**。
 * 位置と幅だけが、融かすことで正当に変わる欄。
 */
export type OpeningIdentity = Omit<Opening, 'id' | 'wallId' | 'offset' | 'width'>;

/**
 * 欄ごとの「同じか」。**`Opening` に欄を足すとここが型エラーになる。**
 *
 * 表にしてあるのは、足した人に「融かしてよい欄か」を必ず考えさせるため。
 * 以前はこの判定が `kind` の比較 1 行で、掃き出し窓と腰窓を隣に置くと
 * **黙って融けて窓台と符号が消えた**。
 */
const SAME_FIELD: { [K in keyof OpeningIdentity]: (a: OpeningIdentity[K], b: OpeningIdentity[K]) => boolean } = {
  kind: (a, b) => a === b,
  flipX: (a, b) => a === b,
  flipY: (a, b) => a === b,
  sillHeight: (a, b) => a === b,
  height: (a, b) => a === b,
  designation: (a, b) => a === b,
  leaves: (a, b) => a === b,
  layerId: (a, b) => a === b,
  bay: (a, b) =>
    a === null || b === null
      ? a === b
      : a.shape === b.shape && a.depth === b.depth && a.side === b.side,
  attrs: (a, b) =>
    a.materialRef === b.materialRef &&
    a.takeoff === b.takeoff &&
    a.color === b.color &&
    a.groupId === b.groupId &&
      a.stampId === b.stampId &&
    a.symbolId === b.symbolId &&
    a.symbolVersion === b.symbolVersion,
};

/** 融かしてよい相手か。欄が 1 つでも食い違えば融かさない */
export function sameOpening(a: OpeningIdentity, b: OpeningIdentity): boolean {
  for (const key of Object.keys(SAME_FIELD) as (keyof OpeningIdentity)[]) {
    // 欄ごとに型が違うので、表引きの 1 箇所だけ緩める
    const eq = SAME_FIELD[key] as (x: unknown, y: unknown) => boolean;
    if (!eq(a[key], b[key])) return false;
  }
  return true;
}

/** 種別セレクタ用。ツールの系統で絞り込む */
export const openingKindsOf = (family: 'door' | 'window'): OpeningKind[] =>
  OPENING_KINDS.filter((k) => OPENING_SYMBOLS[k].family === family);
