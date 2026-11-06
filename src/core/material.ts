import type { Attrs } from './attrs.ts';
import type { EntityRef, Scene } from './types.ts';

/**
 * 素材。**MiniCAD は中身を解釈しない。**
 *
 * 実体が持つのは `Attrs.materialRef` という**不透明な識別子**だけで、
 * 物件種別・カテゴリ・グレード（松竹梅）といった分類はホストの持ち物。
 * 分類が増えるたびに図面の形式が変わるのは割に合わない。
 *
 * ホストが渡すカタログ（`HostCatalogs.materials`）には表示ヒント（色・テクスチャ）が
 * 付いてくる。**3D の着色はそれを読む**だけで、意味は読まない。
 */

/** 実体から素材の ref を引く。属性を持たない種別では null */
export function materialRefOf(scene: Scene, ref: EntityRef): string | null {
  return attrsOf(scene, ref)?.materialRef ?? null;
}

/**
 * 実体の属性を引く。**`Record<EntityType, …>` にはしない。**
 *
 * 属性を持つのは 4 種別だけで、残り（ノード・室名）は持たない。
 * 表にすると「持たない」を 2 行書くことになり、
 * `ENTITY_KINDS` と同じ形の表が 2 枚並ぶ。
 */
/**
 * 実体に直に指した線の色。無ければ null（＝画層の色に従う）。
 *
 * **ここが「色」の唯一の出どころ。** 平面・SVG・DXF・3D の 4 つが同じ値を読む。
 * 前は 3D の着色だけが読んでいて、画面にも紙にも出ていなかった。
 */
export const colorOf = (scene: Scene, ref: EntityRef): string | null =>
  attrsOf(scene, ref)?.color ?? null;

export function attrsOf(scene: Scene, ref: EntityRef): Attrs | null {
  switch (ref.type) {
    case 'wall':
      return scene.walls[ref.id]?.attrs ?? null;
    case 'opening':
      return scene.openings[ref.id]?.attrs ?? null;
    case 'blockInstance':
      return scene.instances[ref.id]?.attrs ?? null;
    case 'shape':
      return scene.shapes[ref.id]?.attrs ?? null;
    case 'fixture':
      return scene.fixtures[ref.id]?.attrs ?? null;
    case 'measurement':
      return scene.measurements[ref.id]?.attrs ?? null;
    case 'node':
    case 'area':
      return scene.areas[ref.id]?.attrs ?? null;
    case 'roomLabel':
      return null;
  }
}

