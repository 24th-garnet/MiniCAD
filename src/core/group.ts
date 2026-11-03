import { attrsOf } from './material.ts';
import { newId, type EntityRef, type Id, type Scene } from './types.ts';

/**
 * 人が作るグループ。**`Attrs.groupId` が同じものが 1 グループ。**
 *
 * **新しい実体は作らない。** グループを 1 つの箱として持つと、入れ子の座標系・
 * 部屋検出・DXF の書き出しが全部その箱を知る必要が出る。同じ値を持つ札で表せば、
 * 選択のときだけ広げればよく、保存も往復もいまのままで通る。
 * シンボルのスタンプ（`Attrs.stampId`）と同じ考え方で、**欄だけは別**にしてある。
 *
 * **入れ子にはしない。** グループの中のグループは、解除したときにどちらが外れるかが
 * 使う人に見えない。グループ済みのものをまとめると、**1 つの大きいグループになる**。
 */

/** 属性を持たない種別はグループに入らない。ノードと室名ラベルがそれにあたる */
const groupable = (scene: Scene, ref: EntityRef): boolean => attrsOf(scene, ref) !== null;

/**
 * 選んだものを 1 つのグループにする。できたグループの id を返す。
 *
 * **既にグループに属しているものを含めると、そのグループ全体を巻き込む。**
 * 一部だけ新しいグループへ移すと、元のグループが使う人の知らないところで
 * 欠けることになる。
 */
export function groupEntities(scene: Scene, refs: readonly EntityRef[]): Id | null {
  const members = expandGroups(scene, refs).filter((ref) => groupable(scene, ref));
  if (members.length < 2) return null;
  const groupId = newId('g');
  for (const ref of members) {
    const attrs = attrsOf(scene, ref);
    if (attrs) attrs.groupId = groupId;
  }
  return groupId;
}

/**
 * 選んだものが属するグループを解く。1 つでも解けたら true。
 *
 * グループの一部だけを選んでいても**グループ全体**が解ける。
 * 片方だけ外れると、残りが見た目には何も変わらないまま 1 つ減った状態になる。
 */
export function ungroupEntities(scene: Scene, refs: readonly EntityRef[]): boolean {
  const ids = new Set<Id>();
  for (const ref of refs) {
    const attrs = attrsOf(scene, ref);
    if (attrs?.groupId) ids.add(attrs.groupId);
  }
  if (ids.size === 0) return false;
  for (const ref of allWithAttrs(scene)) {
    const attrs = attrsOf(scene, ref);
    if (attrs?.groupId && ids.has(attrs.groupId)) attrs.groupId = null;
  }
  return true;
}

/**
 * グループに属する参照を、同じグループの仲間ごと広げる。
 *
 * **選択の入口でここを通す。** 1 つ掴んだら全部動くのがグループの意味で、
 * 移動・複写・削除はいまのまま「選ばれているものを処理する」でよくなる。
 * 順番は保ち、同じものは 1 回だけ返す。
 */
export function expandGroups(scene: Scene, refs: readonly EntityRef[]): EntityRef[] {
  const ids = new Set<Id>();
  for (const ref of refs) {
    const attrs = attrsOf(scene, ref);
    if (attrs?.groupId) ids.add(attrs.groupId);
  }
  if (ids.size === 0) return [...refs];

  const out: EntityRef[] = [];
  const seen = new Set<string>();
  const push = (ref: EntityRef): void => {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };
  for (const ref of refs) push(ref);
  for (const ref of allWithAttrs(scene)) {
    const attrs = attrsOf(scene, ref);
    if (attrs?.groupId && ids.has(attrs.groupId)) push(ref);
  }
  return out;
}

/** その参照が属するグループの仲間の数。画面の案内に使う */
export function groupSize(scene: Scene, ref: EntityRef): number {
  const groupId = attrsOf(scene, ref)?.groupId;
  if (!groupId) return 0;
  let n = 0;
  for (const other of allWithAttrs(scene)) {
    if (attrsOf(scene, other)?.groupId === groupId) n += 1;
  }
  return n;
}

/**
 * 属性を持つ実体を全部並べる。
 *
 * `attrsOf` が答える 6 種別と**同じ順・同じ並び**。片方に足してもう片方を忘れると、
 * 足した種別だけグループに入れない形で静かに壊れるので、ここを唯一の出どころにする。
 */
function* allWithAttrs(scene: Scene): Generator<EntityRef> {
  for (const id of Object.keys(scene.walls)) yield { type: 'wall', id };
  for (const id of Object.keys(scene.openings)) yield { type: 'opening', id };
  for (const id of Object.keys(scene.instances)) yield { type: 'blockInstance', id };
  for (const id of Object.keys(scene.shapes)) yield { type: 'shape', id };
  for (const id of Object.keys(scene.fixtures)) yield { type: 'fixture', id };
  for (const id of Object.keys(scene.measurements)) yield { type: 'measurement', id };
}
