export type Id = string;

/**
 * エンティティの ID を作る。
 * prefix はただのラベルで、型の判別には使わない（所属するテーブルが種別を決める）。
 *
 * 画層もエンティティもこれを使うので、どちらにも依存しない独立したモジュールにしてある。
 * （types.ts に置くと layer.ts との間で循環参照になる）
 *
 * **別々のブラウザで作った ID がぶつからないこと**が要件。以前は
 * 「モジュール内のカウンタ＋`Math.random` 4 桁」だったが、カウンタは再読み込みで
 * 0 に戻り、乱数部は 36^4 ≈ 167 万しかない。同じ図面を 2 人が開いて別々に描き、
 * ホストが突き合わせる場面で**実際にぶつかる**。選択も仕上げもコメントも ID に
 * 付くので、ぶつかると**選んだ壁紙が黙って別の壁に移る**。
 *
 * **`crypto.randomUUID()` は使わない。** 36 文字あり、ID は参照されるたびに
 * ファイルへ書かれる（`wall.a`・`opening.wallId`・`constraint.walls`・寸法の
 * `nodeId` …）。サンプル間取りで 6KB ほど増え、JSON を目で追うのも辛くなる。
 * 要るのは**衝突しないこと**で、UUID という形式そのものではない。
 *
 * 代わりに**暗号用の乱数から 36 進 12 桁**を取る。36^12 ≈ 4.7×10^18 なので、
 * 1 つの図面に 1 万個の ID を作っても衝突の確率は 10^-11 の桁。
 */

/** 乱数部の桁数。36^12 ≈ 4.7e18 */
const RANDOM_LENGTH = 12;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * 36 進 1 桁を偏りなく取るための上限。
 *
 * 256 は 36 で割り切れないので、`byte % 36` にすると 0〜3 だけ他より出やすくなる。
 * 252（36×7）以上は捨てて引き直す。
 */
const UNBIASED_LIMIT = 252;

/** 乱数の出どころ。暗号用が無ければ `Math.random` に落ちる */
function randomBytes(out: Uint8Array): Uint8Array {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') return c.getRandomValues(out);
  // 暗号用の乱数が無い実行系。衝突しにくさは落ちるが、動きは止めない
  for (let i = 0; i < out.length; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function randomSuffix(): string {
  const buf = new Uint8Array(RANDOM_LENGTH * 2);
  let out = '';
  while (out.length < RANDOM_LENGTH) {
    for (const b of randomBytes(buf)) {
      if (b >= UNBIASED_LIMIT) continue;
      out += ALPHABET[b % 36];
      if (out.length === RANDOM_LENGTH) break;
    }
  }
  return out;
}

export function newId(prefix: string): Id {
  return `${prefix}${randomSuffix()}`;
}
