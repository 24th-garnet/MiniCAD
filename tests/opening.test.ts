import { defaultAttrs } from '../src/core/attrs.ts';
import { dxfOpts, oracleEntities, parseDxfOracle } from './dxf-oracle.ts';
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
    sillHeight: null,
    height: null,
    id: newId('op'),
    wallId: wall.id,
    offset: WALL_LENGTH / 2,
    width,
    kind,
    flipX: false,
    flipY: false,
    layerId: LAYER_IDS.opening,
    attrs: defaultAttrs(),
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

import { sceneToDxf } from '../src/io/dxf.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { defaultSettings } from '../src/core/store.ts';

test('どの種別でも DXF の円弧が 90 度のまま出る', () => {
  // 円弧の向きの約束は Canvas / SVG / DXF でそれぞれ違う。
  // 過去にここを取り違えてドアの軌跡が 270 度になったことがあるので、外部パーサで読み戻して確かめる
  for (const kind of OPENING_KINDS) {
    const { scene } = sceneWith(kind);
    const dxf = sceneToDxf(scene, detectRooms(scene), defaultSettings(), dxfOpts());
    const parsed = parseDxfOracle(dxf);
    for (const e of oracleEntities(parsed).filter((x) => x.type === 'ARC')) {
      const arc = e;
      let sweep = arc.endAngle - arc.startAngle;
      while (sweep <= 0) sweep += Math.PI * 2;
      assert.ok(Math.abs(sweep - Math.PI / 2) < 1e-6, `${kind}: 掃き角 ${(sweep * 180) / Math.PI} 度`);
    }
  }
});

test('引き込む側のかくれ線が DXF にエンティティ単位の線種として出る', () => {
  const { scene } = sceneWith('slidingPocket');
  const dxf = sceneToDxf(scene, detectRooms(scene), defaultSettings(), dxfOpts());
  // グループコード 6 が画層の線種を上書きする
  assert.match(dxf, /\r\n6\r\nHIDDEN\r\n/);
  assert.ok(parseDxfOracle(dxf), '線種を入れたら読めなくなった');
});

// --- 縦方向の寸法（3D が使う） ---

import { OPENING_PROFILES, openingVertical } from '../src/core/opening.ts';
import { DEFAULT_LEVEL_ID, activeLevel, defaultLevel, wallHeightOf } from '../src/core/level.ts';

test('建具の高さの既定が妥当な範囲に収まる', () => {
  const level = defaultLevel();
  for (const kind of OPENING_KINDS) {
    const p = OPENING_PROFILES[kind];
    assert.ok(Number.isFinite(p.sillHeight) && p.sillHeight >= 0, `${kind}: 窓台 ${p.sillHeight}`);
    assert.ok(Number.isFinite(p.height) && p.height > 0, `${kind}: 高さ ${p.height}`);
    // まぐさが必ず残る（開口が壁の天端まで抜けない）
    assert.ok(p.sillHeight + p.height <= level.wallHeight, `${kind}: 頭 ${p.sillHeight + p.height} が壁高を超える`);

    const family = OPENING_SYMBOLS[kind].family;
    if (family === 'door') assert.equal(p.sillHeight, 0, `${kind} は床から始まるべき`);
    else assert.ok(p.sillHeight > 0, `${kind} は既定が腰窓であるべき`);
  }
});

test('開口ごとの上書きが効き、おかしな値は既定に落ちる', () => {
  const level = defaultLevel();
  const base = (over: Partial<Opening>) => {
    const { opening } = sceneWith('window');
    Object.assign(opening, over);
    return openingVertical(opening, level);
  };

  assert.deepEqual(base({}), { sill: 800, head: 1900 }, '既定の腰窓');
  // 掃き出し窓は種別ではなく上書きで表す
  assert.deepEqual(base({ sillHeight: 0, height: 2000 }), { sill: 0, head: 2000 });
  // 0 は窓台として正当な値なので上書きとして採る
  assert.equal(base({ sillHeight: 0 }).sill, 0);
  // 高さ 0 や負値・NaN は既定へ
  assert.deepEqual(base({ height: 0 }), { sill: 800, head: 1900 });
  assert.deepEqual(base({ sillHeight: -100 }), { sill: 800, head: 1900 });
  assert.deepEqual(base({ height: Number.NaN }), { sill: 800, head: 1900 });
});

test('床の高さが開口の位置に乗る', () => {
  const { opening } = sceneWith('door');
  const v = openingVertical(opening, { ...defaultLevel(), floorZ: 3000 });
  assert.deepEqual(v, { sill: 3000, head: 5000 });
});

