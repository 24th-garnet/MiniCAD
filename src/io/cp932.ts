/**
 * Shift-JIS (cp932) で書き出す。**符号化表を同梱しない。**
 *
 * Jw_cad は Shift-JIS しか読めないので、UTF-8 の DXF を渡すと室名も表題欄も
 * 文字化けする。ところがブラウザにも Node にも **Shift-JIS の符号化器は無い**
 * （`TextEncoder` は UTF-8 専用）。
 *
 * そこで**復号器から符号化表を起こす**。`TextDecoder('shift_jis')` は標準で
 * 使えるので、2 バイト列を総当たりして文字へ直し、その逆を表にすればよい。
 * 実測で 9,604 字が起こせる（JIS X 0208 ＋ NEC/IBM 拡張）。
 *
 * これなら**データを 1 バイトも同梱せずに**符号化できる。`依存ライブラリなし`
 * という方針を守ったまま Jw_cad へ渡せる、唯一の道。
 *
 * 表を作るのに 47,000 回ほど復号するので、**1 度だけ作って使い回す**。
 */

let table: Map<string, number> | null = null;

/** 復号器から符号化表を起こす。初回だけ走る */
function build(): Map<string, number> {
  const map = new Map<string, number>();
  const dec = new TextDecoder('shift_jis', { fatal: true });
  // 半角（1 バイトで表せるもの）
  for (let b = 0x00; b <= 0xff; b++) {
    if (b >= 0x80 && b <= 0xa0) continue;
    if (b >= 0xe0) continue;
    try {
      const ch = dec.decode(new Uint8Array([b]));
      if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, b);
    } catch {
      /* 1 バイトで表せない先頭バイト */
    }
  }
  // 全角。**後から来た割り当てで上書きしない**（NEC/IBM の重複は先勝ち）
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      try {
        const ch = dec.decode(new Uint8Array([lead, trail]));
        if (ch.length === 1 && ch !== '�' && !map.has(ch)) {
          map.set(ch, (lead << 8) | trail);
        }
      } catch {
        /* 割り当ての無い組み合わせ */
      }
    }
  }
  return map;
}

/** Shift-JIS に収まらない字をどうするか */
export const FALLBACK = '?';

export interface Cp932Result {
  bytes: Uint8Array;
  /** 収まらなかった字。**黙って置き換えない。呼ぶ側が数えて見せる** */
  dropped: string[];
}

/** 文字列を cp932 のバイト列へ。収まらない字は `?` に落とし、拾って返す */
export function encodeCp932(text: string): Cp932Result {
  if (!table) table = build();
  const out: number[] = [];
  const dropped: string[] = [];
  for (const ch of text) {
    const code = table.get(ch);
    if (code === undefined) {
      dropped.push(ch);
      out.push(FALLBACK.charCodeAt(0));
    } else if (code > 0xff) {
      out.push(code >> 8, code & 0xff);
    } else {
      out.push(code);
    }
  }
  return { bytes: new Uint8Array(out), dropped };
}
