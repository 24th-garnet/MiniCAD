import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleScene } from '../src/io/sample.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { OPENING_KINDS, isOpeningKind } from '../src/core/types.ts';

test('すべての建具種別が JSON の往復で保たれる', () => {
  const scene = sampleScene();
  const sample = Object.values(scene.openings)[0];
  // 種別を一通り仕込んでから往復させる。表引きにする前は未知の種別が 'door' に化けていた
  for (const kind of OPENING_KINDS) {
    scene.openings[kind] = { ...sample, id: kind, kind };
  }

  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  for (const kind of OPENING_KINDS) {
    assert.equal(back.openings[kind]?.kind, kind, `${kind} が往復で化けた`);
  }
});

test('知らない種別はドアに落ちる', () => {
  const scene = sampleScene();
  const id = Object.keys(scene.openings)[0];
  const raw = JSON.parse(JSON.stringify(serialize(scene)));
  raw.scene.openings[id].kind = 'nonsense';
  assert.equal(deserialize(raw).openings[id].kind, 'door');
  assert.equal(isOpeningKind('nonsense'), false);
});

import { dist, vec } from '../src/core/geometry.ts';
import { emptyScene, newId, type Opening, type OpeningKind, type Scene } from '../src/core/types.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { OPENING_SYMBOLS, openingKindsOf, openingPrimitives } from '../src/core/opening.ts';
import { openingFrame } from '../src/core/shape.ts';
import type { Primitive } from '../src/core/primitive.ts';

const WALL_LENGTH = 4000;
const THICKNESS = 120;

/** 水平な壁 1 本の上に、指定した種別の建具を 1 つだけ置いたシーン */
function sceneWith(kind: OpeningKind, width = 1600, flip: Partial<Opening> = {}): { scene: Scene; opening: Opening } {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(WALL_LENGTH, 0));
  const wall = addWall(scene, a, b, THICKNESS)!;
  const opening: Opening = {
    id: newId('op'),
    wallId: wall.id,
    offset: WALL_LENGTH / 2,
    width,
    kind,
    flipX: false,
    flipY: false,
    layerId: LAYER_IDS.opening,
    ...flip,
  };
  scene.openings[opening.id] = opening;
  return { scene, opening };
}

const pointsOf = (prims: Primitive[]): { x: number; y: number }[] =>
  prims.flatMap((p) =>
    p.kind === 'segments'
      ? p.segments.flatMap((s) => [s.a, s.b])
      : p.kind === 'arc' || p.kind === 'circle'
        ? [p.center]
        : p.kind === 'polygon'
          ? p.points
          : [p.at],
  );

