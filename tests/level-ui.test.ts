import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, type Scene } from '../src/core/types.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { vec } from '../src/core/geometry.ts';
import { isSelectable, isSnappable, levelIdOfRef, ENTITY_KINDS } from '../src/core/entity.ts';
import { pickAt } from '../src/core/pick.ts';
import { snapPoint } from '../src/core/snap.ts';
import { defaultSettings, type Settings } from '../src/core/store.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { buildMesh, type Face3 } from '../src/render3d/mesh.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { render } from '../src/render/renderer.ts';
import { Viewport } from '../src/render/viewport.ts';
import { point3, type CommentAnchor } from '../src/core/annotation.ts';
import { pickComment } from '../src/tools/comment.ts';
import type { Editor } from '../src/ui/editor.ts';
import { makeFixture } from './make.ts';

/**
 * 階ごとの 2D。**同じ座標に 1 階と 2 階の壁を置いて**、作業中の階の
 * ものだけが掴める・スナップすることを見る。
 *
 * 2D は 1 枚の紙なので、階を分けないと両方が同じ場所に重なり、
 * 見えていないものを掴む。原因の分かりにくい壊れ方なので、
 * 関所（`isSelectable` / `isSnappable`）で止める。
 */

/** 1 階と 2 階に、**同じ座標の**壁を 1 本ずつ */
function twoFloors(): { scene: Scene; lower: string; upper: string } {
  const scene = emptyScene();
  scene.levels['lv-2'] = { id: 'lv-2', name: '2階', floorZ: 3000, wallHeight: 2400 };

  scene.activeLevelId = DEFAULT_LEVEL_ID;
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const lower = addWall(scene, a, b, 120)!.id;

  scene.activeLevelId = 'lv-2';
  const c = findOrCreateNode(scene, vec(0, 0));
  const d = findOrCreateNode(scene, vec(4000, 0));
  const upper = addWall(scene, c, d, 120)!.id;

  return { scene, lower, upper };
}

test('階を跨いでノードが溶けない（前提）', () => {
  const { scene, lower, upper } = twoFloors();
  assert.notEqual(lower, upper, '同じ壁になってしまっている');
  assert.equal(Object.keys(scene.nodes).length, 4, '1 階と 2 階の端点が溶けている');
});

test('実体はどの階かを答える', () => {
  const { scene, lower, upper } = twoFloors();
  assert.equal(levelIdOfRef(scene, { type: 'wall', id: lower }), DEFAULT_LEVEL_ID);
  assert.equal(levelIdOfRef(scene, { type: 'wall', id: upper }), 'lv-2');
});

test('どの種別も階を答えられる（足し忘れたら落ちる）', () => {
  const scene = emptyScene();
  for (const [type, kind] of Object.entries(ENTITY_KINDS)) {
    assert.equal(
      typeof kind.levelIdOf, 'function',
      `${type} に levelIdOf が無い`,
    );
    // 知らない id でも落ちない
    assert.equal(kind.levelIdOf(scene, 'もういない'), null, `${type}`);
  }
});

test('他の階のものは選べない', () => {
  const { scene, lower, upper } = twoFloors();
  scene.activeLevelId = DEFAULT_LEVEL_ID;
  assert.ok(isSelectable(scene, { type: 'wall', id: lower }), '1 階で 1 階の壁が選べない');
  assert.ok(!isSelectable(scene, { type: 'wall', id: upper }), '1 階で 2 階の壁が選べてしまう');

  scene.activeLevelId = 'lv-2';
  assert.ok(!isSelectable(scene, { type: 'wall', id: lower }), '2 階で 1 階の壁が選べてしまう');
  assert.ok(isSelectable(scene, { type: 'wall', id: upper }), '2 階で 2 階の壁が選べない');
});

test('他の階のものにはスナップしない', () => {
  const { scene, lower, upper } = twoFloors();
  scene.activeLevelId = DEFAULT_LEVEL_ID;
  assert.ok(isSnappable(scene, { type: 'wall', id: lower }));
  assert.ok(!isSnappable(scene, { type: 'wall', id: upper }), '1 階で 2 階の壁にスナップする');
});

