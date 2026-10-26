import { LAYER_IDS, getLayer, type Layer } from '../core/layer.ts';
import type { EntityRef, Room, Scene } from '../core/types.ts';
import { buildMesh, type Face3 } from '../render3d/mesh.ts';
import { dxf3dFace, fmt, type DxfEntity } from './dxfPrimitive.ts';

/**
 * 3D を DXF に書き出す。
 *
 * **新しい幾何を書かない。** 3D ビューが使っているメッシュ（`buildMesh`）を
 * そのまま `3DFACE` にするだけ。面が**どのエンティティから出たか**を
 * 覚えている（Phase 1 で `Face3.ref` を足した）ので、画層もそこから引ける。
 *
 * ## 3DFACE で足りるのか
 *
 * R12 が持てる立体は `3DFACE`（3〜4 点の平らな面）だけで、`MESH` も
 * `POLYFACE` の実用的な形も無い。MiniCAD のメッシュは**最初から平らな面の
 * 寄せ集め**（ペインターズ法で描くために、曲面を持たない作りにしてある）なので、
 * 落とすものが無い。
 *
 * ## 5 点以上の面
 *
 * 床（`room.innerPolygon`）は L 字やコの字になる。`3DFACE` は 4 点までなので、
 * **扇状に分割する**。[README] が「三角形分割を書いていません」を設計上の
 * 性質として挙げているのに、ここだけ分割するのは一見矛盾する。
 *
 * **当たり判定と書き出しでは要求が違う。** 当たり判定で扇状分割を使うと
 * 凹多角形で単純に誤る（L 字の凹んだ側が当たる）ので `pointInPolygon` を使っている。
 * 書き出しは**見た目が出れば足りる**ので、凹んだ側に余分な面が出るだけで、
 * 嘘の当たり判定は生まれない。**それでも余分は余分なので、落としたと報告する。**
 */

/** 3D の面が乗る画層。平面の画層とは別にして、読み込んだ側で切り分けられるようにする */
export const LAYER_3D: Record<string, string> = {
  wall: 'A-WALL-3D',
  opening: 'A-DOOR-WIND-3D',
  furniture: 'A-FURN-3D',
  floor: 'A-FLOR-3D',
};

/** 面の出どころから、乗せる画層の名前を引く */
function layerNameOf(face: Face3): string {
  const ref: EntityRef | null = face.ref;
  if (!ref) return LAYER_3D.floor;
  if (ref.type === 'wall' || ref.type === 'fixture') return LAYER_3D.wall;
  if (ref.type === 'opening') return LAYER_3D.opening;
  if (ref.type === 'blockInstance') return LAYER_3D.furniture;
  return LAYER_3D.floor;
}

/** その面を出すか。隠した画層のものは出さない（平面の書き出しと同じ作法） */
function printable(scene: Scene, face: Face3): boolean {
  const ref = face.ref;
  if (!ref) return getLayer(scene.layers, LAYER_IDS.wall, LAYER_IDS.wall).printable;
  const layerId =
    ref.type === 'wall' ? scene.walls[ref.id]?.layerId
    : ref.type === 'opening' ? scene.openings[ref.id]?.layerId
    : ref.type === 'blockInstance' ? scene.instances[ref.id]?.layerId
    : ref.type === 'fixture' ? scene.fixtures[ref.id]?.layerId
    : undefined;
  const layer: Layer = getLayer(scene.layers, layerId, LAYER_IDS.wall);
  return layer.visible && layer.printable;
}

export interface Dxf3dResult {
  text: string;
  /** 書き出した面の数 */
  faces: number;
  /** 落としたもの・近似したものの説明 */
  notes: string[];
}

export function sceneToDxf3d(scene: Scene, rooms: Room[]): Dxf3dResult {
  const mesh = buildMesh(scene, rooms);
  const entities: DxfEntity[] = [];
  const layers = new Set<string>();
  let fanned = 0;

  for (const face of mesh) {
    if (!printable(scene, face)) continue;
    const name = layerNameOf(face);
    layers.add(name);
    const p = face.points;
    if (p.length < 3) continue;
    if (p.length <= 4) {
      entities.push(dxf3dFace(p, name));
      continue;
    }
    // 5 点以上は扇状に割る。凹多角形では余分な面が出るので、あとで報告する
    fanned += 1;
    for (let i = 1; i + 1 < p.length; i++) {
      entities.push(dxf3dFace([p[0], p[i], p[i + 1]], name));
    }
  }

  const notes: string[] = [];
  if (fanned > 0) {
    notes.push(
      `5 点以上の面 ${fanned} 枚を三角形に割りました（DXF の 3DFACE は 4 点まで）。`
      + 'L 字やコの字の床では、凹んだ側に余分な面が出ることがあります。',
    );
  }
  notes.push('3D には素材も色も出していません（R12 の 3DFACE は画層の色だけを持ちます）。');

  return { text: build(entities, [...layers]), faces: entities.length, notes };
}

/** 最小限の R12。3D の面しか入らないので、ヘッダも画層表も短い */
function build(entities: DxfEntity[], layerNames: string[]): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => {
    out.push(String(code));
    out.push(typeof value === 'number' ? fmt(value) : value);
  };

  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER');
  g(1, 'AC1009');
  g(9, '$INSUNITS');
  g(70, 4); // mm
  g(0, 'ENDSEC');

  g(0, 'SECTION');
  g(2, 'TABLES');
  g(0, 'TABLE');
  g(2, 'LAYER');
  g(70, layerNames.length);
  for (const name of layerNames) {
    g(0, 'LAYER');
    g(2, name);
    g(70, 0);
    g(62, 7);
    g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  g(0, 'SECTION');
  g(2, 'ENTITIES');
  for (const e of entities) out.push(...e);
  g(0, 'ENDSEC');
  g(0, 'EOF');

  return out.join('\r\n') + '\r\n';
}
