import { blockOf } from '../core/block.ts';
import { isSnappable } from '../core/entity.ts';
import { levelOf } from '../core/level.ts';
import { openingsOnWall } from '../core/ops.ts';
import type { Id, Room, Scene } from '../core/types.ts';
import { buildFloorFaces, buildInstanceFaces, buildWallFaces, type Face3 } from './mesh.ts';
import { buildFixtureFaces, fixtureFingerprint } from './fixture3d.ts';

/**
 * メッシュを実体ごとに持つ。変わったものだけ作り直す。
 *
 * **dirty フラグではなく、内容から作る指紋で判定する。**
 * `Store.commit` は `structuredClone` でシーンを丸ごと複製し、`undo` は
 * シーンごと差し替える。実体に持たせたフラグは**一緒に複製されて腐る**し、
 * シーンの外に置いたフラグは**シーンが差し替わったことを知らない**。
 * 内容から導く指紋はスナップショットの下で腐りようがない。
 * だから `Store` にも `commit` にも平坦な `emit()` にも手を入れていない。
 *
 * 指紋は「押し出す側が実際に読む欄」だけを並べた文字列にする。
 * 壁 20 本ぶんの文字列連結は、同じ壁を押し出し直すより桁違いに安い。
 *
 * 正しさは `buildMesh`（キャッシュ無しの素の組み立て）と面単位で
 * 一致するかで見る。自前の思い込みで通らないように、DXF を外部パーサで
 * 読み戻しているのと同じ考え方。
 */
export class MeshCache {
  private wallFaces = new Map<Id, Entry>();
  private fixtureFaces = new Map<Id, Entry>();
  private instanceFaces = new Map<Id, Entry>();
  private floors: Entry | null = null;

  /** 直近の `faces()` で何を作り直したか。テストと計測が読む */
  readonly stats = { walls: 0, fixtures: 0, instances: 0, floors: 0 };

  faces(scene: Scene, rooms: Room[]): Face3[] {
    this.stats.walls = 0;
    this.stats.fixtures = 0;
    this.stats.instances = 0;
    this.stats.floors = 0;

    // 並びは buildMesh と同じ（床 → 壁 → 構造 → 家具）。ソートは paint が引き受ける
    const out: Face3[] = [];

    const floorKey = floorFingerprint(scene, rooms);
    if (!this.floors || this.floors.key !== floorKey) {
      const faces: Face3[] = [];
      buildFloorFaces(scene, rooms, faces);
      this.floors = { key: floorKey, faces };
      this.stats.floors += 1;
    }
    out.push(...this.floors.faces);

    collect(scene.walls, this.wallFaces, out, (id) => wallFingerprint(scene, id), (id, faces) => {
      buildWallFaces(scene, id, faces);
      this.stats.walls += 1;
    });

    collect(scene.fixtures, this.fixtureFaces, out, (id) => fixtureFingerprint(scene, id), (id, faces) => {
      buildFixtureFaces(scene, id, faces);
      this.stats.fixtures += 1;
    });

    collect(scene.instances, this.instanceFaces, out, (id) => instanceFingerprint(scene, id), (id, faces) => {
      buildInstanceFaces(scene, id, faces);
      this.stats.instances += 1;
    });

    return out;
  }
}

interface Entry {
  key: string;
  faces: Face3[];
}

/** 作り直し、並べ、消えた実体のぶんを落とす */
function collect(
  table: Record<Id, unknown>,
  cache: Map<Id, Entry>,
  out: Face3[],
  keyOf: (id: Id) => string,
  build: (id: Id, faces: Face3[]) => void,
): void {
  for (const id of Object.keys(table)) {
    const key = keyOf(id);
    let entry = cache.get(id);
    if (!entry || entry.key !== key) {
      const faces: Face3[] = [];
      build(id, faces);
      entry = { key, faces };
      cache.set(id, entry);
    }
    out.push(...entry.faces);
  }
  // 消えた実体を残すと、使われない面を抱えたまま増え続ける
  if (cache.size > Object.keys(table).length) {
    for (const id of [...cache.keys()]) {
      if (!(id in table)) cache.delete(id);
    }
  }
}

/**
 * 壁の指紋。`extrudeWall` が実際に読む欄だけを並べる。
 *
 * 載っている開口もここに含める。開口の面は壁の押し出しの中で出るので、
 * **壁 1 本ぶんのキャッシュがその壁の開口もまとめて面倒を見る**。
 */
function wallFingerprint(scene: Scene, id: Id): string {
  const w = scene.walls[id];
  if (!w) return '';
  const a = scene.nodes[w.a];
  const b = scene.nodes[w.b];
  const level = levelOf(scene, w.levelId);
  const parts: (string | number | null | undefined)[] = [
    a?.x, a?.y, b?.x, b?.y,
    w.thickness, w.height,
    level.floorZ, level.wallHeight,
    isSnappable(scene, { type: 'wall', id }) ? 1 : 0,
  ];
  for (const o of openingsOnWall(scene, id)) {
    parts.push(o.offset, o.width, o.kind, o.flipX ? 1 : 0, o.flipY ? 1 : 0,
      o.sillHeight, o.height, isSnappable(scene, { type: 'opening', id: o.id }) ? 1 : 0,
      o.bay?.shape ?? '-', o.bay?.depth ?? 0, o.bay?.side ?? 0);
  }
  return parts.join(',');
}

/** ブロック挿入の指紋。定義の寸法と図形の数も見るので、定義を差し替えても気づく */
function instanceFingerprint(scene: Scene, id: Id): string {
  const i = scene.instances[id];
  if (!i) return '';
  const def = blockOf(scene, i);
  const level = levelOf(scene, i.levelId);
  return [
    i.x, i.y, i.angle, i.scaleX, i.scaleY, i.blockId,
    def?.size.w, def?.size.h, def ? Object.keys(def.shapes).length : 0,
    level.floorZ,
    isSnappable(scene, { type: 'blockInstance', id }) ? 1 : 0,
  ].join(',');
}

/**
 * 床の指紋。部屋は壁から導かれるので、**まとめて 1 つ**にしてある。
 * どれか 1 本の壁が動けば部屋の形が変わりうるので、1 室だけ作り直す意味が無い。
 */
function floorFingerprint(scene: Scene, rooms: Room[]): string {
  const parts: (string | number)[] = [];
  for (const room of rooms) {
    const levelId = scene.walls[room.wallIds[0]]?.levelId ?? scene.activeLevelId;
    parts.push(levelId, levelOf(scene, levelId).floorZ, '|');
    for (const p of room.innerPolygon) parts.push(p.x, p.y);
    parts.push(';');
  }
  return parts.join(',');
}