test('すべての種別で座標が有限', () => {
  for (const kind of OPENING_KINDS) {
    const { scene, opening } = sceneWith(kind);
    const prims = openingPrimitives(scene, opening);
    assert.ok(prims.length > 0, `${kind} の記号が空`);
    for (const p of pointsOf(prims)) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${kind} に有限でない座標がある`);
    }
  }
});

test('円弧を持つ種別は、すべて掃き角が 90 度', () => {
  for (const kind of OPENING_KINDS) {
    const { scene, opening } = sceneWith(kind);
    for (const prim of openingPrimitives(scene, opening)) {
      if (prim.kind !== 'arc') continue;
      let sweep = prim.endAngle - prim.startAngle;
      while (sweep <= 0) sweep += Math.PI * 2;
      assert.ok(Math.abs(sweep - Math.PI / 2) < 1e-9, `${kind} の掃き角が ${(sweep * 180) / Math.PI} 度`);
    }
  }
});

test('両開き戸は左右対称で、2枚の扉が中央で突き合う', () => {
  const { scene, opening } = sceneWith('doubleDoor', 1600);
  const f = openingFrame(scene, opening)!;
  const arcs = openingPrimitives(scene, opening).filter((p) => p.kind === 'arc');
  assert.equal(arcs.length, 2);
  for (const arc of arcs) {
    if (arc.kind !== 'arc') continue;
    assert.ok(Math.abs(arc.radius - 800) < 1e-9, `半径 ${arc.radius}`);
  }
  // 吊元は両端の小口
  const hinges = arcs.map((a) => (a.kind === 'arc' ? a.center : vec(0, 0)));
  assert.ok(hinges.some((h) => dist(h, f.start) < 1e-9));
  assert.ok(hinges.some((h) => dist(h, f.end) < 1e-9));
});

test('親子扉は子扉 1/3・親扉 2/3 に割れ、flipX で左右が入れ替わる', () => {
  const radii = (flipX: boolean) => {
    const { scene, opening } = sceneWith('unequalDoor', 1200, { flipX });
    return openingPrimitives(scene, opening)
      .flatMap((p) => (p.kind === 'arc' ? [p.radius] : []))
      .sort((a, b) => a - b);
  };
  assert.deepEqual(radii(false), [400, 800]);
  assert.deepEqual(radii(true), [400, 800]);

  // 吊元は両端のまま動かず、どちら側が子扉になるかだけが入れ替わる
  const leftLeaf = (flipX: boolean) => {
    const { scene, opening } = sceneWith('unequalDoor', 1200, { flipX });
    const f = openingFrame(scene, opening)!;
    const arc = openingPrimitives(scene, opening).find((p) => p.kind === 'arc' && dist(p.center, f.start) < 1e-9);
    return arc?.kind === 'arc' ? arc.radius : null;
  };
  assert.equal(leftLeaf(false), 400, '既定では左が子扉');
  assert.equal(leftLeaf(true), 800, 'flipX で左が親扉になる');
});

test('召し合わせの印は開口幅に依らず一定（ブロックでは表せない性質）', () => {
  const tick = (width: number) => {
    const { scene, opening } = sceneWith('slidingDouble', width);
    const segs = openingPrimitives(scene, opening).flatMap((p) => (p.kind === 'segments' ? p.segments : []));
    // 壁を横切る短い線が召し合わせの印
    const mark = segs.find((s) => Math.abs(s.a.x - s.b.x) < 1e-9)!;
    return dist(mark.a, mark.b);
  };
  assert.ok(Math.abs(tick(600) - tick(1800)) < 1e-9, '印の長さが幅に引きずられている');

  // 一方で障子線の長さは幅に比例する
  const leaf = (width: number) => {
    const { scene, opening } = sceneWith('slidingDouble', width);
    const segs = openingPrimitives(scene, opening).flatMap((p) => (p.kind === 'segments' ? p.segments : []));
    return Math.max(...segs.map((s) => dist(s.a, s.b)));
  };
  assert.ok(Math.abs(leaf(600) - 600) < 1e-9);
  assert.ok(Math.abs(leaf(1800) - 1800) < 1e-9);
});

test('片引き戸と引込み戸は、引き込む側だけをかくれ線にする', () => {
  for (const kind of ['slidingSingle', 'slidingPocket'] as const) {
    const { scene, opening } = sceneWith(kind);
    const prims = openingPrimitives(scene, opening);
    assert.ok(
      prims.some((p) => 'lineType' in p && p.lineType === 'hidden'),
      `${kind} にかくれ線がない`,
    );
    assert.ok(
      prims.some((p) => !('lineType' in p) || p.lineType === undefined),
      `${kind} が全部かくれ線になっている`,
    );
  }
});

test('flipX / flipY は、意味を持つ種別でだけ記号を変える', () => {
  const render = (kind: OpeningKind, flip: Partial<Opening>) => {
    const { scene, opening } = sceneWith(kind, 1600, flip);
    return JSON.stringify(openingPrimitives(scene, opening));
  };
  for (const kind of OPENING_KINDS) {
    const base = render(kind, {});
    const sym = OPENING_SYMBOLS[kind];
    assert.equal(render(kind, { flipX: true }) !== base, sym.usesFlipX, `${kind} の usesFlipX が実装と食い違う`);
    assert.equal(render(kind, { flipY: true }) !== base, sym.usesFlipY, `${kind} の usesFlipY が実装と食い違う`);
  }
});

test('ツールの系統で種別を絞り込める', () => {
  const doors = openingKindsOf('door');
  const windows = openingKindsOf('window');
  assert.deepEqual([...doors, ...windows].sort(), [...OPENING_KINDS].sort(), '系統の割り振りに漏れがある');
  assert.ok(doors.includes('door') && windows.includes('window'));
});

import DxfParser from 'dxf-parser';
import { sceneToDxf } from '../src/io/dxf.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { defaultSettings } from '../src/core/store.ts';

test('どの種別でも DXF の円弧が 90 度のまま出る', () => {
  // 円弧の向きの約束は Canvas / SVG / DXF でそれぞれ違う。
  // 過去にここを取り違えてドアの軌跡が 270 度になったことがあるので、外部パーサで読み戻して確かめる
  for (const kind of OPENING_KINDS) {
    const { scene } = sceneWith(kind);
    const dxf = sceneToDxf(scene, detectRooms(scene), defaultSettings(), { escapeUnicode: false });
    const parsed = new DxfParser().parseSync(dxf)!;
    for (const e of parsed.entities.filter((x) => x.type === 'ARC')) {
      const arc = e as { startAngle: number; endAngle: number };
      let sweep = arc.endAngle - arc.startAngle;
      while (sweep <= 0) sweep += Math.PI * 2;
      assert.ok(Math.abs(sweep - Math.PI / 2) < 1e-6, `${kind}: 掃き角 ${(sweep * 180) / Math.PI} 度`);
    }
  }
});

test('引き込む側のかくれ線が DXF にエンティティ単位の線種として出る', () => {
  const { scene } = sceneWith('slidingPocket');
  const dxf = sceneToDxf(scene, detectRooms(scene), defaultSettings(), { escapeUnicode: false });
  // グループコード 6 が画層の線種を上書きする
  assert.match(dxf, /\r\n6\r\nHIDDEN\r\n/);
  assert.ok(new DxfParser().parseSync(dxf), '線種を入れたら読めなくなった');
});
