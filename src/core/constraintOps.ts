import { newId, type Id, type Scene } from './types.ts';
import { CONSTRAINT_SPECS, type Constraint, type ConstraintKind } from './constraints.ts';

/**
 * 拘束の張り替えと掃除。
 *
 * 壁の同一性を変える操作（分割・統合・削除・複写）のたびに、
 * ここを通して拘束の参照を整える。対象が壁なのでノードの掃除
 * （`pruneOrphanNodes`）には一切関わらない。
 */

export function constraintsOnWall(scene: Scene, wallId: Id): Constraint[] {
  return Object.values(scene.constraints).filter((c) => c.walls.includes(wallId));
}

/** 同じ種別・同じ壁の組み合わせが既にあるか。UI のボタンを無効にするのに使う */
export function hasConstraint(scene: Scene, kind: ConstraintKind, walls: Id[]): boolean {
  const key = [...walls].sort().join('|');
  return Object.values(scene.constraints).some((c) => c.kind === kind && [...c.walls].sort().join('|') === key);
}

export function addConstraint(scene: Scene, kind: ConstraintKind, walls: Id[]): Constraint | null {
  const spec = CONSTRAINT_SPECS[kind];
  if (!spec.applicable(scene, walls) || hasConstraint(scene, kind, walls)) return null;
  const c: Constraint = { id: newId('cs'), kind, walls: [...walls], value: spec.initialValue(scene, walls) };
  scene.constraints[c.id] = c;
  return c;
}

/**
 * 参照先を失った拘束を掃除する。
 *
 * ソルバを全域関数にするための自己修復。`commit` が `fn()` の例外で
 * シーンを巻き戻さない（store.ts）ため、壊れた参照が残ったまま次の solve に
 * 入ることがある。壊れた参照を例外ではなく掃除で扱うのは、`deserialize` が
 * 壊れた参照を静かに捨てるのと同じ作法。
 */
export function pruneConstraints(scene: Scene): boolean {
  let changed = false;
  for (const c of Object.values(scene.constraints)) {
    if (CONSTRAINT_SPECS[c.kind].applicable(scene, c.walls)) continue;
    delete scene.constraints[c.id];
    changed = true;
  }
  return changed;
}

export function dropConstraintsForWall(scene: Scene, wallId: Id): void {
  for (const c of constraintsOnWall(scene, wallId)) delete scene.constraints[c.id];
}

/**
 * 壁が2本に割れたときの引き継ぎ。
 *
 * 角度系（水平・垂直・平行・直角）は分割後も両方に効くべきなので**後半にも複製**する。
 * 長さだけは意味が壊れる（全長の指定が前半だけの指定に化ける）ので**削除**する。
 * 「分割線を跨ぐ開口は行き場がないので削除する」という既存の割り切りと同じ考え方。
 */
export function splitConstraints(scene: Scene, firstId: Id, secondId: Id): void {
  for (const c of constraintsOnWall(scene, firstId)) {
    if (CONSTRAINT_SPECS[c.kind].usesValue) {
      delete scene.constraints[c.id];
      continue;
    }
    const walls = c.walls.map((w) => (w === firstId ? secondId : w));
    if (hasConstraint(scene, c.kind, walls)) continue;
    const id = newId('cs');
    scene.constraints[id] = { id, kind: c.kind, walls, value: c.value };
  }
}

/**
 * 複写したときの引き継ぎ。
 *
 * **全参照先が複製されている拘束だけ**を複製する。片方しか複製されていない拘束を
 * 写すと、複製が元に引きずられて動いてしまう。
 * 「両端が選択に含まれる壁だけ複製する」という `transformEntities` の規則と同じ考え方。
 */
export function copyConstraints(scene: Scene, wallMap: ReadonlyMap<Id, Id>): void {
  if (wallMap.size === 0) return;
  for (const c of Object.values(scene.constraints)) {
    const walls = c.walls.map((w) => wallMap.get(w));
    if (walls.some((w) => w === undefined)) continue;
    const mapped = walls as Id[];
    if (hasConstraint(scene, c.kind, mapped)) continue;
    const id = newId('cs');
    scene.constraints[id] = { id, kind: c.kind, walls: mapped, value: c.value };
  }
}