test('壁と建具の高さが JSON の往復で保たれる', () => {
  const scene = sampleScene();
  const wall = Object.values(scene.walls)[0];
  const opening = Object.values(scene.openings)[0];
  wall.height = 2700;
  opening.sillHeight = 0;
  opening.height = 2000;
  activeLevel(scene).wallHeight = 2500;

  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.equal(back.walls[wall.id].height, 2700);
  assert.equal(back.openings[opening.id].sillHeight, 0);
  assert.equal(back.openings[opening.id].height, 2000);
  assert.equal(activeLevel(back).wallHeight, 2500);
});

test('高さを持たない旧ファイルは既定値に落ちる', () => {
  const scene = sampleScene();
  const raw = JSON.parse(JSON.stringify(serialize(scene)));
  for (const w of Object.values(raw.scene.walls) as Record<string, unknown>[]) delete w.height;
  for (const o of Object.values(raw.scene.openings) as Record<string, unknown>[]) {
    delete o.sillHeight;
    delete o.height;
  }
  delete raw.scene.level;
  delete raw.scene.levels;
  delete raw.scene.activeLevelId;

  const back = deserialize(raw);
  assert.deepEqual(activeLevel(back), defaultLevel());
  for (const w of Object.values(back.walls)) assert.equal(w.height, null);
  for (const o of Object.values(back.openings)) {
    assert.equal(o.sillHeight, null);
    assert.equal(o.height, null);
  }
  const wall = Object.values(back.walls)[0];
  assert.equal(wallHeightOf(wall, activeLevel(back)), 2400, '既定の壁高に落ちていない');
});

// --- 版 8 → 9（階が複数になる） ----------------------------------------------

test('版 8 の単数の階が 1 件の levels として読める', () => {
  const scene = sampleScene();
  const raw = JSON.parse(JSON.stringify(serialize(scene)));
  // 版 8 の形に戻す
  raw.version = 8;
  raw.scene.level = { floorZ: 0, wallHeight: 2500 };
  delete raw.scene.levels;
  delete raw.scene.activeLevelId;

  const back = deserialize(raw);
  assert.deepEqual(Object.keys(back.levels), [DEFAULT_LEVEL_ID], '階が 1 件になっていない');
  assert.equal(back.activeLevelId, DEFAULT_LEVEL_ID);
  assert.equal(activeLevel(back).wallHeight, 2500, '旧 level の値が引き継がれていない');
});

test('版 8 の実体はすべて既定の階に乗る', () => {
  const scene = sampleScene();
  const raw = JSON.parse(JSON.stringify(serialize(scene)));
  raw.version = 8;
  delete raw.scene.levels;
  delete raw.scene.activeLevelId;
  for (const n of Object.values(raw.scene.nodes) as Record<string, unknown>[]) delete n.levelId;
  for (const w of Object.values(raw.scene.walls) as Record<string, unknown>[]) delete w.levelId;
  for (const i of Object.values(raw.scene.instances) as Record<string, unknown>[]) delete i.levelId;
  for (const l of Object.values(raw.scene.roomLabels) as Record<string, unknown>[]) delete l.levelId;
  for (const s of Object.values(raw.scene.shapes) as Record<string, unknown>[]) delete s.levelId;

  const back = deserialize(raw);
  const all = [
    ...Object.values(back.nodes),
    ...Object.values(back.walls),
    ...Object.values(back.instances),
    ...Object.values(back.roomLabels),
    ...Object.values(back.shapes),
  ];
  assert.ok(all.length > 20, '前提: サンプルに十分な実体がある');
  for (const e of all) assert.equal(e.levelId, DEFAULT_LEVEL_ID, `${e.id} が階に乗っていない`);
  // 壁が落ちていない＝両端ノードと階が揃っている
  assert.equal(Object.keys(back.walls).length, Object.keys(scene.walls).length);
});

test('階が複数あるファイルが往復する', () => {
  const scene = sampleScene();
  scene.levels['lv-2'] = { id: 'lv-2', name: '2階', floorZ: 2400, wallHeight: 2600 };
  scene.activeLevelId = 'lv-2';

  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.deepEqual(back.levels, scene.levels);
  assert.equal(back.activeLevelId, 'lv-2');
});

test('知らない階を指す実体は作業中の階に落ちる', () => {
  const scene = sampleScene();
  const raw = JSON.parse(JSON.stringify(serialize(scene)));
  for (const n of Object.values(raw.scene.nodes) as Record<string, unknown>[]) n.levelId = 'lv-nope';

  const back = deserialize(raw);
  for (const n of Object.values(back.nodes)) assert.equal(n.levelId, back.activeLevelId);
  assert.equal(Object.keys(back.walls).length, Object.keys(scene.walls).length, '壁が落ちた');
});
