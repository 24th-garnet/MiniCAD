import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultCamera,
  projectPoint,
  viewProjection,
  type View,
} from '../src/render3d/camera.ts';
import { vec3, type Vec3 } from '../src/render3d/mat4.ts';
import { polygonFace, type Face3 } from '../src/render3d/mesh.ts';
import {
  SNAP3D_KINDS,
  snap3dCandidates,
  type Snap3DKind,
} from '../src/render3d/snap3d.ts';

/**
 * 3D の吸着。**画面の画素で測ること**が肝心。
 *
 * 世界の mm で測ると、同じ 100mm でも手前の壁と奥の壁では画面上の近さが
 * まるで違い、**奥の角に強く吸い寄せられる**ことになる。
 */

const W = 800;
const H = 600;

/** 真上から見下ろすカメラ。投影が素直で、試験の期待値が読める */
function viewOf(distance: number): View {
  const cam = defaultCamera();
  cam.target = vec3(0, 0, 0);
  cam.yaw = 0;
  // ほぼ真上。1.57 ちょうどは基底が潰れるので少し手前
  cam.pitch = 1.5;
  cam.distance = distance;
  return viewProjection(cam, W, H);
}

const topView = (): View => viewOf(10000);

const SRC = { ref: null, levelId: 'L1' };

/** z=0 の正方形 1 枚。角は (±1000, ±1000) */
const square = (): Face3 =>
  polygonFace(
    [vec3(-1000, -1000, 0), vec3(1000, -1000, 0), vec3(1000, 1000, 0), vec3(-1000, 1000, 0)],
    '#888',
    'floor',
    SRC,
  );

const at = (view: View, p: Vec3) => {
  const s = projectPoint(view, p, W, H);
  assert.ok(s, '画面に出ない点を狙っている');
  return s;
};

const kindsAt = (mesh: Face3[], view: View, p: Vec3): Snap3DKind[] =>
  snap3dCandidates(mesh, view, W, H, at(view, p)).map((c) => c.kind);

test('角を狙うと、頂点がいちばん上に来る', () => {
  const view = topView();
  const corner = vec3(1000, 1000, 0);
  const got = snap3dCandidates([square()], view, W, H, at(view, corner));
  assert.ok(got.length > 0, '候補が 1 つも出ていない');
  assert.equal(got[0].kind, 'vertex', `先頭が頂点でない: ${got[0].kind}`);
  assert.ok(
    Math.hypot(got[0].at.x - corner.x, got[0].at.y - corner.y, got[0].at.z - corner.z) < 1e-6,
    `角そのものに吸っていない: ${JSON.stringify(got[0].at)}`,
  );
});

test('辺の真ん中を狙うと、辺の中点が取れる', () => {
  const view = topView();
  const kinds = kindsAt([square()], view, vec3(1000, 0, 0));
  assert.ok(kinds.includes('midpoint'), `辺の中点が出ていない: ${kinds}`);
  // **頂点は 1000mm 先にあるので、出てはいけない**
  assert.ok(!kinds.includes('vertex'), `離れた頂点まで吸っている: ${kinds}`);
});

test('面の真ん中を狙うと、面の中心が取れる', () => {
  const view = topView();
  const kinds = kindsAt([square()], view, vec3(0, 0, 0));
  assert.ok(kinds.includes('faceCenter'), `面の中心が出ていない: ${kinds}`);
});

test('どこからも遠ければ、候補は 1 つも出ない', () => {
  const view = topView();
  // 正方形のはるか外側
  const got = snap3dCandidates([square()], view, W, H, at(view, vec3(4000, 4000, 0)));
  assert.equal(got.length, 0, `遠いのに吸っている: ${JSON.stringify(got)}`);
});

test('面が角を共有していても、同じ角は 1 つにまとまる', () => {
  const view = topView();
  // 角 (1000, 1000) を共有する 2 枚目
  const second = polygonFace(
    [vec3(1000, 1000, 0), vec3(3000, 1000, 0), vec3(3000, 3000, 0), vec3(1000, 3000, 0)],
    '#888',
    'floor',
    SRC,
  );
  const corner = vec3(1000, 1000, 0);
  const got = snap3dCandidates([square(), second], view, W, H, at(view, corner));
  const vertices = got.filter((c) => c.kind === 'vertex');
  // **壁 1 本でも面は 6 枚出る。** まとめないと同じ角が何度も候補に並ぶ
  assert.equal(vertices.length, 1, `同じ角が ${vertices.length} 個出ている`);
});