test('クリックしても他の階は拾わない', () => {
  const { scene, lower, upper } = twoFloors();
  // 壁の真ん中。1 階・2 階どちらの壁もここを通る
  const at = vec(2000, 0);

  scene.activeLevelId = DEFAULT_LEVEL_ID;
  const hit1 = pickAt(scene, at, 50);
  assert.deepEqual(hit1, { type: 'wall', id: lower }, `1 階で拾ったもの: ${JSON.stringify(hit1)}`);

  scene.activeLevelId = 'lv-2';
  const hit2 = pickAt(scene, at, 50);
  assert.deepEqual(hit2, { type: 'wall', id: upper }, `2 階で拾ったもの: ${JSON.stringify(hit2)}`);
});

test('スナップも作業中の階の端点だけを見る', () => {
  // **同じ座標に置くと識別しない。** どちらに吸い付いても座標が同じなので、
  // 階を見ていなくても通ってしまう。1 階にだけ端点がある場所で測る。
  const scene = emptyScene();
  scene.levels['lv-2'] = { id: 'lv-2', name: '2階', floorZ: 3000, wallHeight: 2400 };

  scene.activeLevelId = DEFAULT_LEVEL_ID;
  addWall(scene, findOrCreateNode(scene, vec(0, 0)), findOrCreateNode(scene, vec(4000, 0)), 120);

  scene.activeLevelId = 'lv-2';
  addWall(scene, findOrCreateNode(scene, vec(0, 9000)), findOrCreateNode(scene, vec(4000, 9000)), 120);

  // 1 階の端点のすぐそば。2 階には何も無い
  const near1F = vec(4010, 5);

  // 格子スナップは切る。**格子が拾ってしまうと階の違いが見えない**
  const st = { ...defaultSettings(), snapGrid: false, snapWall: false };

  scene.activeLevelId = DEFAULT_LEVEL_ID;
  const onFirst = snapPoint(scene, st, near1F, { radius: 100 });
  assert.equal(onFirst?.kind, 'node', '1 階にいるのに 1 階の端点へ吸い付かない');

  scene.activeLevelId = 'lv-2';
  const onSecond = snapPoint(scene, st, near1F, { radius: 100 });
  // 吸い付かなかったときは `free` が返る（null ではない）
  assert.notEqual(
    onSecond?.kind, 'node',
    `2 階にいるのに 1 階の端点へ吸い付いた: ${JSON.stringify(onSecond)}`,
  );
});

test('3D は作業中の階だけでなく、全部の階を積む', () => {
  // **2D と 3D で問いが違う。** 2D は 1 枚の紙なので作業中の階だけ、
  // 3D は `floorZ` で重ねて全部を見せる。
  // 階の関所を `isSnappable` に畳んだとき、`mesh.ts` がそれを
  // 「3D に出すか」の判定にも使っていたため 3D が 1 階だけになった。
  const { scene } = twoFloors();
  const meshOf = (sc: Scene) => buildMesh(sc, detectRooms(sc));
  for (const active of ['lv-1', 'lv-2']) {
    scene.activeLevelId = active;
    const levels = [...new Set(meshOf(scene).map((f: Face3) => f.levelId))].sort();
    assert.deepEqual(levels, ['lv-1', 'lv-2'], `${active} にいるとき 3D が全階を積んでいない`);
  }
});

// --- 2D の描画 ---

