export type Id = string;

let counter = 0;

/**
 * エンティティの ID を作る。
 * prefix はただのラベルで、型の判別には使わない（所属するテーブルが種別を決める）。
 *
 * 画層もエンティティもこれを使うので、どちらにも依存しない独立したモジュールにしてある。
 * （types.ts に置くと layer.ts との間で循環参照になる）
 */
export function newId(prefix: string): Id {
  counter += 1;
  return `${prefix}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
