import { defaultAttrs, type Attrs } from './attrs.ts';
import type { Fixture } from './fixture.ts';
import { add, rotate, vec, type Vec } from './geometry.ts';
import type { Id } from './id.ts';
import type { Shape } from './shapes.ts';
import { newId, type Opening, type Scene, type Wall } from './types.ts';
import { resolveSelection } from './selection.ts';
import type { EntityRef } from './types.ts';

/**
 * シンボル。**壁と建具と構造を含められる、挿せるひとまとまり。**
 *
 * ## なぜ `BlockDef` ではないのか
 *
 * `BlockDef` が図形しか持てないのは**正しい設計**で、README が理由を書いている
 * ——定義の中にノードグラフを置くと、挿入ごとに複製が要り、部屋検出が壊れる。
 * `BlockDef` は DXF の `INSERT` に 1:1 で対応する本物のブロックなので、
 * その性質を崩すと相互運用が壊れる。
 *
 * ## だからスタンプにする
 *
 * 挿入は**実体への展開**。壁もノードも建具も本物として置かれるので、
 * 部屋検出は無改造で効き、DXF もそのまま出る。由来は `Attrs.symbolId` と
 * `symbolVersion` に書いておく。
 *
 * **これは README の「壁を含む入れ子ブロック定義は作らない」を破っていない。**
 * 入れ子の座標系は作らず、置いた瞬間にただの壁になる。代わりに払う代償は
 * 「同一シンボルの一括変更」が再スタンプになること——**ローカルの編集を
 * 捨てうる**ので、何を上書きするかを先に報告してから行う。
 */
export interface Assembly {
  id: Id;
  name: string;
  /**
   * 版。**一括変更はこの差で決まる。**
   * 置いたときの版を実体が覚えているので、古い版のものだけを押し直せる
   */
  version: number;
  body: AssemblyBody;
}

/**
 * シンボルの中身。**基点を原点とするローカル座標**で持つ。
 *
 * 画層は持ったまま運ぶ（置いた先に同じ画層が無ければ、置くときに既定へ落とす）。
 * 階は持たない——どの階に置くかは挿す側が決める。
 */
export interface AssemblyBody {
  nodes: Record<Id, { x: number; y: number }>;
  walls: Record<Id, Omit<Wall, 'levelId'>>;
  openings: Record<Id, Opening>;
  fixtures: Record<Id, Omit<Fixture, 'levelId'>>;
  shapes: Record<Id, Omit<Shape, 'levelId'>>;
}

export const emptyBody = (): AssemblyBody => ({
  nodes: {}, walls: {}, openings: {}, fixtures: {}, shapes: {},
});

/** 中身が空か。空のシンボルを置けても仕方がない */
export const isEmptyBody = (b: AssemblyBody): boolean =>
  Object.keys(b.walls).length === 0 &&
  Object.keys(b.fixtures).length === 0 &&
  Object.keys(b.shapes).length === 0;

/**
 * 選択からシンボルを作る。基点は選択の中心。
 *
 * **ノードは壁から引く。** 壁を選べば両端が付いてくるので、
 * 選択に出ていないノードも要る。`resolveSelection` が既にやっている。
 */
export function defineAssembly(scene: Scene, refs: EntityRef[], name: string): Assembly | null {
  const sel = resolveSelection(scene, refs);
  const body = emptyBody();

  // 選んだ壁。両端のノードが選択に入っている壁だけを採る
  const nodeIds = new Set(sel.nodeIds);
  const walls = Object.values(scene.walls).filter((w) => nodeIds.has(w.a) && nodeIds.has(w.b));
  const wallIds = new Set(walls.map((w) => w.id));

  const points: Vec[] = [];
  for (const id of nodeIds) {
    const n = scene.nodes[id];
    if (n) points.push(vec(n.x, n.y));
  }
  for (const id of sel.fixtureIds) {
    const f = scene.fixtures[id];
    if (f) points.push(vec(f.x, f.y));
  }
  for (const id of sel.shapeIds) {
    const s = scene.shapes[id];
    // 寸法は壁の角に紐づくので、シンボルに入れると参照が切れる
    if (s && s.shape !== 'dimension') points.push(vec(0, 0));
  }
  if (points.length === 0) return null;

  const base = centerOf(points);
  const at = (p: { x: number; y: number }): Vec => vec(p.x - base.x, p.y - base.y);

  for (const id of nodeIds) {
    const n = scene.nodes[id];
    if (n) body.nodes[id] = at(n);
  }
  for (const w of walls) {
    const { levelId: _l, ...rest } = w;
    body.walls[w.id] = structuredClone(rest);
  }
  for (const o of Object.values(scene.openings)) {
    if (wallIds.has(o.wallId)) body.openings[o.id] = structuredClone(o);
  }
  for (const id of sel.fixtureIds) {
    const f = scene.fixtures[id];
    if (!f) continue;
    const { levelId: _l, ...rest } = structuredClone(f);
    body.fixtures[id] = { ...rest, x: f.x - base.x, y: f.y - base.y };
  }
  if (isEmptyBody(body)) return null;

  return { id: newId('as'), name, version: 1, body };
}

