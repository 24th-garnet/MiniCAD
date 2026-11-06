import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPush,
  pushAxis,
  pushRefusal,
  pushTargetOf,
  MIN_PUSH_SIZE,
} from "../src/core/push.ts";
import { extrudeShapes } from "../src/core/extrude.ts";
import {
  baseOf,
  localOutline,
  FIXTURE_SPECS,
  outline,
  rotateToWorld,
  toWorld3,
  type Fixture,
  type FixtureKind,
} from "../src/core/fixture.ts";
import { addWall, findOrCreateNode } from "../src/core/ops.ts";
import { defaultAttrs } from "../src/core/attrs.ts";
import {
  activeLevel,
  defaultLevel,
  DEFAULT_LEVEL_ID,
} from "../src/core/level.ts";
import { LAYER_IDS } from "../src/core/layer.ts";
import { rotate, vec, type Vec, type Vec3Like } from "../src/core/geometry.ts";
import { emptyScene, type Scene } from "../src/core/types.ts";

/**
 * プッシュ/プル（20 段）。**壁の天端を掴んで高さを変える操作の一般化。**
 *
 * 書くのは数値 1〜2 個だけで、ノードも輪郭も動かさない。
 * ここで見るのは「反対側の面が動かないこと」——押し引きの意味そのもの。
 */

const UP = { x: 0, y: 0, z: 1 };
const DOWN = { x: 0, y: 0, z: -1 };

function sceneWith(
  kind: FixtureKind,
  over: Partial<Fixture> = {},
): { scene: Scene; f: Fixture } {
  const scene = emptyScene();
  const spec = FIXTURE_SPECS[kind];
  const f: Fixture = {
    id: "f",
    kind,
    x: 0,
    y: 0,
    angle: 0,
    size: { ...spec.defaultSize },
    tilt: null,
    outline: null,
    combine: null,
    edge: null,
    base: null,
    height: null,
    label: spec.defaultLabel,
    layerId: spec.defaultLayer,
    levelId: DEFAULT_LEVEL_ID,
    attrs: defaultAttrs(),
    ...over,
  };
  scene.fixtures.f = f;
  return { scene, f };
}

const FIXTURE = { type: "fixture" as const, id: "f" };

test("上面を押すと背が伸び、下端は動かない", () => {
  const { scene, f } = sceneWith("box", { base: 300, height: 600 });
  const t = pushTargetOf(scene, FIXTURE, UP)!;
  assert.equal(t.what, "top");
  assert.ok(applyPush(scene, t, 400));
  assert.equal(f.height, 1000);
  assert.equal(f.base, 300, "下端が動いた");
});

test("下面を押すと下端が下がり、上端は動かない", () => {
  const { scene, f } = sceneWith("box", { base: 300, height: 600 });
  const t = pushTargetOf(scene, FIXTURE, DOWN)!;
  assert.equal(t.what, "bottom");
  // 外向き（下）へ 400 押す
  assert.ok(applyPush(scene, t, 400));
  assert.equal(f.base, -100, "下端が下がっていない");
  assert.equal(f.height, 1000);
  assert.equal(f.base! + f.height!, 900, "上端が動いた");
});

test("同じドラッグ中に何度当てても積み上がらない", () => {
  // **掴んだ時点の値からの差**で計算する。ドラッグ中は毎フレーム呼ばれる
  const { scene, f } = sceneWith("box", { base: 0, height: 600 });
  const t = pushTargetOf(scene, FIXTURE, UP)!;
  applyPush(scene, t, 100);
  applyPush(scene, t, 100);
  applyPush(scene, t, 250);
  assert.equal(f.height, 850);
});

