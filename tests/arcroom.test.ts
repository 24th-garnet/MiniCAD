import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, type Id, type Scene } from '../src/core/types.ts';
import { addWall, findOrCreateNode, wallLength } from '../src/core/ops.ts';
import { vec } from '../src/core/geometry.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { sceneToMeasures } from '../src/io/measures.ts';

/**
 * 円弧壁でできた部屋。
 *
 * **数字は手で出せるものと突き合わせる。** 円の面積も半円の面積も閉じた式が
 * あるので、近似に逃げる理由が無い。折れ線に潰して測ると必ず小さく出るので、
 * 「だいたい合っている」では円弧を本物として持った意味が無くなる。
 */

const R = 2000;
/** 半円の膨らみ。tan(π/4) = 1 */
const HALF = 1;

/** 2 つの節点を半円 2 本で結ぶ＝真円の部屋。直径は 2R */
function circleRoom(thickness = 120): { scene: Scene; walls: Id[] } {
  const scene = emptyScene();
  const left = findOrCreateNode(scene, vec(-R, 0));
  const right = findOrCreateNode(scene, vec(R, 0));
  // 下half: left→right を右（下）へ膨らませる。上half: right→left
  const a = addWall(scene, left, right, thickness, undefined, HALF)!;
  const b = addWall(scene, right, left, thickness, undefined, HALF)!;
  return { scene, walls: [a.id, b.id] };
}

test('半円の壁の長さは弧長（前提）', () => {
  const { scene, walls } = circleRoom();
  assert.ok(
    Math.abs(wallLength(scene, scene.walls[walls[0]]) - Math.PI * R) < 1e-6,
    `${wallLength(scene, scene.walls[walls[0]])}`,
  );
});

test('円弧 2 本で部屋になる（直線 3 本という決まりを外す）', () => {
  const { scene } = circleRoom();
  const rooms = detectRooms(scene);
  assert.equal(rooms.length, 1, `検出された部屋 ${rooms.length} 室`);
  assert.equal(rooms[0].wallIds.length, 2);
});

test('真円の部屋の面積が πR²（閉じた式で、折れ線ではない）', () => {
  const { scene } = circleRoom();
  const room = detectRooms(scene)[0];
  const want = (Math.PI * R * R) / 1e6; // m²
  assert.ok(
    Math.abs(room.area - want) < 1e-9,
    `壁芯面積 ${room.area} m²（期待 ${want}）`,
  );
  // **折れ線なら必ず小さく出る。** 近似に戻っていないことの裏取り
  assert.ok(room.area > want - 1e-9, '折れ線の面積になっている');
});

test('内法は同心円弧——半径が壁厚の半分だけ縮む', () => {
  const t = 200;
  const { scene } = circleRoom(t);
  const room = detectRooms(scene)[0];
  const inner = R - t / 2;
  assert.ok(
    Math.abs(room.innerArea - (Math.PI * inner * inner) / 1e6) < 1e-9,
    `内法面積 ${room.innerArea} m²（期待 ${(Math.PI * inner * inner) / 1e6}）`,
  );
  assert.ok(
    Math.abs(room.perimeter - 2 * Math.PI * inner) < 1e-6,
    `内法周長 ${room.perimeter} mm（期待 ${2 * Math.PI * inner}）`,
  );
});

test('半円と直線でできた部屋——弓形のぶんだけ増える', () => {
  // 弦 4000 の上に、下へ膨らむ半円。面積は半円そのもの
  const scene = emptyScene();
  const left = findOrCreateNode(scene, vec(-R, 0));
  const right = findOrCreateNode(scene, vec(R, 0));
  addWall(scene, left, right, 120, undefined, HALF); // 下へ膨らむ半円
  addWall(scene, right, left, 120); // まっすぐ戻る

  const rooms = detectRooms(scene);
  assert.equal(rooms.length, 1, `検出された部屋 ${rooms.length} 室`);
  const want = (Math.PI * R * R) / 2 / 1e6;
  assert.ok(
    Math.abs(rooms[0].area - want) < 1e-9,
    `面積 ${rooms[0].area} m²（期待 ${want}）`,
  );
});

test('四角い部屋の一辺を円弧にすると、膨らんだぶんだけ広くなる', () => {
  const build = (bulge: number): Scene => {
    const scene = emptyScene();
    const c = [vec(0, 0), vec(4000, 0), vec(4000, 4000), vec(0, 4000)].map((p) =>
      findOrCreateNode(scene, p),
    );
    for (let i = 0; i < 4; i++) {
      // 0 番目の辺（下辺、左→右）だけ外（下）へ膨らませる
      addWall(scene, c[i], c[(i + 1) % 4], 120, undefined, i === 0 ? bulge : 0);
    }
    return scene;
  };
  const flat = detectRooms(build(0))[0];
  // 膨らみ 0.5 → 掃過角 4·atan(0.5) ≈ 1.8546 rad
  const bowed = detectRooms(build(0.5))[0];

  const sweep = 4 * Math.atan(0.5);
  const radius = 4000 / (2 * Math.sin(sweep / 2));
  const cap = ((radius * radius) / 2) * (sweep - Math.sin(sweep)) / 1e6;

  assert.ok(
    Math.abs(bowed.area - (flat.area + cap)) < 1e-9,
    `円弧側 ${bowed.area} / 直線側 ${flat.area} / 弓形 ${cap}`,
  );
  assert.ok(bowed.area > flat.area, '外へ膨らませたのに広くなっていない');
});

