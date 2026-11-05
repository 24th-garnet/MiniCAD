import { test } from "node:test";
import assert from "node:assert/strict";
import { polyBoolean, POLY_OPS, type PolyOp } from "../src/core/polybool.ts";
import { selfIntersects } from "../src/core/extrude.ts";
import { rotate, signedArea, vec, type Vec } from "../src/core/geometry.ts";
import { combineShapes } from "../src/core/join.ts";
import { defaultAttrs } from "../src/core/attrs.ts";
import { LAYER_IDS } from "../src/core/layer.ts";
import { DEFAULT_LEVEL_ID } from "../src/core/level.ts";
import { emptyScene } from "../src/core/types.ts";

/**
 * 2D の多角形のブール演算（第 6 版の 6 段目）。
 *
 * **退化が日常。** 間取りの図形は辺を共有するのが普通（柱が壁にぴったり付く、
 * 部屋が隣り合う）なので、「辺が重なる」「頂点が辺の上に乗る」「接するだけ」は
 * 例外ではない。ここで見るのは**その 3 つが正しく出ること**と、
 * **1 本の輪郭にならない組み合わせを断る**こと。
 */

const R = (x0: number, y0: number, x1: number, y1: number): Vec[] => [
  vec(x0, y0),
  vec(x1, y0),
  vec(x1, y1),
  vec(x0, y1),
];

/** 結果の面積。断ったら null */
function areaOf(a: Vec[], b: Vec[], op: PolyOp): number | null {
  const got = polyBoolean(a, b, op);
  if (!got) return null;
  // 返すものは必ず**反時計回りの単純多角形**
  assert.ok(got.length >= 3, `${op}: 多角形になっていない`);
  assert.ok(signedArea(got) > 0, `${op}: 反時計回りでない`);
  assert.ok(!selfIntersects(got), `${op}: 自己交差している`);
  return signedArea(got);
}

/**
 * 面積の突き合わせ。**許しは相対で見る。**
 *
 * 入力はナノメートルの格子に丸めてから計算する（浮動小数の屑で「重なった辺」が
 * 傾くのを防ぐため）ので、斜めの辺を持つ形では面積が 1e-9 ほど動く。
 * 1 m 角の図形で 0.0002 mm²——建築の図面では意味を持たない桁。
 */
const near = (got: number | null, want: number, what: string): void => {
  assert.ok(got !== null, `${what}: 断られた`);
  const slack = Math.max(1e-6, Math.abs(want) * 1e-9);
  assert.ok(
    Math.abs(got - want) < slack,
    `${what}: 面積が ${got}（${want} のはず）`,
  );
};

test("重なる 2 つの矩形", () => {
  const a = R(0, 0, 1000, 1000);
  const b = R(500, 500, 1500, 1500);
  near(areaOf(a, b, "unite"), 1_750_000, "合成");
  near(areaOf(a, b, "subtract"), 750_000, "切り欠き");
  near(areaOf(a, b, "intersect"), 250_000, "交差");
});

test("辺を共有する 2 つ（退化）", () => {
  // **間取りでは普通に起きる。** 交点だけを追う作りはここで崩れる
  const a = R(0, 0, 1000, 1000);
  const b = R(1000, 0, 2000, 1000);
  near(areaOf(a, b, "unite"), 2_000_000, "合成");
  // 合成したら、まっすぐ並んだ途中の点は落ちて**ただの矩形**になる
  assert.equal(polyBoolean(a, b, "unite")!.length, 4, "余分な点が残っている");
  near(areaOf(a, b, "subtract"), 1_000_000, "切り欠き");
  assert.equal(areaOf(a, b, "intersect"), null, "面積の無い交差を返した");
});

test("辺の一部だけを共有する 2 つ（退化）", () => {
  const a = R(0, 0, 1000, 1000);
  const b = R(1000, 200, 2000, 800);
  near(areaOf(a, b, "unite"), 1_600_000, "合成");
  near(areaOf(a, b, "subtract"), 1_000_000, "切り欠き");
  assert.equal(areaOf(a, b, "intersect"), null, "面積の無い交差を返した");
});

test("頂点が辺の上に乗る（T 字・退化）", () => {
  const a = R(0, 0, 1000, 1000);
  const b = R(500, 1000, 1500, 2000);
  near(areaOf(a, b, "unite"), 2_000_000, "合成");
  near(areaOf(a, b, "subtract"), 1_000_000, "切り欠き");
});

test("角だけが接する（退化）", () => {
  const a = R(0, 0, 1000, 1000);
  const b = R(1000, 1000, 2000, 2000);
  // 8 の字は 1 本の輪郭にならない
  assert.equal(areaOf(a, b, "unite"), null, "8 の字を返した");
  near(areaOf(a, b, "subtract"), 1_000_000, "切り欠き");
  assert.equal(areaOf(a, b, "intersect"), null, "面積の無い交差を返した");
});