test("矩形の側面を押すと、反対側の面は動かない（回っていても）", () => {
  for (const angle of [0, 0.7, Math.PI / 2, -1.3]) {
    const { scene, f } = sceneWith("box", { angle, size: { w: 600, h: 400 } });
    // ローカル +x の面。ワールドの法線は angle だけ回っている
    const n = rotate(vec(1, 0), angle);
    const t = pushTargetOf(scene, FIXTURE, { x: n.x, y: n.y, z: 0 })!;
    assert.equal(t.what, "side");
    assert.equal(t.axis, "x");
    assert.equal(t.sign, 1);

    const before = far(outline(f), vec(-n.x, -n.y));
    applyPush(scene, t, 300);
    assert.equal(f.size.w, 900, "幅が伸びていない");
    assert.equal(f.size.h, 400, "関係のない向きまで変わった");
    const after = far(outline(f), vec(-n.x, -n.y));
    assert.ok(
      Math.hypot(after.x - before.x, after.y - before.y) < 1e-6,
      `角度 ${angle}: 反対側の面が動いた`,
    );
  }
});

/** `dir` の向きにいちばん遠い頂点。反対側の面が動いていないかを見る */
function far(poly: Vec[], dir: Vec): Vec {
  return poly.reduce((best, p) =>
    p.x * dir.x + p.y * dir.y > best.x * dir.x + best.y * dir.y ? p : best,
  );
}

test("ローカル -x の面を押しても、反対側は動かない", () => {
  const { scene, f } = sceneWith("box", { size: { w: 600, h: 400 } });
  const t = pushTargetOf(scene, FIXTURE, { x: -1, y: 0, z: 0 })!;
  assert.equal(t.sign, -1);
  applyPush(scene, t, 200);
  assert.equal(f.size.w, 800);
  assert.equal(f.x, -100, "中心が伸びたぶんの半分だけ動いていない");
});

test("矩形でない輪郭の側面は押せない", () => {
  // 円・三角・L 形・押し出した形では、1 面だけ動かした結果が `{w, h}` で表せない。
  // **黙って別の形にするより、断る**
  for (const kind of [
    "cylinder",
    "prism",
    "sphere",
    "stairL",
  ] as FixtureKind[]) {
    const { scene } = sceneWith(kind);
    assert.equal(
      pushTargetOf(scene, FIXTURE, { x: 1, y: 0, z: 0 }),
      null,
      `${kind} の側面が押せる`,
    );
    // 上下は押せる（立体になる種別なら）
    if (FIXTURE_SPECS[kind].solid) {
      assert.ok(pushTargetOf(scene, FIXTURE, UP), `${kind} の上面が押せない`);
    }
  }
});

test("押し出した形も、側面の辺を 1 本ずつ押せる", () => {
  const scene = emptyScene();
  scene.shapes.p = {
    id: "p",
    shape: "polyline",
    closed: true,
    layerId: LAYER_IDS.shape,
    attrs: defaultAttrs(),
    points: [vec(0, 0), vec(1000, 0), vec(1000, 1000), vec(0, 1000)],
  } as never;
  const id = extrudeShapes(scene, [{ type: "shape", id: "p" }], 800).created[0]
    .id;
  const ref = { type: "fixture" as const, id };
  // **自前の輪郭を持っていても、辺を 1 本動かせる**（第 6 版の 5 段目）
  const side = pushTargetOf(scene, ref, { x: 1, y: 0, z: 0 })!;
  assert.ok(side, "自前の輪郭の側面が掴めない");
  assert.equal(side.what, "outlineEdge");
  assert.ok(applyPush(scene, side, 300));
  const after = scene.fixtures[id].outline!;
  assert.equal(after.length, 4, "頂点の数が変わった");
  assert.ok(
    Math.abs(Math.max(...after.map((p) => p.x)) - (500 + 300)) < 1e-6,
    "+x の辺が 300 動いていない",
  );
  assert.ok(
    Math.abs(Math.min(...after.map((p) => p.x)) - -500) < 1e-6,
    "反対側の辺まで動いた",
  );

  const top = pushTargetOf(scene, ref, UP)!;
  applyPush(scene, top, 400);
  assert.equal(scene.fixtures[id].height, 1200);
});

test("立体にならないものは押せない", () => {
  for (const kind of ["void", "skylight"] as FixtureKind[]) {
    const { scene } = sceneWith(kind);
    assert.equal(pushTargetOf(scene, FIXTURE, UP), null, `${kind} が押せる`);
  }
});

