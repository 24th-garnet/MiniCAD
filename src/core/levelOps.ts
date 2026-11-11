import { ENTITY_KINDS, ENTITY_TYPES } from './entity.ts';
import { levelsInOrder, type Level } from './level.ts';
import { newId, type Id, type Scene } from './types.ts';

/**
 * 階の増減と付け替え。
 *
 * **`level.ts` と分けてある。** 階を数えるにも消すにも `ENTITY_KINDS` が要り、
 * `entity.ts` は `levelOf` を使うために `level.ts` を読んでいる。同じ場所に
 * 置くと循環する。`layer.ts`（型と引き方）と `entity.ts`（消す）の
 * 分かれ方と同じ理由。
 */

/** その階に乗っている実体の数。**0 なら消しても何も失わない** */
export function countOnLevel(scene: Scene, levelId: Id): number {
  let n = 0;
  for (const type of ENTITY_TYPES) {
    const kind = ENTITY_KINDS[type];
    for (const id of Object.keys(kind.table(scene))) {
      if (kind.levelIdOf(scene, id) === levelId) n += 1;
    }
  }
  return n;
}

/** 作業中の階を変える。知らない階には移らない */
export function setActiveLevel(scene: Scene, id: Id): boolean {
  if (!scene.levels[id] || scene.activeLevelId === id) return false;
  scene.activeLevelId = id;
  return true;
}

/**
 * 階を足す。
 *
 * **床高は隣の階から出す。** 2 階の床は 1 階の壁の上——`floorZ + wallHeight`。
 * スラブ厚は持っていないので足していない（持っていないものは足さない）。
 * ずらしたければ床高の欄で直せる。
 *
 * 足す先は**いちばん上かいちばん下**で、作業中の階の隣ではない。
 * 「作業中の階の上」にすると、1 階にいるときに 2 階と同じ高さの階ができて、
 * どちらがどちらか分からなくなる。
 */
export function addLevel(scene: Scene, where: 'above' | 'below'): Level {
  const order = levelsInOrder(scene);
  const base = where === 'above' ? order[order.length - 1] : order[0];
  const level: Level = {
    id: newId('lv'),
    name: uniqueName(scene, nextName(base, where)),
    floorZ: where === 'above' ? base.floorZ + base.wallHeight : base.floorZ - base.wallHeight,
    wallHeight: base.wallHeight,
  };
  scene.levels[level.id] = level;
  return level;
}

/** 名前を変える。**空名と重複は断る**（`renameLayer` と同じ作法） */
export function renameLevel(scene: Scene, id: Id, name: string): boolean {
  const level = scene.levels[id];
  const trimmed = name.trim();
  if (!level || trimmed === '') return false;
  if (Object.values(scene.levels).some((l) => l.id !== id && l.name === trimmed)) return false;
  level.name = trimmed;
  return true;
}

/**
 * 階を消せない理由。**消せるなら null。**
 *
 * 実体が乗っていたら断る。巻き添えで消すと、どの階に何があったかを
 * 覚えていない人が 1 クリックで図面の半分を失う。先に中身を消すか、
 * 別の階へ移してもらう。
 *
 * **判定を `removeLevel` から分けてある。** UI は消す前に理由を見せたいが、
 * そのために一度消してみるわけにはいかない。
 */
export function levelRemovalBlocker(scene: Scene, id: Id): string | null {
  const level = scene.levels[id];
  if (!level) return 'その階はありません';
  if (Object.keys(scene.levels).length <= 1) return '最後の階は消せません';
  const n = countOnLevel(scene, id);
  if (n > 0) {
    return `${level.name} には ${n} 個のものが乗っています。先に消すか、別の階へ移してください`;
  }
  return null;
}

/** 階を消す。断られたら false（何も変えない） */
export function removeLevel(scene: Scene, id: Id): boolean {
  if (levelRemovalBlocker(scene, id) !== null) return false;
  delete scene.levels[id];
  if (scene.activeLevelId === id) scene.activeLevelId = levelsInOrder(scene)[0].id;
  return true;
}

/** 「2階」の次は「3階」、「1階」の下は「B1」。読めない名前なら数えずに付ける */
function nextName(base: Level, where: 'above' | 'below'): string {
  const up = /^(\d+)階$/.exec(base.name);
  const down = /^B(\d+)$/.exec(base.name);
  if (where === 'above') {
    if (up) return `${Number(up[1]) + 1}階`;
    if (down) return Number(down[1]) === 1 ? '1階' : `B${Number(down[1]) - 1}`;
    return '上の階';
  }
  if (down) return `B${Number(down[1]) + 1}`;
  if (up) return Number(up[1]) === 1 ? 'B1' : `${Number(up[1]) - 1}階`;
  return '下の階';
}

/** 同じ名前が既にあれば連番を足す。名前は人が読む目印なので重ねない */
function uniqueName(scene: Scene, wanted: string): string {
  const taken = new Set(Object.values(scene.levels).map((l) => l.name));
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; ; i++) {
    const candidate = `${wanted} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
}