test("まったく同じ 2 つ", () => {
  const a = R(0, 0, 1000, 1000);
  near(areaOf(a, [...a], "unite"), 1_000_000, "合成");
  near(areaOf(a, [...a], "intersect"), 1_000_000, "交差");
  assert.equal(areaOf(a, [...a], "subtract"), null, "空の結果を返した");
});

test("離れている 2 つ", () => {
  const a = R(0, 0, 1000, 1000);
  const b = R(2000, 0, 3000, 1000);
  assert.equal(areaOf(a, b, "unite"), null, "2 つの塊を 1 本で返した");
  near(areaOf(a, b, "subtract"), 1_000_000, "切り欠き");
  assert.equal(areaOf(a, b, "intersect"), null, "空の交差を返した");
});

test("穴ができる組み合わせは断る", () => {
  // **`Shape` にも `Fixture.outline` にも穴の置き場が無い**
  const a = R(0, 0, 1000, 1000);
  const inner = R(200, 200, 800, 800);
  assert.equal(areaOf(a, inner, "subtract"), null, "ドーナツを返した");
  near(areaOf(a, inner, "unite"), 1_000_000, "合成");
  near(areaOf(a, inner, "intersect"), 360_000, "交差");
});

test("切り欠きで 2 つに割れる組み合わせも断る", () => {
  const a = R(0, 0, 1000, 1000);
  const slot = R(400, -100, 600, 1100);
  assert.equal(areaOf(a, slot, "subtract"), null, "割れた 2 つを 1 本で返した");
  near(areaOf(a, slot, "intersect"), 200_000, "交差");
});

test("へこんだ形（L 字）でも正しい", () => {
  const L = [
    vec(0, 0),
    vec(1200, 0),
    vec(1200, 400),
    vec(400, 400),
    vec(400, 1200),
    vec(0, 1200),
  ];
  const b = R(300, 300, 900, 900);
  near(areaOf(L, b, "intersect"), 110_000, "交差");
  near(areaOf(L, b, "unite"), 1_050_000, "合成");
  near(areaOf(L, b, "subtract"), 690_000, "切り欠き");
});

test("斜めの辺でも正しい", () => {
  const diamond = [vec(500, 0), vec(1000, 500), vec(500, 1000), vec(0, 500)];
  const b = R(400, 400, 1400, 600);
  near(areaOf(diamond, b, "intersect"), 110_000, "交差");
  near(areaOf(diamond, b, "unite"), 590_000, "合成");
  near(areaOf(diamond, b, "subtract"), 390_000, "切り欠き");
});

test("45 度に回した正方形どうしの交差は正八角形", () => {
  const sq = R(-500, -500, 500, 500);
  const tilted = sq.map((p) => rotate(p, Math.PI / 4));
  const got = polyBoolean(sq, tilted, "intersect")!;
  assert.equal(got.length, 8, "八角形になっていない");
  // 2(√2 − 1) a²
  near(signedArea(got), 2 * (Math.SQRT2 - 1) * 1_000_000, "交差");
  near(
    areaOf(sq, tilted, "unite"),
    2_000_000 - 2 * (Math.SQRT2 - 1) * 1_000_000,
    "合成",
  );
  // 差は 4 つの隅に分かれるので断る
  assert.equal(areaOf(sq, tilted, "subtract"), null, "分かれた 4 つを返した");
});

test("向きはどちらで渡してもよい", () => {
  const a = R(0, 0, 1000, 1000);
  const b = R(500, 500, 1500, 1500);
  for (const op of POLY_OPS) {
    const ccw = polyBoolean(a, b, op);
    const cw = polyBoolean([...a].reverse(), [...b].reverse(), op);
    if (ccw === null) {
      assert.equal(cw, null, `${op}: 向きで結果が変わった`);
      continue;
    }
    assert.ok(cw, `${op}: 時計回りだと断られた`);
    assert.ok(
      Math.abs(signedArea(ccw) - signedArea(cw)) < 1e-6,
      `${op}: 面積が違う`,
    );
  }
});

test("面積の無い入力は断る", () => {
  const line = [vec(0, 0), vec(1000, 0), vec(2000, 0)];
  const a = R(0, 0, 1000, 1000);
  for (const op of POLY_OPS) {
    assert.equal(polyBoolean(line, a, op), null, `${op}: 潰れた入力を通した`);
    assert.equal(polyBoolean(a, line, op), null, `${op}: 潰れた相手を通した`);
    assert.equal(
      polyBoolean([vec(0, 0), vec(1, 1)], a, op),
      null,
      `${op}: 2 点を通した`,
    );
  }
});