test('内側へ膨らませると狭くなる', () => {
  const build = (bulge: number): Scene => {
    const scene = emptyScene();
    const c = [vec(0, 0), vec(4000, 0), vec(4000, 4000), vec(0, 4000)].map((p) =>
      findOrCreateNode(scene, p),
    );
    for (let i = 0; i < 4; i++) {
      addWall(scene, c[i], c[(i + 1) % 4], 120, undefined, i === 0 ? bulge : 0);
    }
    return scene;
  };
  const flat = detectRooms(build(0))[0];
  const dented = detectRooms(build(-0.5))[0];
  assert.ok(dented.area < flat.area, `${dented.area} < ${flat.area} でない`);
  assert.ok(
    Math.abs((flat.area - dented.area) - (detectRooms(build(0.5))[0].area - flat.area)) < 1e-9,
    '膨らませた分と凹ませた分が釣り合っていない',
  );
});

test('数量の周長も弧長で出る', () => {
  const t = 200;
  const { scene } = circleRoom(t);
  const file = sceneToMeasures(scene, detectRooms(scene), { planId: 'p-1' });
  assert.equal(file.rooms.length, 1);
  const inner = R - t / 2;
  assert.equal(file.rooms[0].perimeter, Math.round(2 * Math.PI * inner));
});

test('同じ 2 点を結ぶ 3 本（上弧・下弧・直線）が 2 室に分かれる', () => {
  // **弦の向きでは並べられない。** 3 本とも弦は同じ向きなので、節点の周りの
  // 並びが決まらず、面の辿りが隣へ飛ぶ。分けられるのは**接線**だけ。
  const scene = emptyScene();
  const left = findOrCreateNode(scene, vec(-R, 0));
  const right = findOrCreateNode(scene, vec(R, 0));
  addWall(scene, left, right, 120, undefined, HALF);  // 下へ膨らむ半円
  addWall(scene, left, right, 120, undefined, -HALF); // 上へ膨らむ半円
  addWall(scene, left, right, 120);                   // まっすぐ

  const rooms = detectRooms(scene);
  assert.equal(rooms.length, 2, `検出された部屋 ${rooms.length} 室`);

  const half = (Math.PI * R * R) / 2 / 1e6;
  for (const room of rooms) {
    assert.ok(
      Math.abs(room.area - half) < 1e-9,
      `半円の部屋のはずが ${room.area} m²（期待 ${half}）`,
    );
    assert.equal(room.wallIds.length, 2, '1 室が 2 本の壁で囲まれていない');
  }
  // 上と下で違う壁を使っている
  assert.notDeepEqual(rooms[0].wallIds.slice().sort(), rooms[1].wallIds.slice().sort());
});

test('円弧に接する直線は、曲がり方で並び分ける', () => {
  // **節点から出る向きがまったく同じ 2 本。** 直線 o→東と、o で東を向いて
  // 左へ曲がる半円 o→北。接線だけでは並び順が決まらないので、
  // 曲がり方（符号つき曲率）で分ける。左へ曲がるほうが後。
  const scene = emptyScene();
  const o = findOrCreateNode(scene, vec(0, 0));
  const east = findOrCreateNode(scene, vec(4000, 0));
  const north = findOrCreateNode(scene, vec(0, 4000));

  // **円弧を先に作る。** 節点に登録される順も円弧が先になるので、
  // 並べ替えが何もしなければ円弧が先のまま残る——曲がり方で並べ直して
  // いることが、ここで初めて見える
  // 中心 (0,2000)・半径 2000 の半円。o での接線は東を向く
  addWall(scene, o, north, 120, undefined, HALF);
  addWall(scene, o, east, 120);
  addWall(scene, east, north, 120);
  // **節点に 3 本目を足す。** 同点の 2 本しか無いと、どちらが先でも
  // 「もう一方」しか選べず、並べ替えの正しさが見えない
  addWall(scene, o, findOrCreateNode(scene, vec(-3000, 0)), 120);

  const rooms = detectRooms(scene);
  assert.equal(rooms.length, 1, `検出された部屋 ${rooms.length} 室`);
  // 三角形 8 m² から、内側へ張り出した半円 π·2²/2·... = 2π m² を引いたもの
  const want = 8 - Math.PI * 2;
  assert.ok(
    Math.abs(rooms[0].area - want) < 1e-9,
    `面積 ${rooms[0].area} m²（期待 ${want}）`,
  );
  // **囲んでいる壁は 3 本。** 並べ替えを誤ると行き止まりの壁へ逸れ、
  // 出て戻るぶんが `wallIds` に二重に入る。面積は変わらない（往復で消える）が、
  // 数量では**その壁の面積が部屋に足される**ので、ここで押さえる
  assert.deepEqual(
    rooms[0].wallIds.length, 3,
    `囲んでいる壁 ${rooms[0].wallIds.length} 本（行き止まりへ逸れている）`,
  );
});