/** 線を引いた点を**ワールド座標で**集める。描く・描かないを座標で確かめる */
function drawnWorldY(scene: Scene, settings: Settings, comments?: CommentAnchor[]): number[] {
  const vp = new Viewport();
  vp.resize(1000, 1000);
  vp.fit({ min: vec(-1000, -1000), max: vec(5000, 10000) });

  const ys: number[] = [];
  const ctx: Record<string, unknown> = {
    measureText: (t: string) => ({ width: t.length * 6 }),
  };
  for (const name of [
    'save', 'restore', 'beginPath', 'closePath', 'rect', 'ellipse',
    'fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'translate',
    'rotate', 'setLineDash',
  ]) {
    ctx[name] = () => {};
  }
  const record = (x: number, y: number) => void ys.push(vp.toWorld(vec(x, y)).y);
  ctx.moveTo = record;
  ctx.lineTo = record;
  // コメントのバッジは円。中心を拾う
  ctx.arc = record;

  render({
    ctx: ctx as unknown as CanvasRenderingContext2D,
    vp,
    scene,
    rooms: detectRooms(scene),
    settings,
    selected: new Set(),
    hover: null,
    comments,
  });
  return ys;
}

/** 1 階は y=0、2 階は y=9000。**座標で階が見分けられる**ように離す */
function twoFloorsApart(): Scene {
  const scene = emptyScene();
  scene.sheet.show = false;
  scene.levels['lv-2'] = { id: 'lv-2', name: '2階', floorZ: 3000, wallHeight: 2400 };

  scene.activeLevelId = DEFAULT_LEVEL_ID;
  addWall(scene, findOrCreateNode(scene, vec(0, 0)), findOrCreateNode(scene, vec(4000, 0)), 120);

  scene.activeLevelId = 'lv-2';
  addWall(scene, findOrCreateNode(scene, vec(0, 9000)), findOrCreateNode(scene, vec(4000, 9000)), 120);
  return scene;
}

/** 格子と下敷きを切った設定。**格子は全面に線を引く**ので、切らないと階が見えない */
const plain = (): Settings => ({ ...defaultSettings(), showGrid: false, showUnderlay: false });

const near = (ys: number[], y: number): boolean => ys.some((v) => Math.abs(v - y) < 200);

test('2D は作業中の階だけを描く', () => {
  const scene = twoFloorsApart();

  scene.activeLevelId = DEFAULT_LEVEL_ID;
  const first = drawnWorldY(scene, plain());
  assert.ok(near(first, 0), '1 階にいるのに 1 階の壁が描かれていない');
  assert.ok(!near(first, 9000), '1 階にいるのに 2 階の壁が描かれている');

  scene.activeLevelId = 'lv-2';
  const second = drawnWorldY(scene, plain());
  assert.ok(near(second, 9000), '2 階にいるのに 2 階の壁が描かれていない');
  assert.ok(!near(second, 0), '2 階にいるのに 1 階の壁が重なって描かれている');
});

test('下の階を薄く敷く（上階を下階に合わせるため）', () => {
  const scene = twoFloorsApart();
  scene.activeLevelId = 'lv-2';

  const withUnderlay = drawnWorldY(scene, { ...plain(), showUnderlay: true });
  assert.ok(near(withUnderlay, 9000), '作業中の階が消えている');
  assert.ok(near(withUnderlay, 0), '下の階が敷かれていない');

  assert.ok(!near(drawnWorldY(scene, plain()), 0), '設定を切っても下の階が出ている');
});

test('いちばん下の階には下敷きを出さない（上の階は敷かない）', () => {
  const scene = twoFloorsApart();
  scene.activeLevelId = DEFAULT_LEVEL_ID;
  const ys = drawnWorldY(scene, { ...plain(), showUnderlay: true });
  assert.ok(near(ys, 0), '作業中の階が消えている');
  assert.ok(!near(ys, 9000), '上の階が下敷きとして出ている');
});

test('下敷きの相手は id の順ではなく床の高さで決まる', () => {
  // **後から足した地下**が、2 階の下敷きになってはいけない
  const scene = twoFloorsApart();
  scene.levels['lv-b1'] = { id: 'lv-b1', name: 'B1', floorZ: -3000, wallHeight: 2400 };
  scene.activeLevelId = 'lv-b1';
  addWall(scene, findOrCreateNode(scene, vec(0, 5000)), findOrCreateNode(scene, vec(4000, 5000)), 120);

  scene.activeLevelId = 'lv-2';
  const ys = drawnWorldY(scene, { ...plain(), showUnderlay: true });
  assert.ok(near(ys, 0), '2 階の下敷きが 1 階になっていない');
  assert.ok(!near(ys, 5000), '2 階の下敷きに地下が出ている');

  scene.activeLevelId = DEFAULT_LEVEL_ID;
  const low = drawnWorldY(scene, { ...plain(), showUnderlay: true });
  assert.ok(near(low, 5000), '1 階の下敷きが地下になっていない');
});