test("合成と交差は順番を入れ替えても同じ", () => {
  const a = R(0, 0, 1000, 1000);
  const b = R(600, 200, 1600, 800);
  for (const op of ["unite", "intersect"] as const) {
    const ab = polyBoolean(a, b, op);
    const ba = polyBoolean(b, a, op);
    assert.ok(ab && ba, `${op}: 断られた`);
    assert.ok(
      Math.abs(signedArea(ab) - signedArea(ba)) < 1e-6,
      `${op}: 入れ替えで変わった`,
    );
  }
});

// ---------------------------------------------------------------------------
// 図面の上での合成（`combineShapes`）
// ---------------------------------------------------------------------------

const rectShape = (
  id: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) => ({
  id,
  shape: "polyline" as const,
  closed: true,
  layerId: LAYER_IDS.shape,
  levelId: DEFAULT_LEVEL_ID,
  attrs: defaultAttrs(),
  points: R(x0, y0, x1, y1),
});

function sceneWithRects(...rects: ReturnType<typeof rectShape>[]) {
  const scene = emptyScene();
  for (const r of rects) scene.shapes[r.id] = r as never;
  return scene;
}

test("図面の上で合成すると、1 本の閉じた折れ線になる", () => {
  const scene = sceneWithRects(
    rectShape("a", 0, 0, 1000, 1000),
    rectShape("b", 500, 500, 1500, 1500),
  );
  const made = combineShapes(scene, ["a", "b"], "unite");
  assert.equal(made, "a", "先頭が母体になっていない");
  assert.equal(scene.shapes.b, undefined, "相手が図面から消えていない");
  const host = scene.shapes.a as {
    shape: string;
    closed: boolean;
    points: Vec[];
  };
  assert.equal(host.shape, "polyline");
  assert.equal(host.closed, true, "閉じていない");
  assert.ok(Math.abs(signedArea(host.points) - 1_750_000) < 1e-6);
});

test("1 本にならない組み合わせでは、図面を 1 つも変えない", () => {
  const scene = sceneWithRects(
    rectShape("a", 0, 0, 1000, 1000),
    rectShape("b", 200, 200, 800, 800),
  );
  const before = JSON.stringify(scene.shapes);
  assert.equal(
    combineShapes(scene, ["a", "b"], "subtract"),
    null,
    "ドーナツを通した",
  );
  assert.equal(
    JSON.stringify(scene.shapes),
    before,
    "断ったのに図面が変わった",
  );
});

test("3 つ以上でも順に掛けられる", () => {
  const scene = sceneWithRects(
    rectShape("a", 0, 0, 1000, 1000),
    rectShape("b", 1000, 0, 2000, 1000),
    rectShape("c", 2000, 0, 3000, 1000),
  );
  assert.equal(combineShapes(scene, ["a", "b", "c"], "unite"), "a");
  const host = scene.shapes.a as { points: Vec[] };
  assert.ok(Math.abs(signedArea(host.points) - 3_000_000) < 1e-6);
  assert.equal(host.points.length, 4, "まっすぐ並んだ点が残っている");
});

test("閉じていない図形が混ざっていたら断る", () => {
  const scene = sceneWithRects(rectShape("a", 0, 0, 1000, 1000));
  scene.shapes.line = {
    id: "line",
    shape: "line",
    layerId: LAYER_IDS.shape,
    levelId: DEFAULT_LEVEL_ID,
    attrs: defaultAttrs(),
    a: vec(0, 0),
    b: vec(1000, 1000),
  } as never;
  const before = JSON.stringify(scene.shapes);
  assert.equal(combineShapes(scene, ["a", "line"], "unite"), null);
  assert.equal(
    JSON.stringify(scene.shapes),
    before,
    "断ったのに図面が変わった",
  );
});

test("画層と属性は母体のものを引き継ぐ", () => {
  const scene = sceneWithRects(
    rectShape("a", 0, 0, 1000, 1000),
    rectShape("b", 500, 500, 1500, 1500),
  );
  (scene.shapes.a as { layerId: string }).layerId = LAYER_IDS.draft;
  combineShapes(scene, ["a", "b"], "unite");
  assert.equal(
    (scene.shapes.a as { layerId: string }).layerId,
    LAYER_IDS.draft,
  );
});

test("浮動小数の屑が乗っていても、重なった辺として扱える", () => {
  // **実際に切り分けた立体の平面で起きた。** 90 度回した箱との交差で
  // 500 が 500.0000000000001 になり、重なるはずの辺がごくわずかに傾いた
  const dusty = [
    vec(0, 0),
    vec(1000.0000000000001, 0),
    vec(1000.0000000000001, 1000.0000000000002),
    vec(0, 999.9999999999999),
  ];
  const got = polyBoolean(dusty, R(1000, 0, 2000, 1000), "unite");
  assert.ok(got, "屑が乗っているだけで断られた");
  assert.equal(got.length, 4, "重なった辺として扱えていない");
  near(signedArea(got), 2_000_000, "合成");
});
