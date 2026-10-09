/**
 * DXF の字句解析。
 *
 * DXF は「グループコードの行」と「値の行」が交互に並ぶだけの、きわめて単純な形式です。
 * ここではその並びをタグ列に直し、セクションとレコードに切り分けるところまでを担当します。
 * **MiniCAD のことは何も知りません**（`Scene` も `Shape` も出てきません）。
 *
 * 値はすべて文字列のまま持ちます。グループコードごとの型（整数・実数・文字列）を
 * 表で持つ方法もありますが、R12 と 2018 で型が増えるうえ、読む側は結局
 * 「このコードを数値として読みたい」と分かっているので、`num()` / `str()` で
 * 取り出すときに変換するほうが素直です。
 */

export interface Tag {
  code: number;
  value: string;
}

/** 0 番のタグで始まる塊。ENTITY ひとつ、TABLE のエントリひとつ、などに対応する */
export interface DxfRecord {
  type: string;
  tags: Tag[];
}

/** バイナリ DXF の先頭に入る決まり文句 */
const BINARY_SENTINEL = 'AutoCAD Binary DXF';

/** $DWGCODEPAGE の値 → TextDecoder の名前 */
const CODEPAGES: Record<string, string> = {
  ANSI_932: 'shift_jis',
  ANSI_936: 'gb18030',
  ANSI_949: 'euc-kr',
  ANSI_950: 'big5',
  ANSI_1250: 'windows-1250',
  ANSI_1251: 'windows-1251',
  ANSI_1252: 'windows-1252',
  ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254',
  UTF8: 'utf-8',
};

export class DxfFormatError extends Error {}

/**
 * バイト列を文字列に直す。
 *
 * ブラウザの `File.text()` は UTF-8 固定なので使えません。JW_CAD や古い AutoCAD が
 * 書いた DXF は Shift_JIS のことが多く、UTF-8 として読むと室名がすべて化けます。
 * 文字コードは `$DWGCODEPAGE` に書いてありますが、それを読むにはバイト列を
 * 一度どうにかして覗く必要がある、という鶏と卵があります。
 * ここでは「先頭を latin1（バイトをそのまま文字に）で読んで $DWGCODEPAGE を探す」
 * という手で解きます。latin1 なら任意のバイト列が必ず読めるので安全です。
 */
export function decodeDxf(bytes: Uint8Array): string {
  if (bytes.length === 0) throw new DxfFormatError('ファイルが空です。');

  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 8192)));
  if (head.startsWith(BINARY_SENTINEL)) {
    throw new DxfFormatError('バイナリ形式の DXF には対応していません。ASCII DXF で書き出し直してください。');
  }

  // UTF-8 の BOM があれば文字コードの指定より優先する
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }

  const declared = head.match(/\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n([^\r\n]*)/);
  const encoding = declared ? CODEPAGES[declared[1].trim().toUpperCase()] : undefined;
  if (encoding && encoding !== 'utf-8') return decodeWith(bytes, encoding);

  // 指定が無い／UTF-8 を名乗る場合。UTF-8 として壊れていれば Shift_JIS とみなす
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decodeWith(bytes, 'shift_jis');
  }
}

function decodeWith(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

/** MiniCAD 自身が書く \U+XXXX エスケープ（dxf.ts の escapeUnicode）を元に戻す */
export function unescapeUnicode(s: string): string {
  return s.includes('\\U+') ? s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16))) : s;
}

/**
 * タグ列に直す。
 *
 * 壊れた行（コードが数値でない、値の行が無いまま終わる）は黙って捨てます。
 * 途中で切れたファイルでも、そこまでに読めたぶんは使えるほうが実用的なためです。
 */
export function readTags(text: string): Tag[] {
  const lines = text.split(/\r\n|\r|\n/);
  const tags: Tag[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isInteger(code)) continue;
    if (code === 999) continue; // コメント
    tags.push({ code, value: unescapeUnicode(lines[i + 1].trim()) });
  }
  return tags;
}

/** SECTION 名 → その中身のタグ列（0 SECTION / 2 名前 … 0 ENDSEC を剥いだもの） */
export function splitSections(tags: Tag[]): Map<string, Tag[]> {
  const sections = new Map<string, Tag[]>();
  for (let i = 0; i < tags.length; i++) {
    if (tags[i].code !== 0 || tags[i].value !== 'SECTION') continue;
    const nameTag = tags[i + 1];
    if (!nameTag || nameTag.code !== 2) continue;
    const body: Tag[] = [];
    let j = i + 2;
    for (; j < tags.length; j++) {
      if (tags[j].code === 0 && tags[j].value === 'ENDSEC') break;
      body.push(tags[j]);
    }
    sections.set(nameTag.value.toUpperCase(), body);
    i = j;
  }
  return sections;
}

/** タグ列を 0 番区切りのレコードへ。0 番より前のタグは捨てる */
export function splitRecords(tags: Tag[]): DxfRecord[] {
  const records: DxfRecord[] = [];
  let current: DxfRecord | null = null;
  for (const tag of tags) {
    if (tag.code === 0) {
      current = { type: tag.value.toUpperCase(), tags: [] };
      records.push(current);
    } else if (current) {
      current.tags.push(tag);
    }
  }
  return records;
}

export function str(r: DxfRecord, code: number, fallback: string): string {
  for (const t of r.tags) if (t.code === code) return t.value;
  return fallback;
}

export function num(r: DxfRecord, code: number, fallback: number): number {
  for (const t of r.tags) {
    if (t.code !== code) continue;
    const n = Number(t.value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export function has(r: DxfRecord, code: number): boolean {
  return r.tags.some((t) => t.code === code);
}

export interface RawVertex {
  x: number;
  y: number;
  bulge: number;
}

/**
 * 10/20 を出現順に組にして返す。LWPOLYLINE と SOLID で使う。
 *
 * LWPOLYLINE は頂点ごとに `10 x / 20 y / 42 bulge` が繰り返される形で、
 * 42 は省略されることがあります。「10 が来たら新しい頂点を始める」という
 * 読み方にすると、42 の有無にかかわらず正しく組めます。
 */
export function vertices(r: DxfRecord): RawVertex[] {
  const out: RawVertex[] = [];
  for (const t of r.tags) {
    const n = Number(t.value);
    if (t.code === 10) out.push({ x: Number.isFinite(n) ? n : 0, y: 0, bulge: 0 });
    else if (t.code === 20 && out.length > 0) out[out.length - 1].y = Number.isFinite(n) ? n : 0;
    else if (t.code === 42 && out.length > 0) out[out.length - 1].bulge = Number.isFinite(n) ? n : 0;
  }
  return out;
}

/**
 * 押し出し方向 (210/220/230) が z = -1 か。
 *
 * これは「XY 平面を鏡像にした座標系で描かれている」という意味で、無視すると
 * 他の CAD で作ったドアの開き勝手が左右逆になります。`x → -x` と読み替えて正規化します。
 */
export function isMirroredOcs(r: DxfRecord): boolean {
  return num(r, 230, 1) < 0;
}