test('優先順は種別の並びどおり', () => {
  const view = topView();
  // 角を狙えば、頂点・辺の上・（近ければ）中点が混ざる
  const got = snap3dCandidates([square()], view, W, H, at(view, vec3(1000, 1000, 0)));
  const order = got.map((c) => SNAP3D_KINDS.indexOf(c.kind));
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] >= order[i - 1], `並びが崩れている: ${got.map((c) => c.kind)}`);
  }
});

test('辺の上は、端では出さない（そこは頂点の仕事）', () => {
  const view = topView();
  // 角から少しだけ内側。頂点にも辺にも近い
  const got = snap3dCandidates([square()], view, W, H, at(view, vec3(1000, 980, 0)));
  const edge = got.filter((c) => c.kind === 'edge');
  for (const e of edge) {
    // 端から 2% 以内には出さない決まり
    const t = (e.at.y + 1000) / 2000;
    assert.ok(t > 0.01 && t < 0.99, `端に辺の上が出ている: t=${t}`);
  }
});

test('画面で測る — 同じ世界の距離でも、遠ければ候補に入り、近ければ外れる', () => {
  /*
   * **これがこの作りの眼目。** 2D の吸着は世界の mm で測るが、3D では
   * 使えない——同じ 100mm でも、手前の壁と奥の壁では画面上の近さが
   * まるで違う。世界で測ると**奥の角に強く吸い寄せられる**。
   *
   * 同じ正方形を、カメラから近いところと遠いところに置き、**どちらも
   * 角から 300mm 離れた点**を狙う。画面で測っているなら、近いほうは
   * 300mm が大きく見えて外れ、遠いほうは小さく見えて入るはず。
   */
  const sq = square();
  const corner = vec3(1000, 1000, 0);

  const near = viewOf(2600);
  const far = viewOf(26000);

  const px = (view: View, a: Vec3, b: Vec3): number => {
    const sa = at(view, a);
    const sb = at(view, b);
    return Math.hypot(sa.x - sb.x, sa.y - sb.y);
  };
  const aimPoint = vec3(1000, 700, 0); // 角から 300mm

  // **前提を先に確かめる。** 画面の離れ方が実際に逆転していること
  const nearPx = px(near, corner, aimPoint);
  const farPx = px(far, corner, aimPoint);
  assert.ok(nearPx > 12, `近い側で 300mm が ${nearPx.toFixed(1)}px（12px 超のはず）`);
  assert.ok(farPx < 12, `遠い側で 300mm が ${farPx.toFixed(1)}px（12px 未満のはず）`);

  const nearKinds = snap3dCandidates([sq], near, W, H, at(near, aimPoint))
    .filter((c) => c.kind === 'vertex');
  const farKinds = snap3dCandidates([sq], far, W, H, at(far, aimPoint))
    .filter((c) => c.kind === 'vertex');

  assert.equal(nearKinds.length, 0, '近い側で、画面では遠い角に吸っている');
  assert.equal(farKinds.length, 1, '遠い側で、画面では近い角に吸えていない');
});

test('画面で近い角が 2 つあれば、どちらも候補に出る（Tab で送れる）', () => {
  /*
   * 重なって見える角は、手前のものしか選べないと目的の点に触れない。
   * **候補を 1 つに絞らない**のはそのため（AutoCAD も Tab で送る）。
   */
  const view = viewOf(26000);
  // 100mm しか離れていない 2 つの角。遠くから見れば数 px
  const a = polygonFace(
    [vec3(0, 0, 0), vec3(1000, 0, 0), vec3(1000, 1000, 0), vec3(0, 1000, 0)],
    '#888', 'floor', SRC,
  );
  const b = polygonFace(
    [vec3(1100, 0, 0), vec3(2100, 0, 0), vec3(2100, 1000, 0), vec3(1100, 1000, 0)],
    '#888', 'floor', SRC,
  );
  const got = snap3dCandidates([a, b], view, W, H, at(view, vec3(1050, 1000, 0)));
  const vertices = got.filter((c) => c.kind === 'vertex');
  assert.equal(vertices.length, 2, `送れる角が ${vertices.length} 個（2 つのはず）`);
  // 近い順に並んでいること
  assert.ok(vertices[0].dist <= vertices[1].dist, '近い順になっていない');
});
