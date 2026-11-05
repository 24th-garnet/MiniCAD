import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIXTURE_KINDS,
  FIXTURE_SPECS,
  isTilted,
  localOutline,
  outline,
  toWorld,
  toWorld3,
  type Fixture,
  type FixtureKind,
} from "../src/core/fixture.ts";
import { deserialize, serialize } from "../src/io/scene.ts";
import { defaultAttrs } from "../src/core/attrs.ts";
import { DEFAULT_LEVEL_ID, defaultLevel } from "../src/core/level.ts";
import {
  convexHull,
  cross,
  signedArea,
  sub,
  vec,
  type Vec,
} from "../src/core/geometry.ts";
import { emptyScene, type Scene } from "../src/core/types.ts";

/**
 * 立体の傾き（第 5 版の 1 段目）。
 *
 * **ワイヤーのオブジェクト編集パネルが回転 X / Y / Z の 3 行を持っている。**
 * z は `angle` が持っているので、足すのは x と y。
 *
 * ここでいちばん大事なのは **「傾きなしの道が、入れる前と同じ」** こと。
 * 柱・階段・出窓・ソリッド・押し出し・ブーリアン・稜線の仕上げが既に動いていて、
 * 800 件近いテストがそれを押さえている。
 */

function make(kind: FixtureKind, over: Partial<Fixture> = {}): Fixture {
  const spec = FIXTURE_SPECS[kind];
  return {
    id: "f",
    kind,
    x: 0,
    y: 0,
    angle: 0,
    tilt: null,
    size: { ...spec.defaultSize },
    outline: null,
    combine: null,
    edge: null,
    base: 0,
    height: 1000,
    label: spec.defaultLabel,
    layerId: spec.defaultLayer,
    levelId: DEFAULT_LEVEL_ID,
    attrs: defaultAttrs(),
    ...over,
  };
}

const near = (a: number, b: number, eps = 1e-9): boolean =>
  Math.abs(a - b) < eps;

test("傾きなしなら、これまでと同じ平面の点を返す", () => {
  // **ここが土台。** 既にあるものに回帰が出ないことを、式で押さえる
  for (const angle of [0, 0.7, Math.PI / 2, -1.3]) {
    const f = make("box", { x: 1200, y: -800, angle });
    for (const p of [vec(0, 0), vec(300, 0), vec(-250, 450)]) {
      const got = toWorld(f, p);
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      assert.ok(
        near(got.x, p.x * c - p.y * s + 1200),
        `x が違う (angle=${angle})`,
      );
      assert.ok(
        near(got.y, p.x * s + p.y * c - 800),
        `y が違う (angle=${angle})`,
      );
    }
  }
});

test("傾きなしなら、3 次元でも z が素通しになる", () => {
  const f = make("box", { x: 500, y: 500, angle: 0.4 });
  for (const z of [0, 600, -200]) {
    const got = toWorld3(f, vec(100, 200), z);
    assert.equal(got.z, z, "高さが変わった");
    const flat = toWorld(f, vec(100, 200));
    assert.ok(
      near(got.x, flat.x) && near(got.y, flat.y),
      "平面の位置が 2D と食い違う",
    );
  }
});

test("x 軸まわりに 90 度倒すと、ローカルの y が高さになる", () => {
  const f = make("box", { tilt: { x: Math.PI / 2, y: 0 } });
  const got = toWorld3(f, vec(0, 100), 0);
  assert.ok(near(got.x, 0), `x が ${got.x}`);
  assert.ok(near(got.y, 0, 1e-9), `y が ${got.y}`);
  assert.ok(near(got.z, 100), `z が ${got.z}`);
});

test("y 軸まわりに 90 度倒すと、ローカルの高さが x になる", () => {
  const f = make("box", { tilt: { x: 0, y: Math.PI / 2 } });
  const got = toWorld3(f, vec(0, 0), 100);
  assert.ok(near(got.x, 100), `x が ${got.x}`);
  assert.ok(near(got.z, 0, 1e-9), `z が ${got.z}`);
});

test("傾けたあとに z 軸でも回る（順序が決まっている）", () => {
  // ローカル → ワールドは Rz(angle) · Ry(tilt.y) · Rx(tilt.x)。
  // y で倒してから z で 90 度回すと、x へ出たものが y へ移る
  const f = make("box", { angle: Math.PI / 2, tilt: { x: 0, y: Math.PI / 2 } });
  const got = toWorld3(f, vec(0, 0), 100);
  assert.ok(near(got.x, 0, 1e-9), `x が ${got.x}`);
  assert.ok(near(got.y, 100), `y が ${got.y}`);
});