test("壁は天端だけ押せる", () => {
  const scene = emptyScene();
  const wall = addWall(
    scene,
    findOrCreateNode(scene, vec(0, 0)),
    findOrCreateNode(scene, vec(4000, 0)),
    120,
  )!;
  const ref = { type: "wall" as const, id: wall.id };
  assert.equal(
    pushTargetOf(scene, ref, { x: 0, y: 1, z: 0 }),
    null,
    "壁の側面が押せる（厚みの話になる）",
  );
  const t = pushTargetOf(scene, ref, UP)!;
  const start = activeLevel(scene).wallHeight;
  applyPush(scene, t, -500);
  assert.equal(wall.height, start - 500);
});

test("下限を割らない", () => {
  const { scene, f } = sceneWith("box", { base: 0, height: 600 });
  applyPush(scene, pushTargetOf(scene, FIXTURE, UP)!, -99999);
  assert.equal(f.height, MIN_PUSH_SIZE);
  const side = pushTargetOf(scene, FIXTURE, { x: 1, y: 0, z: 0 })!;
  applyPush(scene, side, -99999);
  assert.equal(f.size.w, MIN_PUSH_SIZE);
});

test("押し引きの軸は面の外向き法線", () => {
  const { scene } = sceneWith("box", { angle: 0 });
  assert.deepEqual(pushAxis(pushTargetOf(scene, FIXTURE, UP)!), {
    x: 0,
    y: 0,
    z: 1,
  });
  assert.deepEqual(pushAxis(pushTargetOf(scene, FIXTURE, DOWN)!), {
    x: 0,
    y: 0,
    z: -1,
  });
  assert.deepEqual(
    pushAxis(pushTargetOf(scene, FIXTURE, { x: 0, y: -1, z: 0 })!),
    { x: 0, y: -1, z: 0 },
  );
});

// ---------------------------------------------------------------------------
// 倒した立体（第 5 版の 5 段目）
// ---------------------------------------------------------------------------

/** ローカルの点を、階の床を基準にしたワールドの 3 次元の点へ */
function at3(f: Fixture, p: Vec, z: number): Vec3Like {
  const q = toWorld3(f, p, z);
  return { x: q.x, y: q.y, z: q.z + baseOf(f, defaultLevel()) };
}

/** 立体のローカルの 4 隅（底面 z=0 か上面 z=height）をワールドで */
function face3(f: Fixture, which: "bottom" | "top"): Vec3Like[] {
  const z = which === "top" ? (f.height ?? 0) : 0;
  const hw = f.size.w / 2;
  const hh = f.size.h / 2;
  return [vec(-hw, -hh), vec(hw, -hh), vec(hw, hh), vec(-hw, hh)].map((p) =>
    at3(f, p, z),
  );
}

const sameFace = (a: Vec3Like[], b: Vec3Like[]): number =>
  Math.max(
    ...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y, p.z - b[i].z)),
  );

const TILT = { x: 0.7, y: 0.3 };

test("倒した箱の上面を掴める（ワールドの法線 z が 0.9 を割っても）", () => {
  // **以前はここで null が返っていた。** 倒すと上面の法線が斜めを向く
  const { scene, f } = sceneWith("box", { base: 300, height: 600, tilt: TILT });
  const n = rotateToWorld(f, { x: 0, y: 0, z: 1 });
  assert.ok(Math.abs(n.z) < 0.9, `法線の z が ${n.z}。これでは試験にならない`);

  const t = pushTargetOf(scene, FIXTURE, n)!;
  assert.ok(t, "倒した上面が掴めない");
  assert.equal(t.what, "top");
  // ドラッグを測る軸は面の法線そのもの
  const axis = pushAxis(t);
  assert.ok(
    Math.hypot(axis.x - n.x, axis.y - n.y, axis.z - n.z) < 1e-9,
    "軸が法線と違う",
  );
});

test("倒した箱の上面を押すと、底面は 1 点も動かない", () => {
  const { scene, f } = sceneWith("box", { base: 300, height: 600, tilt: TILT });
  const before = face3(f, "bottom");
  const t = pushTargetOf(
    scene,
    FIXTURE,
    rotateToWorld(f, { x: 0, y: 0, z: 1 }),
  )!;
  assert.ok(applyPush(scene, t, 400));
  assert.equal(f.height, 1000, "背が伸びていない");
  assert.ok(sameFace(before, face3(f, "bottom")) < 1e-9, "底面が動いた");
});

