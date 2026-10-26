import type { Id, Scene, Wall } from './types.ts';

/**
 * 階。縦方向の設定と、実体がどこに乗っているかの宛先。
 *
 * `DrawingStandard`（線群・尺度・文字高・用紙）は**紙の属性**で、尺度を変えれば
 * 見え方が変わるもの。階高は**建物の属性**で、尺度とは無関係に決まる。
 * `Sheet` が `DrawingStandard` と分かれているのと同じ理由で、ここも独立させる。
 *
 * **階は実体を持たず、実体が階を指す。** 階ごとにテーブルを分ける
 * （`floors[].walls` のような形）設計も採れるが、そうすると `scene.walls` を
 * 読んでいる全箇所が二段の走査になる。実体に `levelId` を持たせれば、
 * 階をまたいで見たいところは今のままで、絞りたいところだけ絞れる。
 *
 * **階を跨いでノードを融合させない。** `findOrCreateNode` と `mergeNodesAt` は
 * 距離だけでノードを同一視するので、階を見ないと 1 階と 2 階の同じ座標の角が
 * 1 つに溶ける。どちらも階で絞る。
 */
export interface Level {
  id: Id;
  /** 表示名。「1階」「B1」など。DXF には出ない */
  name: string;
  /** 床の高さ (mm)。階の並び順はこの値で決まる */
  floorZ: number;
  /** 壁の既定の高さ (mm)。個々の壁が上書きできる */
  wallHeight: number;
}

/** 最初の階の id。**固定の値**なので、古いファイルの移行先が一意に決まる */
export const DEFAULT_LEVEL_ID = 'lv-1';

export const defaultLevel = (): Level => ({
  id: DEFAULT_LEVEL_ID,
  name: '1階',
  floorZ: 0,
  wallHeight: 2400,
});

export const defaultLevels = (): Record<Id, Level> => ({
  [DEFAULT_LEVEL_ID]: defaultLevel(),
});

/**
 * 階を引く。**知らない id でも既定の階に落とす。**
 *
 * `getLayer` と同じ作法。階が消えた図面を読んだときに、実体が宙に浮くより
 * どこかの階に乗っているほうが直しようがある。
 */
export function levelOf(scene: Scene, id: Id): Level {
  return scene.levels[id] ?? scene.levels[scene.activeLevelId] ?? defaultLevel();
}

/** 作業中の階 */
export const activeLevel = (scene: Scene): Level => levelOf(scene, scene.activeLevelId);

/** 下から順。同じ高さなら名前順で安定させる */
export function levelsInOrder(scene: Scene): Level[] {
  return Object.values(scene.levels).sort(
    (a, b) => a.floorZ - b.floorZ || a.name.localeCompare(b.name),
  );
}

export const wallHeightOf = (wall: Wall, level: Level): number =>
  positiveOr(wall.height, level.wallHeight);

/** 上書きが有効な数値ならそれを、そうでなければ既定を返す */
export const positiveOr = (value: number | null | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/** 0 以上なら上書きを採る（窓台の高さは 0 が正当なので別扱い） */
export const nonNegativeOr = (value: number | null | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