test("傾きは長さを変えない（回転なので）", () => {
  const f = make("box", { tilt: { x: 0.6, y: -0.9 }, angle: 1.1, x: 0, y: 0 });
  const cases: { p: Vec; z: number }[] = [
    { p: vec(300, 400), z: 0 },
    { p: vec(0, 0), z: 500 },
    { p: vec(-120, 80), z: -90 },
  ];
  for (const { p, z } of cases) {
    const got = toWorld3(f, p, z);
    const before = Math.hypot(p.x, p.y, z);
    const after = Math.hypot(got.x, got.y, got.z);
    assert.ok(near(before, after, 1e-6), `${before} → ${after}`);
  }
});

test("0 と 0 の傾きは「傾きなし」と同じ", () => {
  assert.equal(isTilted(make("box")), false);
  assert.equal(isTilted(make("box", { tilt: { x: 0, y: 0 } })), false);
  assert.equal(isTilted(make("box", { tilt: { x: 0.1, y: 0 } })), true);
});

function sceneWith(f: Fixture): Scene {
  const scene = emptyScene();
  scene.fixtures[f.id] = f;
  return scene;
}

test("傾きが JSON の往復を生き延びる", () => {
  const scene = sceneWith(make("box", { tilt: { x: 0.3, y: -1.2 } }));
  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.deepEqual(back.fixtures.f, scene.fixtures.f, "往復で変わった");
});

test("欄が無い古いファイルは傾きなしになる", () => {
  // **移行の処理を持たない。** 欄が無ければ null に倒れる
  const scene = sceneWith(make("box"));
  const raw = JSON.parse(JSON.stringify(serialize(scene)));
  delete raw.scene.fixtures.f.tilt;
  assert.equal(deserialize(raw).fixtures.f.tilt, null);

  // 壊れた値も傾きなしへ
  raw.scene.fixtures.f.tilt = "ななめ";
  assert.equal(deserialize(raw).fixtures.f.tilt, null);
  raw.scene.fixtures.f.tilt = { x: 0, y: 0 };
  assert.equal(deserialize(raw).fixtures.f.tilt, null, "0 と 0 は畳む");
});

// --- ここから 2 段目（3D をローカルで組んで、出口で 1 回だけ移す） ---

import {
  buildFixtureFaces,
  fixtureFingerprint,
} from "../src/render3d/fixture3d.ts";
import { combineFingerprint, combineFixtures } from "../src/core/combine.ts";
import { rotate } from "../src/core/geometry.ts";
import type { Face3 } from "../src/render3d/mesh.ts";
import type { Vec3 } from "../src/render3d/mat4.ts";

const facesOf = (f: Fixture): Face3[] => {
  const scene = emptyScene();
  scene.fixtures[f.id] = f;
  const out: Face3[] = [];
  buildFixtureFaces(scene, f.id, out);
  return out;
};

test("傾き無しなら、置いた場所と向きは「z で回して動かす」だけ", () => {
  // **2 段目の土台。** ビルダーはローカルで組み、出口で 1 回だけ移す。
  // 傾きが無いとき、その変換が「z まわりの回転＋平行移動」に退化することを見る。
  // ここが崩れると、既にある柱・階段・出窓・ソリッドが静かにずれる
  const angle = -1.3;
  const dx = 1200;
  const dy = -800;
  for (const kind of FIXTURE_KINDS) {
    const origin = facesOf(make(kind, { x: 0, y: 0, angle: 0 }));
    const moved = facesOf(make(kind, { x: dx, y: dy, angle }));
    assert.equal(moved.length, origin.length, `${kind}: 面の数が変わった`);

    for (const [i, face] of origin.entries()) {
      assert.equal(
        moved[i].points.length,
        face.points.length,
        `${kind}: 頂点の数が違う`,
      );
      for (const [j, p] of face.points.entries()) {
        const want = rotate(vec(p.x, p.y), angle);
        const got = moved[i].points[j];
        assert.ok(
          near(got.x, want.x + dx, 1e-6) && near(got.y, want.y + dy, 1e-6),
          `${kind}: 面 ${i} の頂点 ${j} が合わない`,
        );
        assert.ok(near(got.z, p.z, 1e-9), `${kind}: 高さが変わった`);
      }
    }
  }
});

