import { test } from "node:test";
import assert from "node:assert/strict";
import {
  combineFixtures,
  explodeFixture,
  splitFixture,
  combineFingerprint,
  type BooleanOp,
} from "../src/core/combine.ts";
import {
  FIXTURE_SPECS,
  outline,
  type Fixture,
  type FixtureKind,
} from "../src/core/fixture.ts";
import {
  buildFixtureFaces,
  fixtureFingerprint,
} from "../src/render3d/fixture3d.ts";
import { deserialize, serialize } from "../src/io/scene.ts";
import { defaultAttrs } from "../src/core/attrs.ts";
import { DEFAULT_LEVEL_ID, defaultLevel } from "../src/core/level.ts";
import { signedArea, vec } from "../src/core/geometry.ts";
import { detectRooms } from "../src/core/rooms.ts";
import { emptyScene, type Scene } from "../src/core/types.ts";
import type { Face3 } from "../src/render3d/mesh.ts";
import type { Vec3 } from "../src/render3d/mat4.ts";

/**
 * ブーリアンの持ち方（23 段）。**結果の形ではなく作り方を持つ。**
 *
 * 相手は母体の中にしまい込まれ、`scene.fixtures` からは消える。
 * こうすると平面にも積算にも二重に出ず、あとから「分解」で戻せる。
 */

