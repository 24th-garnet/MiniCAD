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