test("傾けると立体が倒れ、底面は置いた足元に残る", () => {
  // 傾きの軸は**底面の中心**。梁のように高いところにあるものを倒しても、
  // 足元が動かないので遠くへ飛んでいかない
  const f = make("box", {
    x: 2000,
    y: 1000,
    base: 500,
    height: 1000,
    tilt: { x: Math.PI / 2, y: 0 },
  });
  const zs = facesOf(f).flatMap((x) => x.points.map((p) => p.z));
  // 90 度倒したので、高さの広がりは「幅」になる（600 の箱なら 600）
  assert.ok(
    near(
      Math.max(...zs) - Math.min(...zs),
      FIXTURE_SPECS.box.defaultSize.h,
      1e-6,
    ),
    `高さの広がりが ${Math.max(...zs) - Math.min(...zs)}`,
  );
  // 足元（底面の中心）の高さは変わらない
  assert.ok(Math.min(...zs) <= 500 + 1e-6, "足元より下に出ていない");
});

/** 有向の稜線。`a→b` と `b→a` が 1 本ずつなら水密で向きが揃っている */
function edgeProblems(faces: readonly Face3[]): number {
  const key = (p: Vec3): string =>
    `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
  const counts = new Map<string, number>();
  for (const f of faces) {
    for (let i = 0; i < f.points.length; i++) {
      const k = `${key(f.points[i])}|${key(f.points[(i + 1) % f.points.length])}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [k, n] of counts) {
    const [a, b] = k.split("|");
    if (n !== 1 || !counts.has(`${b}|${a}`)) bad += 1;
  }
  return bad;
}

test("傾けても立体は水密のまま", () => {
  // 回転は形を変えないので、倒しても稜線の繋がりは崩れないはず
  for (const kind of [
    "box",
    "prism",
    "cylinder",
    "cone",
    "sphere",
    "dome",
    "cylinderH",
  ] as FixtureKind[]) {
    for (const tilt of [
      { x: 0.4, y: 0 },
      { x: 0, y: -0.9 },
      { x: 0.6, y: 1.1 },
    ]) {
      const faces = facesOf(make(kind, { tilt, angle: 0.3 }));
      assert.equal(
        edgeProblems(faces),
        0,
        `${kind} を (${tilt.x}, ${tilt.y}) 倒すと水密でない`,
      );
    }
  }
});

test("傾けても法線は外を向く", () => {
  // **裏返ると `rayFace` が背面として弾き、拾えなくなる**
  for (const kind of [
    "box",
    "prism",
    "cylinder",
    "cone",
    "sphere",
    "dome",
  ] as FixtureKind[]) {
    const faces = facesOf(
      make(kind, { tilt: { x: 0.6, y: -0.8 }, angle: 1.1 }),
    );
    const all = faces.flatMap((x) => x.points);
    const c = {
      x: all.reduce((s, p) => s + p.x, 0) / all.length,
      y: all.reduce((s, p) => s + p.y, 0) / all.length,
      z: all.reduce((s, p) => s + p.z, 0) / all.length,
    };
    for (const face of faces) {
      const m = face.points.reduce(
        (s, p) => ({
          x: s.x + p.x / face.points.length,
          y: s.y + p.y / face.points.length,
          z: s.z + p.z / face.points.length,
        }),
        { x: 0, y: 0, z: 0 },
      );
      const d =
        face.normal.x * (m.x - c.x) +
        face.normal.y * (m.y - c.y) +
        face.normal.z * (m.z - c.z);
      assert.ok(d > 0, `${kind}: 内を向いた面がある (${d.toFixed(1)})`);
    }
    // 回しただけなので、法線の長さは 1 のまま
    for (const face of faces) {
      const n = Math.hypot(face.normal.x, face.normal.y, face.normal.z);
      assert.ok(near(n, 1, 1e-9), `${kind}: 法線の長さが ${n}`);
    }
  }
});

test("傾きを変えると指紋が 2 つとも変わる", () => {
  // **片方を忘れると、ブーリアンの相手を倒しても 3D が作り直されない**
  const scene = emptyScene();
  scene.fixtures.a = make("box", { id: "a", size: { w: 1000, h: 1000 } });
  scene.fixtures.b = make("box", {
    id: "b",
    x: 500,
    size: { w: 1000, h: 1000 },
  });

  const plain = fixtureFingerprint(scene, "a");
  scene.fixtures.a.tilt = { x: 0.3, y: 0 };
  assert.notEqual(
    fixtureFingerprint(scene, "a"),
    plain,
    "母体を倒しても指紋が同じ",
  );

  scene.fixtures.a.tilt = null;
  combineFixtures(scene, ["a", "b"], "subtract");
  const before = combineFingerprint(scene.fixtures.a);
  scene.fixtures.a.combine!.parts[0].tilt = { x: 0, y: 0.5 };
  assert.notEqual(
    combineFingerprint(scene.fixtures.a),
    before,
    "相手を倒しても指紋が同じ",
  );
  assert.notEqual(
    fixtureFingerprint(scene, "a"),
    fixtureFingerprint(scene, "b"),
  );
});