function put(
  scene: Scene,
  id: string,
  kind: FixtureKind,
  over: Partial<Fixture> = {},
): string {
  const spec = FIXTURE_SPECS[kind];
  scene.fixtures[id] = {
    id,
    kind,
    x: 0,
    y: 0,
    angle: 0,
    size: { ...spec.defaultSize },
    tilt: null,
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
  return id;
}

const facesOf = (scene: Scene, id: string): Face3[] => {
  const out: Face3[] = [];
  buildFixtureFaces(scene, id, out);
  return out;
};

function volume(faces: readonly Face3[]): number {
  let v = 0;
  for (const f of faces) {
    const p = f.points;
    for (let i = 1; i + 1 < p.length; i++) v += det(p[0], p[i], p[i + 1]) / 6;
  }
  return v;
}
const det = (a: Vec3, b: Vec3, c: Vec3): number =>
  a.x * (b.y * c.z - b.z * c.y) -
  a.y * (b.x * c.z - b.z * c.x) +
  a.z * (b.x * c.y - b.y * c.x);

/** 1000 立方の箱 2 つ。半分だけ重ねる */
function twoBoxes(): Scene {
  const scene = emptyScene();
  put(scene, "a", "box", { size: { w: 1000, h: 1000 }, height: 1000 });
  put(scene, "b", "box", { x: 500, size: { w: 1000, h: 1000 }, height: 1000 });
  return scene;
}

test("掛け合わせた相手は図面から消え、母体の中に入る", () => {
  const scene = twoBoxes();
  const host = combineFixtures(scene, ["a", "b"], "subtract")!;
  assert.equal(host, "a");
  assert.equal(scene.fixtures.b, undefined, "相手が図面に残っている");
  assert.equal(scene.fixtures.a.combine?.op, "subtract");
  assert.equal(scene.fixtures.a.combine?.parts.length, 1);
});

test("切り欠いた立体は、引いたぶんだけ体積が減る", () => {
  const scene = twoBoxes();
  const before = volume(facesOf(scene, "a"));
  assert.ok(Math.abs(before - 1e9) < 1, `元の体積 ${before}`);
  combineFixtures(scene, ["a", "b"], "subtract");
  const after = volume(facesOf(scene, "a"));
  assert.ok(Math.abs(after - 0.5e9) < 1, `切り欠いた体積 ${after}`);
});

test("合成した立体は、重なりを 2 度数えない", () => {
  const scene = twoBoxes();
  combineFixtures(scene, ["a", "b"], "unite");
  const v = volume(facesOf(scene, "a"));
  assert.ok(Math.abs(v - 1.5e9) < 1, `合成した体積 ${v}`);
});

test("切り欠いた面も母体を指す（クリックしたら母体が選ばれる）", () => {
  const scene = twoBoxes();
  combineFixtures(scene, ["a", "b"], "subtract");
  for (const f of facesOf(scene, "a")) {
    assert.equal(f.ref?.type, "fixture");
    assert.equal(f.ref?.id, "a", "切り欠いた面が別のものを指している");
  }
});

test("分解すると相手が図面へ戻る", () => {
  const scene = twoBoxes();
  combineFixtures(scene, ["a", "b"], "subtract");
  assert.equal(explodeFixture(scene, "a"), 1);
  assert.ok(scene.fixtures.b, "相手が戻っていない");
  assert.equal(scene.fixtures.a.combine, null);
  // 形も元どおり
  assert.ok(
    Math.abs(volume(facesOf(scene, "a")) - 1e9) < 1,
    "分解しても切り欠かれたまま",
  );
});

test("相手を直すと指紋が変わる（変えないと 3D が古いまま）", () => {
  const scene = twoBoxes();
  combineFixtures(scene, ["a", "b"], "subtract");
  const before = fixtureFingerprint(scene, "a");
  scene.fixtures.a.combine!.parts[0].x = 700;
  assert.notEqual(
    fixtureFingerprint(scene, "a"),
    before,
    "相手を直しても指紋が同じ",
  );
  assert.notEqual(combineFingerprint(scene.fixtures.a), "-");
});

test("しまい込んだ立体は床を食わない（図面に居ないので）", async () => {
  const scene = twoBoxes();
  put(scene, "v", "void", { x: 3000, size: { w: 1000, h: 1000 } });
  const before = Object.keys(scene.fixtures).length;
  combineFixtures(scene, ["a", "b"], "subtract");
  assert.equal(Object.keys(scene.fixtures).length, before - 1);
  // 部屋の検出が、しまい込んだものを見にいって落ちたりしない
  assert.doesNotThrow(() => detectRooms(scene));
});

test("ブーリアンが JSON の往復を生き延びる", () => {
  const scene = twoBoxes();
  combineFixtures(scene, ["a", "b"], "intersect");
  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.deepEqual(back.fixtures.a, scene.fixtures.a, "往復で変わった");
  assert.equal(back.fixtures.b, undefined, "しまい込んだ相手が図面に出てきた");
});

test("重ねて掛けられる", () => {
  const scene = twoBoxes();
  put(scene, "c", "box", { y: 500, size: { w: 1000, h: 1000 }, height: 1000 });
  combineFixtures(scene, ["a", "b"], "subtract");
  combineFixtures(scene, ["a", "c"], "subtract");
  assert.equal(scene.fixtures.a.combine?.parts.length, 2);
  // x と y の両方から削られる
  const v = volume(facesOf(scene, "a"));
  assert.ok(v < 0.5e9 && v > 0, `重ねて削った体積 ${v}`);
});

test("1 つだけでは掛けられない", () => {
  const scene = twoBoxes();
  assert.equal(combineFixtures(scene, ["a"], "unite"), null);
  assert.equal(combineFixtures(scene, [], "unite"), null);
  assert.equal(explodeFixture(scene, "a"), 0, "作り方が無いのに分解できた");
});

// ---------------------------------------------------------------------------
// 切り欠いた形を平面に出す（第 6 版の 7 段目）
// ---------------------------------------------------------------------------

const planArea = (f: Fixture): number => signedArea(outline(f, defaultLevel()));

/** 1000 角の箱を母体に、相手を 1 つ掛け合わせたシーン */
function carved(part: Partial<Fixture>, op: BooleanOp = "subtract") {
  const scene = emptyScene();
  put(scene, "a", "box", { size: { w: 1000, h: 1000 }, height: 1000 });
  put(scene, "b", "box", { size: { w: 1000, h: 1000 }, height: 1000, ...part });
  combineFixtures(scene, ["a", "b"], op);
  return scene;
}

test("高さを貫く切り欠きは、平面にも出る", () => {
  const scene = carved({ x: 600, y: 600 });
  // 角が 400 × 400 削れる
  assert.ok(
    Math.abs(planArea(scene.fixtures.a) - (1_000_000 - 160_000)) < 1e-6,
    `面積が ${planArea(scene.fixtures.a)}`,
  );
});

test("途中で止まる切り欠きは、平面に出さない", () => {
  // **平面は上から見た影。** 箱の真ん中だけをえぐっても、上から見れば箱のまま
  const scene = carved({ x: 600, y: 600, base: 200, height: 400 });
  assert.ok(
    Math.abs(planArea(scene.fixtures.a) - 1_000_000) < 1e-6,
    "上から見えない穴を描いた",
  );
});

test("上下に余るほど突き抜けていれば、平面に出る", () => {
  const scene = carved({ x: 600, y: 600, base: -500, height: 3000 });
  assert.ok(Math.abs(planArea(scene.fixtures.a) - 840_000) < 1e-6);
});

test("穴が開く切り欠きは、切り欠く前の形のまま", () => {
  // 輪郭に穴の置き場が無い。**黙って嘘の形を出すより、元の形を出す**
  const scene = carved({ size: { w: 400, h: 400 } });
  assert.ok(
    Math.abs(planArea(scene.fixtures.a) - 1_000_000) < 1e-6,
    "ドーナツを描いた",
  );
});

test("合成は高さに関係なく平面に出る", () => {
  // 影どうしの和は、高さが離れていても正しい
  const scene = carved({ x: 800, base: 5000, height: 1000 }, "unite");
  assert.ok(
    Math.abs(planArea(scene.fixtures.a) - 1_800_000) < 1e-6,
    `面積が ${planArea(scene.fixtures.a)}`,
  );
});

test("交差は高さが重なるときだけ平面に出る", () => {
  const over = carved({ x: 500, base: 500, height: 1000 }, "intersect");
  assert.ok(Math.abs(planArea(over.fixtures.a) - 500_000) < 1e-6);
  const apart = carved({ x: 500, base: 5000, height: 1000 }, "intersect");
  assert.ok(
    Math.abs(planArea(apart.fixtures.a) - 1_000_000) < 1e-6,
    "高さが離れているのに削った",
  );
});

test("相手を動かすと、平面の投影も付いてくる（控えが腐らない）", () => {
  const scene = carved({ x: 600, y: 600 });
  const host = scene.fixtures.a;
  assert.ok(Math.abs(planArea(host) - 840_000) < 1e-6);

  // **しまい込んだ相手を動かす。** 控えを持っているので、ここが腐りやすい
  host.combine!.parts[0].x = 1400;
  assert.ok(
    Math.abs(planArea(host) - 1_000_000) < 1e-6,
    "相手を離しても削れたまま",
  );

  host.combine!.parts[0].x = 600;
  assert.ok(Math.abs(planArea(host) - 840_000) < 1e-6, "戻しても削れない");

  // 母体を大きくしても付いてくる
  host.size.w = 2000;
  const bigger = planArea(host);
  assert.ok(bigger > 1_000_000, `母体を広げても ${bigger}`);
});

test("階が変わると、平面の投影も付いてくる", () => {
  // **高さを階に任せている相手**では、階高が切り欠きの届く先を変える。
  // 角柱の既定の高さは階高（直方体は 600 の決め打ちなので使えない）
  const scene = emptyScene();
  put(scene, "a", "box", { size: { w: 1000, h: 1000 }, height: 1000 });
  put(scene, "b", "column", {
    x: 600,
    y: 600,
    size: { w: 1000, h: 1000 },
    height: null,
  });
  combineFixtures(scene, ["a", "b"], "subtract");
  const host = scene.fixtures.a;
  const low = { ...defaultLevel(), wallHeight: 500 };
  const high = { ...defaultLevel(), wallHeight: 3000 };
  // 階高 500 では母体（1000）を貫かない
  assert.ok(
    Math.abs(signedArea(outline(host, low)) - 1_000_000) < 1e-6,
    "貫いていないのに削った",
  );
  assert.ok(
    Math.abs(signedArea(outline(host, high)) - 840_000) < 1e-6,
    "階を上げても削れない",
  );
});

// ---------------------------------------------------------------------------
// 立体を 2 つに切り分ける（第 6 版の 8 段目）
// ---------------------------------------------------------------------------

/** 1000 角の箱 1 つだけのシーン */
function soloBox(over: Partial<Fixture> = {}) {
  const scene = emptyScene();
  put(scene, "h", "box", { size: { w: 1000, h: 1000 }, height: 1000, ...over });
  return scene;
}

test("切り分けた 2 つの体積の和が、元と合う", () => {
  for (const [name, a, b] of [
    ["真ん中で縦に", vec(0, -5000), vec(0, 5000)],
    ["1/4 のところで", vec(-250, -5000), vec(-250, 5000)],
    ["斜めに", vec(-5000, -5000), vec(5000, 5000)],
  ] as const) {
    const scene = soloBox();
    const before = volume(facesOf(scene, "h"));
    const ids = splitFixture(scene, "h", a, b, defaultLevel());
    assert.ok(ids, `${name}: 切れない`);
    const sum = ids.reduce((t, id) => t + volume(facesOf(scene, id)), 0);
    assert.ok(
      Math.abs(sum - before) / before < 1e-9,
      `${name}: ${sum} ≠ ${before}`,
    );
    for (const id of ids) {
      assert.ok(volume(facesOf(scene, id)) > 0, `${name}: 片方が空`);
    }
  }
});

test("切り口は平面にも出る", () => {
  const scene = soloBox();
  const ids = splitFixture(
    scene,
    "h",
    vec(-250, -5000),
    vec(-250, 5000),
    defaultLevel(),
  )!;
  const areas = ids.map((id) =>
    signedArea(outline(scene.fixtures[id], defaultLevel())),
  );
  assert.ok(
    Math.abs(areas[0] + areas[1] - 1_000_000) < 1e-3,
    `${areas[0]} + ${areas[1]}`,
  );
  assert.ok(
    Math.abs(Math.min(...areas) - 250_000) < 1e-3,
    "1/4 になっていない",
  );
});

test("母体の形と輪郭は元のまま（平面も積算も壊れない）", () => {
  const scene = soloBox({ kind: "cylinder" });
  const ids = splitFixture(
    scene,
    "h",
    vec(0, -5000),
    vec(0, 5000),
    defaultLevel(),
  )!;
  for (const id of ids) {
    const f = scene.fixtures[id];
    assert.equal(f.kind, "cylinder", "種別が箱に化けた");
    assert.equal(f.size.w, 1000, "大きさが変わった");
    assert.equal(f.outline, null, "自前の輪郭が付いた");
  }
});

test("元の id が片方に残る（選択も undo も続きとして扱える）", () => {
  const scene = soloBox();
  const ids = splitFixture(
    scene,
    "h",
    vec(0, -5000),
    vec(0, 5000),
    defaultLevel(),
  )!;
  assert.ok(ids.includes("h"), "元の id が消えた");
  assert.equal(Object.keys(scene.fixtures).length, 2, "2 つになっていない");
});

test("線が立体を横切っていなければ断る", () => {
  // 片方が空になるだけで「切り分けた」ことにならない
  const scene = soloBox();
  const before = JSON.stringify(scene.fixtures);
  assert.equal(
    splitFixture(scene, "h", vec(5000, -5000), vec(5000, 5000), defaultLevel()),
    null,
  );
  assert.equal(
    JSON.stringify(scene.fixtures),
    before,
    "断ったのに図面が変わった",
  );
  // 長さの無い線も断る
  assert.equal(
    splitFixture(scene, "h", vec(0, 0), vec(0, 0), defaultLevel()),
    null,
  );
});

test("既に作り方を持つ立体も切れる（作り方ごと中へしまう）", () => {
  const scene = emptyScene();
  put(scene, "h", "box", { size: { w: 1000, h: 1000 }, height: 1000 });
  put(scene, "c", "box", {
    x: 600,
    y: 600,
    size: { w: 600, h: 600 },
    height: 1000,
  });
  combineFixtures(scene, ["h", "c"], "subtract");
  const before = volume(facesOf(scene, "h"));

  const ids = splitFixture(
    scene,
    "h",
    vec(0, -5000),
    vec(0, 5000),
    defaultLevel(),
  )!;
  assert.ok(ids, "作り方を持つ立体が切れない");
  const sum = ids.reduce((t, id) => t + volume(facesOf(scene, id)), 0);
  assert.ok(Math.abs(sum - before) / before < 1e-9, `${sum} ≠ ${before}`);
  // 切り欠きのほうも平面に残る（+x 側が 500000 − 40000）
  const areas = ids.map((id) =>
    signedArea(outline(scene.fixtures[id], defaultLevel())),
  );
  assert.ok(
    areas.some((v) => Math.abs(v - 460_000) < 1e-3),
    `切り欠きが平面から消えた (${areas.join(" / ")})`,
  );
});

test("倒した立体も切れる", () => {
  const scene = soloBox({ tilt: { x: 0.5, y: 0 } });
  const before = volume(facesOf(scene, "h"));
  const ids = splitFixture(
    scene,
    "h",
    vec(0, -5000),
    vec(0, 5000),
    defaultLevel(),
  )!;
  assert.ok(ids, "倒した立体が切れない");
  const sum = ids.reduce((t, id) => t + volume(facesOf(scene, id)), 0);
  assert.ok(Math.abs(sum - before) / before < 1e-9, `${sum} ≠ ${before}`);
});

test("切り分けたものは「分解」で元に戻せる", () => {
  const scene = soloBox();
  const ids = splitFixture(
    scene,
    "h",
    vec(0, -5000),
    vec(0, 5000),
    defaultLevel(),
  )!;
  assert.ok(explodeFixture(scene, ids[0]) > 0, "分解できない");
  assert.equal(scene.fixtures[ids[0]].combine, null);
  // 分解すると、覆っていた箱が図面に出てくる
  assert.ok(Object.keys(scene.fixtures).length > 2, "覆いが戻っていない");
});