/**
 * シンボルを置く。**実体に展開する。**
 *
 * 置いたものの id を返す。由来は `Attrs.symbolId` と `symbolVersion` に書くので、
 * 後から「このシンボルで置いたもの」を集められる。
 */
export function stampAssembly(
  scene: Scene,
  assembly: Assembly,
  at: Vec,
  angle: number,
  levelId: Id,
): EntityRef[] {
  const body = assembly.body;
  const stamp = (p: { x: number; y: number }): Vec => add(rotate(vec(p.x, p.y), angle), at);
  const mark = (attrs: Attrs): Attrs => ({
    ...attrs,
    symbolId: assembly.id,
    symbolVersion: assembly.version,
  });
  const refs: EntityRef[] = [];

  const nodeMap = new Map<Id, Id>();
  for (const [id, p] of Object.entries(body.nodes)) {
    const q = stamp(p);
    const fresh = newId('n');
    scene.nodes[fresh] = { id: fresh, x: q.x, y: q.y, levelId };
    nodeMap.set(id, fresh);
  }

  const wallMap = new Map<Id, Id>();
  for (const [id, w] of Object.entries(body.walls)) {
    const a = nodeMap.get(w.a);
    const b = nodeMap.get(w.b);
    if (!a || !b) continue;
    const fresh = newId('w');
    scene.walls[fresh] = { ...structuredClone(w), id: fresh, a, b, levelId, attrs: mark(w.attrs) };
    wallMap.set(id, fresh);
    refs.push({ type: 'wall', id: fresh });
  }

  for (const o of Object.values(body.openings)) {
    const wallId = wallMap.get(o.wallId);
    if (!wallId) continue;
    const fresh = newId('o');
    scene.openings[fresh] = { ...structuredClone(o), id: fresh, wallId, attrs: mark(o.attrs) };
    refs.push({ type: 'opening', id: fresh });
  }

  for (const f of Object.values(body.fixtures)) {
    const q = stamp(f);
    const fresh = newId('f');
    scene.fixtures[fresh] = {
      ...structuredClone(f), id: fresh, x: q.x, y: q.y,
      angle: f.angle + angle, levelId, attrs: mark(f.attrs),
    };
    refs.push({ type: 'fixture', id: fresh });
  }

  return refs;
}

/**
 * 図面のまるごと（ホストのカタログの `scene` 欄）をシンボルにする。
 *
 * **「2LDK ベース図面」のような部品がこれ。** 読み込んだシーンの壁・建具・
 * 構造をそのまま中身にする。基点は全体の中心。
 */
export function assemblyFromScene(source: Scene, id: Id, name: string): Assembly | null {
  const body = emptyBody();
  const points: Vec[] = [];
  for (const n of Object.values(source.nodes)) points.push(vec(n.x, n.y));
  for (const f of Object.values(source.fixtures)) points.push(vec(f.x, f.y));
  if (points.length === 0) return null;

  const base = centerOf(points);
  for (const n of Object.values(source.nodes)) body.nodes[n.id] = { x: n.x - base.x, y: n.y - base.y };
  for (const w of Object.values(source.walls)) {
    const { levelId: _l, ...rest } = structuredClone(w);
    body.walls[w.id] = rest;
  }
  for (const o of Object.values(source.openings)) {
    if (source.walls[o.wallId]) body.openings[o.id] = structuredClone(o);
  }
  for (const f of Object.values(source.fixtures)) {
    const { levelId: _l, ...rest } = structuredClone(f);
    body.fixtures[f.id] = { ...rest, x: f.x - base.x, y: f.y - base.y };
  }
  if (isEmptyBody(body)) return null;
  return { id, name, version: 1, body };
}

/** そのシンボルで置かれた実体。一括変更が集める先 */
export function stampedBy(scene: Scene, symbolId: Id): EntityRef[] {
  const out: EntityRef[] = [];
  for (const w of Object.values(scene.walls)) {
    if (w.attrs.symbolId === symbolId) out.push({ type: 'wall', id: w.id });
  }
  for (const o of Object.values(scene.openings)) {
    if (o.attrs.symbolId === symbolId) out.push({ type: 'opening', id: o.id });
  }
  for (const f of Object.values(scene.fixtures)) {
    if (f.attrs.symbolId === symbolId) out.push({ type: 'fixture', id: f.id });
  }
  return out;
}

/** 置いたときの版。食い違っていれば、押し直すと変わる */
export function stampedVersions(scene: Scene, symbolId: Id): Set<number> {
  const out = new Set<number>();
  for (const ref of stampedBy(scene, symbolId)) {
    const attrs = attrsOfRef(scene, ref);
    if (attrs?.symbolVersion !== null && attrs?.symbolVersion !== undefined) out.add(attrs.symbolVersion);
  }
  return out;
}

function attrsOfRef(scene: Scene, ref: EntityRef): Attrs | null {
  if (ref.type === 'wall') return scene.walls[ref.id]?.attrs ?? null;
  if (ref.type === 'opening') return scene.openings[ref.id]?.attrs ?? null;
  if (ref.type === 'fixture') return scene.fixtures[ref.id]?.attrs ?? null;
  return null;
}

function centerOf(points: Vec[]): Vec {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return vec((minX + maxX) / 2, (minY + maxY) / 2);
}

export { defaultAttrs };