// ---------------------------------------------------------------------------
// 上から見た形（第 5 版の 3 段目）
// ---------------------------------------------------------------------------

/** 反時計回りで、へこみも自己交差も無いこと */
function assertSimpleConvexCcw(poly: Vec[], what: string): void {
  assert.ok(poly.length >= 3, `${what}: 多角形になっていない`);
  assert.ok(
    signedArea(poly) > 0,
    `${what}: 反時計回りでない（面積 ${signedArea(poly)}）`,
  );
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = poly[(i + 2) % poly.length];
    const turn = cross(sub(b, a), sub(c, b));
    assert.ok(turn > -1e-6, `${what}: ${i} 番目でへこんでいる（${turn}）`);
  }
}

test("傾いていなければ、輪郭はこれまでと同じ多角形", () => {
  // **3 段目の回帰の砦。** 2D の呼び手 11 箇所が全部ここを通る
  for (const kind of FIXTURE_KINDS) {
    for (const angle of [0, 0.9, -2.1]) {
      const f = make(kind, { x: 700, y: -1300, angle });
      const got = outline(f);
      const want = localOutline(f).map((p) => ({
        x: p.x * Math.cos(angle) - p.y * Math.sin(angle) + f.x,
        y: p.x * Math.sin(angle) + p.y * Math.cos(angle) + f.y,
      }));
      assert.equal(got.length, want.length, `${kind}: 頂点の数が変わった`);
      got.forEach((p, i) => {
        assert.ok(
          near(p.x, want[i].x) && near(p.y, want[i].y),
          `${kind}: ${i} 番目がずれた`,
        );
      });
    }
  }
});

test("傾けても、輪郭は単純な凸多角形のまま", () => {
  // `pointInPolygon`・`signedArea`・図面範囲が、これに寄りかかっている
  for (const kind of FIXTURE_KINDS) {
    for (const tilt of [
      { x: 0.4, y: 0 },
      { x: 0, y: -0.8 },
      { x: 0.6, y: 0.5 },
    ]) {
      const f = make(kind, { x: -400, y: 900, angle: 1.1, tilt });
      assertSimpleConvexCcw(outline(f), `${kind} tilt(${tilt.x}, ${tilt.y})`);
    }
  }
});

test("90 度倒した角柱の投影は、幅 × 高さ の矩形", () => {
  // x まわりに 90 度倒すと (x, y, z) → (x, -z, y)。奥行きが潰れて高さが出る
  const f = make("box", {
    size: { w: 400, h: 200 },
    height: 1000,
    tilt: { x: Math.PI / 2, y: 0 },
  });
  const poly = outline(f);
  assertSimpleConvexCcw(poly, "倒した箱");
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  assert.ok(near(Math.max(...xs) - Math.min(...xs), 400), "幅が 400 でない");
  assert.ok(
    near(Math.max(...ys) - Math.min(...ys), 1000),
    "高さが 1000 になっていない",
  );
  assert.equal(poly.length, 4, "矩形になっていない");
});

test("高さが階に追従する種別は、階を渡すと投影が変わる", () => {
  // **階を渡せる呼び手は渡す。** 柱は `height` を持たず階高で立つ
  const f = make("column", { height: null, tilt: { x: Math.PI / 2, y: 0 } });
  const low = { ...defaultLevel(), wallHeight: 2400 };
  const high = { ...defaultLevel(), wallHeight: 4000 };
  const spanY = (poly: Vec[]): number =>
    Math.max(...poly.map((p) => p.y)) - Math.min(...poly.map((p) => p.y));
  assert.ok(near(spanY(outline(f, low)), 2400), "既定の階高が出ていない");
  assert.ok(
    near(spanY(outline(f, high)), 4000),
    "階を渡しても投影が変わらない",
  );
});

test("凸包は、内側の点を捨てて反時計回りで返す", () => {
  const hull = convexHull([
    vec(0, 0),
    vec(10, 0),
    vec(10, 10),
    vec(0, 10),
    vec(5, 5),
    vec(2, 8),
    vec(9, 1), // 中の点
  ]);
  assert.equal(hull.length, 4, "中の点が残っている");
  assert.ok(signedArea(hull) > 0, "反時計回りでない");
  assert.ok(near(Math.abs(signedArea(hull)), 100), "面積が合わない");

  // 辺の上に乗った点も捨てる
  assert.equal(
    convexHull([vec(0, 0), vec(5, 0), vec(10, 0), vec(0, 10)]).length,
    3,
  );
  // 重なった点は 1 つに
  assert.equal(convexHull([vec(0, 0), vec(0, 0), vec(1, 0)]).length, 2);
});