test('他の階のコメントはバッジを出さない', () => {
  // **壁と重ならない高さに置く。** 壁の線を拾ってしまうと、
  // バッジが出ているのか壁が出ているのか見分けられない
  const scene = twoFloorsApart();
  const comments: CommentAnchor[] = [
    { id: 'cm-1', at: point3(2000, 2000, 0), ref: null, levelId: DEFAULT_LEVEL_ID, badge: null },
    { id: 'cm-2', at: point3(2000, 7000, 0), ref: null, levelId: 'lv-2', badge: null },
  ];

  scene.activeLevelId = DEFAULT_LEVEL_ID;
  const first = drawnWorldY(scene, plain(), comments);
  assert.ok(near(first, 2000), '1 階のコメントが出ていない');
  assert.ok(!near(first, 7000), '1 階にいるのに 2 階のコメントが出ている');

  scene.activeLevelId = 'lv-2';
  const second = drawnWorldY(scene, plain(), comments);
  assert.ok(near(second, 7000), '2 階のコメントが出ていない');
  assert.ok(!near(second, 2000), '2 階にいるのに 1 階のコメントが出ている');
});

test('描いていないバッジは掴めない', () => {
  // **描くほうと叩くほうがずれると、見えないものを掴む。**
  // `pickComment` が要るのは comments と viewport と作業中の階だけ
  const scene = twoFloorsApart();
  const vp = new Viewport();
  vp.resize(1000, 1000);
  vp.fit({ min: vec(-1000, -1000), max: vec(5000, 10000) });

  const comments: CommentAnchor[] = [
    { id: 'cm-1', at: point3(2000, 2000, 0), ref: null, levelId: DEFAULT_LEVEL_ID, badge: null },
    { id: 'cm-2', at: point3(2000, 7000, 0), ref: null, levelId: 'lv-2', badge: null },
  ];
  const editor = { comments, viewport: vp, store: { scene } } as unknown as Editor;
  const at = (c: CommentAnchor) => vp.toScreen(vec(c.at.x, c.at.y));

  scene.activeLevelId = DEFAULT_LEVEL_ID;
  assert.equal(pickComment(editor, at(comments[0]))?.id, 'cm-1');
  assert.equal(pickComment(editor, at(comments[1])), null, '1 階で 2 階のバッジを掴めてしまう');

  scene.activeLevelId = 'lv-2';
  assert.equal(pickComment(editor, at(comments[1]))?.id, 'cm-2');
  assert.equal(pickComment(editor, at(comments[0])), null, '2 階で 1 階のバッジを掴めてしまう');
});

test('3D は他の階の構造物も立てる', () => {
  // **`mesh.ts` と同じ取り違えが `fixture3d.ts` にも残っていた。**
  // 「3D に出すか」を `isSnappable`（階を見る）で判定していたので、
  // 作業中でない階の柱・梁・階段が 3D から消えていた
  const scene = emptyScene();
  scene.levels['lv-2'] = { id: 'lv-2', name: '2階', floorZ: 3000, wallHeight: 2400 };
  scene.fixtures['f-up'] = makeFixture('column', { id: 'f-up', levelId: 'lv-2' });

  for (const active of [DEFAULT_LEVEL_ID, 'lv-2']) {
    scene.activeLevelId = active;
    const faces = buildMesh(scene, detectRooms(scene)).filter(
      (f: Face3) => f.ref?.type === 'fixture',
    );
    assert.ok(faces.length > 0, `${active} にいるとき 2 階の柱が 3D から消えている`);
  }
});
