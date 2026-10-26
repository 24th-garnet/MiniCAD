import DxfParser, { type IDxf, type IEntity } from 'dxf-parser';
import type { DxfOptions } from '../src/io/dxf.ts';

/**
 * 外部パーサ（`dxf-parser`）をオラクルとして使うための道具。
 *
 * **ファイル名を `*.test.ts` にしない。** `node --test tests/` が拾ってしまう
 * （`stub-context.ts` と同じ理由）。
 *
 * `dxf-parser` を実行時の依存にはしない、という方針は変えない。これは
 * 開発時の依存で、**自前の DXF 実装を自前の思い込みで検証しない**ために置いている。
 */

/**
 * `IEntity` の宣言は実際に入っている欄より狭い。
 *
 * パーサは `radius` も `vertices` も `position` も実際に詰めてくるのに、
 * 型には出てこない。読むだけのオラクルなので、**緩めるのはここ 1 箇所に閉じる**。
 * 各テストで `as any` を散らすと、どこを信用していないのかが分からなくなる。
 */
export type DxfEnt = IEntity & { [key: string]: any };

/**
 * `3DFACE` の頂点。**末尾の空の 1 件を落とす。**
 *
 * `dxf-parser` は正しい 3DFACE（コード 10〜13 / 20〜23 / 30〜33）に対しても
 * 頂点を 5 つ返し、5 つ目は `{}` になる。自前の出力の問題ではないことを、
 * 4 点が全部違う最小の DXF で確かめてある。
 *
 * **オラクル側の癖はオラクルの道具に閉じ込める。** 各テストで
 * `slice(0, 4)` を書くと、なぜ 4 なのかが散らばって分からなくなる。
 */
export function faceVertices(e: DxfEnt): { x: number; y: number; z: number }[] {
  const v = (e.vertices ?? []) as { x?: number; y?: number; z?: number }[];
  return v
    .filter((p) => typeof p.x === 'number' && typeof p.y === 'number')
    .map((p) => ({ x: p.x as number, y: p.y as number, z: p.z ?? 0 }));
}

/** 書き出した DXF を外部パーサで読み戻す。読めなければテストを落とす */
export function parseDxfOracle(dxf: string): IDxf {
  const parsed = new DxfParser().parseSync(dxf);
  if (!parsed) throw new Error('dxf-parser が読めなかった');
  return parsed;
}

/** エンティティ一覧。欄を読むために緩めた型で返す */
export const oracleEntities = (parsed: IDxf): DxfEnt[] => (parsed.entities ?? []) as DxfEnt[];

/** 書き出し、読み戻してエンティティを返す、までの一息 */
export function entitiesOf(dxf: string): DxfEnt[] {
  return oracleEntities(parseDxfOracle(dxf));
}

/** 既定の書き出し設定。テストは変えたい欄だけ渡す */
export const dxfOpts = (over: Partial<DxfOptions> = {}): DxfOptions => ({
  escapeUnicode: false,
  trueDimension: true,
  ...over,
});

/**
 * ヘッダ変数の点。`$EXTMIN` などは型の上では `number | IPoint` なので、
 * 点として読みたいところで 1 回だけ絞る。
 */
export const headerPoint = (parsed: IDxf, name: string): { x: number; y: number } =>
  parsed.header[name] as { x: number; y: number };