test("倒した箱の下面を押すと、上面は 1 点も動かない", () => {
  // ローカルの z に沿って原点が動くので、**横にもずれる**
  const { scene, f } = sceneWith("box", { base: 300, height: 600, tilt: TILT });
  const before = face3(f, "top");
  const t = pushTargetOf(
    scene,
    FIXTURE,
    rotateToWorld(f, { x: 0, y: 0, z: -1 }),
  )!;
  assert.equal(t.what, "bottom");
  assert.ok(applyPush(scene, t, 400));
  assert.equal(f.height, 1000);
  assert.ok(f.x !== 0 || f.y !== 0, "倒しているのに横へ動いていない");
  assert.ok(sameFace(before, face3(f, "top")) < 1e-9, "上面が動いた");
});

test("倒した箱の側面を押しても、反対側の面は動かない", () => {
  for (const [axis, dir] of [
    ["x", { x: 1, y: 0, z: 0 }],
    ["y", { x: 0, y: 1, z: 0 }],
  ] as const) {
    const { scene, f } = sceneWith("box", {
      angle: 0.4,
      base: 200,
      height: 600,
      size: { w: 600, h: 400 },
      tilt: TILT,
    });
    const hw = f.size.w / 2;
    const hh = f.size.h / 2;
    // 反対側の面の 4 隅（ローカル）
    const back =
      axis === "x"
        ? [vec(-hw, -hh), vec(-hw, hh)]
        : [vec(-hw, -hh), vec(hw, -hh)];
    const before = back.flatMap((p) => [at3(f, p, 0), at3(f, p, f.height!)]);

    const t = pushTargetOf(scene, FIXTURE, rotateToWorld(f, dir))!;
    assert.equal(t.what, "side", `${axis}: 側面として掴めていない`);
    assert.equal(t.axis, axis);
    assert.equal(t.sign, 1);
    assert.ok(applyPush(scene, t, 300));

    const nhw = f.size.w / 2;
    const nhh = f.size.h / 2;
    const backNow =
      axis === "x"
        ? [vec(-nhw, -nhh), vec(-nhw, nhh)]
        : [vec(-nhw, -nhh), vec(nhw, -nhh)];
    const after = backNow.flatMap((p) => [at3(f, p, 0), at3(f, p, f.height!)]);
    assert.ok(sameFace(before, after) < 1e-9, `${axis}: 反対側の面が動いた`);
  }
});

test("倒していなければ、下端は書き換えない（階の既定に乗ったまま）", () => {
  // `base` は null のままにしておく。既定に追従する種別があるので
  const { scene, f } = sceneWith("box", { size: { w: 600, h: 400 } });
  assert.equal(f.base, null);
  const t = pushTargetOf(scene, FIXTURE, { x: 1, y: 0, z: 0 })!;
  applyPush(scene, t, 300);
  assert.equal(f.base, null, "倒していないのに下端を書いた");
});

// ---------------------------------------------------------------------------
// 矩形でない立体の側面（第 6 版の 5 段目）
// ---------------------------------------------------------------------------

test("三角柱の 1 面を押すと、その面だけが動く", () => {
  const { scene, f } = sceneWith("prism", { size: { w: 1000, h: 800 } });
  // 底辺（ローカル -y を向く面）
  const t = pushTargetOf(scene, FIXTURE, { x: 0, y: -1, z: 0 })!;
  assert.ok(t, "三角柱の側面が掴めない");
  assert.equal(t.what, "outlineEdge");

  const before = localOutline(f).map((p) => ({ ...p }));
  assert.ok(applyPush(scene, t, 200));
  const after = f.outline!;
  assert.equal(after.length, 3, "頂点の数が変わった");
  // 動かした辺（y が最小の 2 点）だけが 200 下がる
  const lowBefore = Math.min(...before.map((p) => p.y));
  const lowAfter = Math.min(...after.map((p) => p.y));
  assert.ok(
    Math.abs(lowAfter - (lowBefore - 200)) < 1e-6,
    `底辺が動いていない (${lowAfter})`,
  );
  // 頂点（y が最大）は動かない
  assert.ok(
    Math.abs(
      Math.max(...after.map((p) => p.y)) - Math.max(...before.map((p) => p.y)),
    ) < 1e-6,
    "反対側の頂点まで動いた",
  );
});

