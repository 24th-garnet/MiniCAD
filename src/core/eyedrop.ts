import type { Attrs, TakeoffMode } from './attrs.ts';
import { ENTITY_KINDS, setLayerOf } from './entity.ts';
import type { LayerId } from './layer.ts';
import { attrsOf } from './material.ts';
import type { EntityRef, Scene } from './types.ts';

/**
 * スポイトが運ぶもの（ワイヤー 7 枚目の「スポイト」）。
 *
 * **運ぶのは 4 つだけ。** 色・素材・積算区分と、画層。
 *
 * | 運ばないもの | 理由 |
 * |---|---|
 * | `groupId` | 配ると、**人の作ったグループに勝手に加わる** |
 * | `stampId` / `symbolId` / `symbolVersion` | 配ると、**シンボルの一括変更が押し直す相手を壊す** |
 *
 * `Attrs` の欄を増やしたときに運ぶかどうかを決め忘れないよう、
 * **ここで欄を名指し**している（`{ ...attrs }` で丸ごと写さない）。
 */
export interface Eyedrop {
  color: string | null;
  materialRef: string | null;
  takeoff: TakeoffMode | null;
  layerId: LayerId;
}

/** 吸う。属性も画層も持たないもの（ノード・室名ラベル）からは吸えない */
export function pickEyedrop(scene: Scene, ref: EntityRef): Eyedrop | null {
  const attrs = attrsOf(scene, ref);
  const layerId = ENTITY_KINDS[ref.type].layerIdOf(scene, ref.id);
  if (!attrs || !layerId) return null;
  return {
    color: attrs.color,
    materialRef: attrs.materialRef,
    takeoff: attrs.takeoff,
    layerId,
  };
}

/** 配る。1 つでも書き換えたら true */
export function applyEyedrop(scene: Scene, refs: readonly EntityRef[], held: Eyedrop): boolean {
  let changed = setLayerOf(scene, [...refs], held.layerId);
  for (const ref of refs) {
    const attrs: Attrs | null = attrsOf(scene, ref);
    if (!attrs) continue;
    attrs.color = held.color;
    attrs.materialRef = held.materialRef;
    attrs.takeoff = held.takeoff;
    changed = true;
  }
  return changed;
}