test("同じ向きの辺が 2 本あるときは、掴んだ点で選ぶ", () => {
  // L 字の輪郭には +x を向く辺が 2 本ある
  const L = [
    vec(-500, -500),
    vec(500, -500),
    vec(500, 0),
    vec(0, 0),
    vec(0, 500),
    vec(-500, 500),
  ];
  const { scene, f } = sceneWith("box", { outline: L.map((p) => ({ ...p })) });

  // 下の辺（x = 500、y は -500〜0）の近くを掴む
  const low = pushTargetOf(
    scene,
    FIXTURE,
    { x: 1, y: 0, z: 0 },
    { x: 500, y: -250, z: 100 },
  )!;
  assert.ok(low, "掴めない");
  applyPush(scene, low, 200);
  const moved = f.outline!;
  assert.ok(
    moved.some((p) => Math.abs(p.x - 700) < 1e-6 && Math.abs(p.y + 500) < 1e-6),
    "下の辺が動いていない",
  );
  assert.ok(
    moved.some((p) => Math.abs(p.x) < 1e-6 && Math.abs(p.y - 500) < 1e-6),
    "上の辺まで動いた",
  );
});

test("掴んだ点が無く、同じ向きの辺が複数なら断る", () => {
  // **当てずっぽうで別の辺を動かさない**
  const L = [
    vec(-500, -500),
    vec(500, -500),
    vec(500, 0),
    vec(0, 0),
    vec(0, 500),
    vec(-500, 500),
  ];
  const { scene } = sceneWith("box", { outline: L });
  assert.equal(pushTargetOf(scene, FIXTURE, { x: 1, y: 0, z: 0 }), null);
  // 1 本しか無い向きなら、点が無くても決まる
  assert.ok(
    pushTargetOf(scene, FIXTURE, { x: 0, y: -1, z: 0 }),
    "一意なのに断った",
  );
});

test("丸い種別と、輪郭をまっすぐ押さない種別は断ったまま", () => {
  for (const kind of [
    "cylinder",
    "cone",
    "sphere",
    "dome",
    "stair",
    "slope",
  ] as FixtureKind[]) {
    const { scene } = sceneWith(kind);
    assert.equal(
      pushTargetOf(
        scene,
        FIXTURE,
        { x: 1, y: 0, z: 0 },
        { x: 500, y: 0, z: 100 },
      ),
      null,
      `${kind}: 側面を掴めてしまった`,
    );
  }
});

test("縦の角を落としていたら、側面は断る", () => {
  // 面が輪郭の辺と 1 対 1 でなくなり、どの辺か決められない
  const { scene } = sceneWith("box", {
    size: { w: 1000, h: 1000 },
    edge: { kind: "chamfer", size: 100, where: "corners" },
  });
  assert.equal(pushTargetOf(scene, FIXTURE, { x: 1, y: 0, z: 0 }), null);
  // 上下は掴める
  assert.ok(pushTargetOf(scene, FIXTURE, UP), "上面まで掴めなくなった");
});

test("押しすぎて裏返る手前で断る", () => {
  // 三角柱の底辺を、頂点を追い越すまで内へ押す
  const { scene, f } = sceneWith("prism", { size: { w: 1000, h: 800 } });
  const t = pushTargetOf(scene, FIXTURE, { x: 0, y: -1, z: 0 })!;
  assert.ok(t, "底辺が掴めない");
  const before = JSON.stringify(f.outline);
  // 底辺は y = -400、頂点は y = +400。1000 内へ押すと追い越す
  assert.equal(applyPush(scene, t, -1000), false, "裏返る量でも通った");
  assert.equal(JSON.stringify(f.outline), before, "断ったのに形が変わった");
  // 追い越さない量なら通る
  assert.equal(applyPush(scene, t, -700), true, "通る量まで断った");
});

test("辺を動かすと、幅と奥行も合う", () => {
  // **画面で見つけた。** 直さないとプロパティ欄が古い数字を出したままになる
  const { scene, f } = sceneWith("prism", { size: { w: 2000, h: 1600 } });
  const t = pushTargetOf(scene, FIXTURE, { x: 0, y: -1, z: 0 })!;
  assert.ok(applyPush(scene, t, 500));
  const poly = f.outline!;
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  assert.ok(
    Math.abs(f.size.w - (Math.max(...xs) - Math.min(...xs))) < 1e-6,
    `幅が合っていない (${f.size.w})`,
  );
  assert.ok(
    Math.abs(f.size.h - (Math.max(...ys) - Math.min(...ys))) < 1e-6,
    `奥行が合っていない (${f.size.h})`,
  );
  assert.ok(f.size.h > 1600, "押したのに奥行が増えていない");
});

test("同じドラッグ中に何度当てても積み上がらない", () => {
  const { scene, f } = sceneWith("prism", { size: { w: 1000, h: 800 } });
  const t = pushTargetOf(scene, FIXTURE, { x: 0, y: -1, z: 0 })!;
  applyPush(scene, t, 100);
  applyPush(scene, t, 100);
  applyPush(scene, t, 250);
  const low = Math.min(...f.outline!.map((p) => p.y));
  assert.ok(Math.abs(low - (-400 - 250)) < 1e-6, `積み上がっている (${low})`);
});

/**
 * 断った理由（21 段）。**画面に出す文言そのもの。**
 *
 * 以前は `pushTargetOf` が `null` を返して終わりだったので、掴んでも何も
 * 起きないように見えた。理由は「できません」で止めず、次の一手まで言う。
 */

test("丸い立体の側面は、直径の欄を案内して断る", () => {
  const { scene } = sceneWith("cylinder");
  const normal = { x: 1, y: 0, z: 0 };
  const at = { x: 500, y: 0, z: 100 };
  assert.equal(pushTargetOf(scene, FIXTURE, normal, at), null);
  const why = pushRefusal(scene, FIXTURE, normal, at);
  assert.ok(why, "断ったのに理由が無い");
  assert.ok(why.includes("直径"), `代わりの手が書かれていない: ${why}`);
});

test("輪郭をまっすぐ押さない種別は、丸いものとは別の理由で断る", () => {
  const at = { x: 500, y: 0, z: 100 };
  const normal = { x: 1, y: 0, z: 0 };
  const round = pushRefusal(sceneWith("cylinder").scene, FIXTURE, normal, at);
  const stair = pushRefusal(sceneWith("stair").scene, FIXTURE, normal, at);
  assert.ok(stair, "階段の理由が無い");
  assert.notEqual(stair, round, "どちらも同じ文言になっている");
});

test("縦の角を落とした立体は、上下なら押せると言い添えて断る", () => {
  const { scene } = sceneWith("box", {
    size: { w: 1000, h: 1000 },
    edge: { kind: "chamfer", size: 100, where: "corners" },
  });
  const why = pushRefusal(scene, FIXTURE, { x: 1, y: 0, z: 0 });
  assert.ok(why, "断ったのに理由が無い");
  assert.ok(why.includes("上下"), `逃げ道が書かれていない: ${why}`);
});

test("壁の側面は、天端なら押せると言い添えて断る", () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const wall = addWall(scene, a, b, 120)!;
  const ref = { type: "wall" as const, id: wall.id };
  const why = pushRefusal(scene, ref, { x: 0, y: 1, z: 0 });
  assert.ok(why, "断ったのに理由が無い");
  assert.ok(why.includes("天端"), `逃げ道が書かれていない: ${why}`);
});

test("押せるときは理由を出さない", () => {
  const { scene } = sceneWith("box");
  assert.ok(pushTargetOf(scene, FIXTURE, UP), "上面が押せない");
  assert.equal(
    pushRefusal(scene, FIXTURE, UP),
    null,
    "押せるのに断り書きが出ている",
  );
  // 側面も同じ
  assert.ok(pushTargetOf(scene, FIXTURE, { x: 1, y: 0, z: 0 }));
  assert.equal(pushRefusal(scene, FIXTURE, { x: 1, y: 0, z: 0 }), null);
});
