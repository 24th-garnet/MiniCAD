import { test } from "node:test";
import assert from "node:assert/strict";
import {
  edgeRings,
  hasCornerEdge,
  hasTopBottomEdge,
  insetOutline,
  maxInsetOf,
  EDGE_KINDS,
  type EdgeKind,
  type FixtureEdge,
} from "../src/core/edge3d.ts";
import {
  FIXTURE_SPECS,
  localOutline,
  type Fixture,
  type FixtureKind,
} from "../src/core/fixture.ts";
import {
  buildFixtureFaces,
  fixtureFingerprint,
} from "../src/render3d/fixture3d.ts";
import { defaultAttrs } from "../src/core/attrs.ts";
import { DEFAULT_LEVEL_ID } from "../src/core/level.ts";
import {
  cutCorners,
  cutCornersDetail,
  signedArea,
  sub,
  vec,
} from "../src/core/geometry.ts";
import { emptyScene, type Scene } from "../src/core/types.ts";
import type { Face3 } from "../src/render3d/mesh.ts";
import type { Vec3 } from "../src/render3d/mat4.ts";

/**
 * 上下の稜線の仕上げ（24 段）。テーパ・面取り・丸め。
 *
 * **稜線ではなく「高さ方向の輪郭」で表している。** 本来の 3D 面取りは
 * どの稜線を落とすかを選ぶもので、面の隣り合わせを知る構造（B-rep）が要る。
 * ここで見るのは、段を積んだ結果が**閉じていて、体積が素のものより小さい**こと。
 */

function put(
  scene: Scene,
  kind: FixtureKind,
  over: Partial<Fixture> = {},
): Fixture {
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
    base: 0,
    height: 1000,
    label: spec.defaultLabel,
    layerId: spec.defaultLayer,
    levelId: DEFAULT_LEVEL_ID,
    attrs: defaultAttrs(),
    ...over,
  };
  scene.fixtures.f = f;
  return f;
}

const facesOf = (scene: Scene): Face3[] => {
  const out: Face3[] = [];
  buildFixtureFaces(scene, "f", out);
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

/** 面積ベクトルの総和。閉じていれば 0 */
function closureResidual(faces: readonly Face3[]): number {
  let x = 0;
  let y = 0;
  let z = 0;
  let total = 0;
  for (const f of faces) {
    const p = f.points;
    let ax = 0;
    let ay = 0;
    let az = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      ax += a.y * b.z - a.z * b.y;
      ay += a.z * b.x - a.x * b.z;
      az += a.x * b.y - a.y * b.x;
    }
    x += ax;
    y += ay;
    z += az;
    total += Math.hypot(ax, ay, az);
  }
  return total === 0 ? 0 : Math.hypot(x, y, z) / total;
}

const BOX = { size: { w: 1000, h: 1000 }, height: 1000 } as const;

/** 仕上げだけ差し替えた 1000 角の箱 */
const makeBox = (edge: FixtureEdge | null): Fixture =>
  put(emptyScene(), "box", { ...BOX, edge });

test("段は下から上へ、高さが単調に増える", () => {
  for (const kind of EDGE_KINDS) {
    const rings = edgeRings({ kind, size: 100, where: "topBottom" }, 1000, 400);
    assert.ok(rings.length >= 2, `${kind}: 段が ${rings.length} 個`);
    assert.equal(rings[0].dz, 0, `${kind}: 下端から始まっていない`);
    assert.ok(
      Math.abs(rings[rings.length - 1].dz - 1000) < 1e-9,
      `${kind}: 上端で終わっていない`,
    );
    for (let i = 1; i < rings.length; i++) {
      assert.ok(
        rings[i].dz >= rings[i - 1].dz - 1e-9,
        `${kind}: 高さが戻っている`,
      );
      assert.ok(rings[i].inset >= -1e-9, `${kind}: 外へ膨らんでいる`);
    }
  }
});

test("大きさは高さと輪郭に収まるよう抑える", () => {
  // 抑えないと上下が交差して、体積が負の立体になる
  const huge = edgeRings(
    { kind: "chamfer", size: 99999, where: "topBottom" },
    1000,
    400,
  );
  for (const r of huge) assert.ok(r.inset <= 400 + 1e-9, `縮めすぎ ${r.inset}`);
  assert.ok(huge.every((r) => r.dz >= 0 && r.dz <= 1000));
  // 0 以下なら素のまま（2 段）
  assert.deepEqual(
    edgeRings({ kind: "fillet", size: 0, where: "topBottom" }, 1000, 400),
    [
      { dz: 0, inset: 0 },
      { dz: 1000, inset: 0 },
    ],
  );
});

test("縮めすぎた輪郭は null になる", () => {
  const square = [
    vec(-500, -500),
    vec(500, -500),
    vec(500, 500),
    vec(-500, 500),
  ];
  assert.ok(insetOutline(square, 100), "縮められるはずの量で null");
  assert.ok(signedArea(insetOutline(square, 100)!) > 0, "向きが変わった");
  assert.equal(insetOutline(square, 600), null, "潰れても null にならない");
  assert.ok(
    maxInsetOf(square) > 400 && maxInsetOf(square) < 500,
    `上限 ${maxInsetOf(square)}`,
  );
});

test("どの仕上げでも立体は閉じていて、素より小さくなる", () => {
  const plain = (() => {
    const scene = emptyScene();
    put(scene, "box", BOX);
    return volume(facesOf(scene));
  })();
  assert.ok(Math.abs(plain - 1e9) < 1, `素の体積 ${plain}`);

  for (const kind of EDGE_KINDS) {
    const scene = emptyScene();
    put(scene, "box", {
      ...BOX,
      edge: { kind, size: 200, where: "topBottom" },
    });
    const faces = facesOf(scene);
    assert.ok(
      closureResidual(faces) < 1e-9,
      `${kind}: 閉じていない（残差 ${closureResidual(faces)}）`,
    );
    const v = volume(faces);
    assert.ok(v > 0 && v < plain, `${kind}: 体積 ${v}（素は ${plain}）`);
  }
});

test("テーパは上だけ細り、高さは変わらない", () => {
  const scene = emptyScene();
  put(scene, "box", {
    ...BOX,
    edge: { kind: "taper", size: 250, where: "topBottom" },
  });
  const faces = facesOf(scene);
  const zs = faces.flatMap((f) => f.points.map((p) => p.z));
  assert.equal(Math.min(...zs), 0);
  assert.equal(Math.max(...zs), 1000);
  // 下端の広がりは元のまま、上端は縮んでいる
  const spanAt = (z: number): number => {
    const xs = faces.flatMap((f) =>
      f.points.filter((p) => Math.abs(p.z - z) < 1e-6).map((p) => p.x),
    );
    return Math.max(...xs) - Math.min(...xs);
  };
  assert.ok(Math.abs(spanAt(0) - 1000) < 1e-6, `下端 ${spanAt(0)}`);
  assert.ok(Math.abs(spanAt(1000) - 500) < 1e-6, `上端 ${spanAt(1000)}`);
});

test("面取りと丸めは上下とも縮み、真ん中は元のまま", () => {
  for (const kind of ["chamfer", "fillet"] as EdgeKind[]) {
    const scene = emptyScene();
    put(scene, "box", {
      ...BOX,
      edge: { kind, size: 200, where: "topBottom" },
    });
    const faces = facesOf(scene);
    const spanAt = (z: number): number => {
      const xs = faces.flatMap((f) =>
        f.points.filter((p) => Math.abs(p.z - z) < 1e-6).map((p) => p.x),
      );
      return xs.length === 0 ? NaN : Math.max(...xs) - Math.min(...xs);
    };
    assert.ok(Math.abs(spanAt(0) - 600) < 1e-6, `${kind}: 下端 ${spanAt(0)}`);
    assert.ok(
      Math.abs(spanAt(1000) - 600) < 1e-6,
      `${kind}: 上端 ${spanAt(1000)}`,
    );
    // **段の高さにしか頂点が無い。** 落とし終わる高さ（200）で元の幅に戻る
    assert.ok(
      Math.abs(spanAt(200) - 1000) < 1e-6,
      `${kind}: 下の落とし終わり ${spanAt(200)}`,
    );
    assert.ok(
      Math.abs(spanAt(800) - 1000) < 1e-6,
      `${kind}: 上の落とし始め ${spanAt(800)}`,
    );
  }
});

test("丸めは面取りより体積が大きい（膨らんでいるぶん）", () => {
  const of = (kind: EdgeKind): number => {
    const scene = emptyScene();
    put(scene, "box", {
      ...BOX,
      edge: { kind, size: 200, where: "topBottom" },
    });
    return volume(facesOf(scene));
  };
  assert.ok(
    of("fillet") > of("chamfer"),
    `丸め ${of("fillet")} / 面取り ${of("chamfer")}`,
  );
});

test("仕上げを変えると指紋が変わる", () => {
  const scene = emptyScene();
  const f = put(scene, "box", BOX);
  const plain = fixtureFingerprint(scene, "f");
  f.edge = { kind: "chamfer", size: 100, where: "topBottom" };
  const chamfered = fixtureFingerprint(scene, "f");
  assert.notEqual(chamfered, plain, "仕上げを付けても指紋が同じ");
  f.edge = { kind: "chamfer", size: 200, where: "topBottom" };
  assert.notEqual(
    fixtureFingerprint(scene, "f"),
    chamfered,
    "大きさを変えても指紋が同じ",
  );
});

test("押し出しで出来ていない立体では何も起きない", () => {
  // 階段・スロープ・回転体は段を積む作りではない。**付けても黙って無視する**
  for (const kind of ["stair", "slope", "sphere", "cone"] as FixtureKind[]) {
    const plainScene = emptyScene();
    put(plainScene, kind, { height: 1000 });
    const before = facesOf(plainScene).length;
    const scene = emptyScene();
    put(scene, kind, {
      height: 1000,
      edge: { kind: "chamfer", size: 100, where: "topBottom" },
    });
    assert.equal(
      facesOf(scene).length,
      before,
      `${kind}: 仕上げが効いてしまった`,
    );
  }
});

// ---------------------------------------------------------------------------
// 縦の稜線（第 6 版の 4 段目）
// ---------------------------------------------------------------------------

test("角を落とすと、輪郭の頂点が増える", () => {
  const sq = [vec(-500, -500), vec(500, -500), vec(500, 500), vec(-500, 500)];
  // 面取りは 1 つの角が 2 点になる
  assert.equal(cutCorners(sq, "chamfer", 100).length, 8);
  // 丸めは円弧ぶん刻まれる
  assert.ok(cutCorners(sq, "fillet", 100).length > 8);
  // 0 なら触らない
  assert.equal(cutCorners(sq, "chamfer", 0).length, 4);
});

test("面取りの面積は、落とした三角形ぶんだけ減る", () => {
  const sq = [vec(-500, -500), vec(500, -500), vec(500, 500), vec(-500, 500)];
  for (const size of [100, 250, 400]) {
    const got = signedArea(cutCorners(sq, "chamfer", size));
    // 直角の角を size だけ戻して結ぶと、1 つにつき size²/2 の三角形が落ちる
    assert.ok(
      Math.abs(got - (1000 * 1000 - (4 * (size * size)) / 2)) < 1e-6,
      `${size}: 面積が ${got}`,
    );
  }
});

test("落としすぎても潰れない（隣の辺の半分で止まる）", () => {
  const sq = [vec(-500, -500), vec(500, -500), vec(500, 500), vec(-500, 500)];
  for (const kind of ["chamfer", "fillet"] as const) {
    for (const size of [600, 5000]) {
      const got = cutCorners(sq, kind, size);
      assert.ok(signedArea(got) > 0, `${kind} ${size}: 裏返った`);
      assert.ok(signedArea(got) < 1000 * 1000, `${kind} ${size}: 大きくなった`);
    }
  }
  // 面取りを振り切ると、各辺の真ん中どうしを結んだ菱形になる
  const full = cutCorners(sq, "chamfer", 5000);
  assert.ok(Math.abs(signedArea(full) - 500000) < 1e-6, "菱形になっていない");
});

test("まっすぐな頂点は触らない", () => {
  // 辺の途中に点があっても、曲がっていなければ落とすものが無い
  const line = [
    vec(0, 0),
    vec(500, 0),
    vec(1000, 0),
    vec(1000, 1000),
    vec(0, 1000),
  ];
  const got = cutCorners(line, "chamfer", 100);
  assert.ok(
    got.some((p) => Math.abs(p.x - 500) < 1e-9 && Math.abs(p.y) < 1e-9),
    "まっすぐな点が消えた",
  );
});

test("へこんだ角でも、単純な多角形のまま", () => {
  const L = [
    vec(0, 0),
    vec(1000, 0),
    vec(1000, 400),
    vec(400, 400),
    vec(400, 1000),
    vec(0, 1000),
  ];
  for (const kind of ["chamfer", "fillet"] as const) {
    const got = cutCorners(L, kind, 100);
    assert.ok(signedArea(got) > 0, `${kind}: 反時計回りでなくなった`);
    assert.ok(got.length > L.length, `${kind}: 角が落ちていない`);
  }
});

test("「どの稜線か」で、上下と縦が別々に効く", () => {
  assert.equal(
    hasTopBottomEdge({ kind: "chamfer", size: 100, where: "topBottom" }),
    true,
  );
  assert.equal(
    hasCornerEdge({ kind: "chamfer", size: 100, where: "topBottom" }),
    false,
  );
  assert.equal(
    hasTopBottomEdge({ kind: "chamfer", size: 100, where: "corners" }),
    false,
  );
  assert.equal(
    hasCornerEdge({ kind: "chamfer", size: 100, where: "corners" }),
    true,
  );
  assert.equal(
    hasTopBottomEdge({ kind: "chamfer", size: 100, where: "all" }),
    true,
  );
  assert.equal(
    hasCornerEdge({ kind: "chamfer", size: 100, where: "all" }),
    true,
  );
  // **テーパは縦に意味が無い**（上へ行くほど細くする仕上げ）
  assert.equal(
    hasCornerEdge({ kind: "taper", size: 100, where: "all" }),
    false,
  );
  assert.equal(hasTopBottomEdge(null), false);
  assert.equal(hasCornerEdge(null), false);
});

test("縦の稜線は、平面の記号にも 3D にも同時に出る", () => {
  const plain = localOutline(makeBox(null));
  const cut = localOutline(
    makeBox({ kind: "chamfer", size: 150, where: "corners" }),
  );
  assert.equal(plain.length, 4);
  assert.equal(cut.length, 8, "平面の輪郭に角が出ていない");

  // 3D の側面も、落とした輪郭の辺の数になる
  const scene = emptyScene();
  put(scene, "box", {
    ...BOX,
    edge: { kind: "chamfer", size: 150, where: "corners" },
  });
  const faces = facesOf(scene);
  assert.ok(closureResidual(faces) < 1e-9, "角を落としたら水密でなくなった");
  // 上下に段は積まない（縦だけなので、まっすぐ押し出す）
  const tops = faces.filter((f) => f.normal.z > 0.9);
  assert.equal(tops.length, 1, "上面が 1 枚でない（段が積まれている）");
});

test("上下だけの仕上げでは、平面の輪郭は変わらない", () => {
  const plain = localOutline(makeBox(null));
  const topOnly = localOutline(
    makeBox({ kind: "chamfer", size: 150, where: "topBottom" }),
  );
  assert.deepEqual(topOnly, plain, "上下の仕上げで平面が変わった");
});

test("上下と縦を同時に効かせると、両方出る", () => {
  const scene = emptyScene();
  put(scene, "box", {
    ...BOX,
    edge: { kind: "chamfer", size: 120, where: "all" },
  });
  const faces = facesOf(scene);
  assert.ok(closureResidual(faces) < 1e-9, "水密でない");
  assert.equal(localOutline(scene.fixtures.f).length, 8, "縦が効いていない");
  // 上下に段が積まれる＝真上を向く面が 1 枚ではなくなる…とは限らないので、
  // 面の数で見る（まっすぐ押し出した場合より増える）
  const straight = emptyScene();
  put(straight, "box", {
    ...BOX,
    edge: { kind: "chamfer", size: 120, where: "corners" },
  });
  assert.ok(faces.length > facesOf(straight).length, "上下が効いていない");
});

test("「どの稜線か」が JSON の往復を生き延びる / 欄が無い古いファイルは上下だけ", async () => {
  const { serialize, deserialize } = await import("../src/io/scene.ts");
  const scene = emptyScene();
  put(scene, "box", {
    ...BOX,
    edge: { kind: "fillet", size: 120, where: "all" },
  });
  const back = deserialize(serialize(scene));
  assert.deepEqual(back.fixtures.f.edge, {
    kind: "fillet",
    size: 120,
    where: "all",
  });

  // 欄が無いもの＝縦が入る前に保存されたファイル
  const file = serialize(scene) as unknown as {
    scene: { fixtures: Record<string, { edge: Record<string, unknown> }> };
  };
  delete file.scene.fixtures.f.edge.where;
  const old = deserialize(file as never);
  assert.equal(
    old.fixtures.f.edge?.where,
    "topBottom",
    "古いファイルが縦まで落ちている",
  );
});

/**
 * 角を落とした辺が、元のどの辺から来たか（21 段）。
 *
 * **押し引きが掴むのは落とした後の面で、書き戻す先は落とす前の輪郭。**
 * この対応が狂うと、押すたびに角が二重に落ちる。
 */

const SQUARE = [
  vec(-500, -500),
  vec(500, -500),
  vec(500, 500),
  vec(-500, 500),
];

test("面取りでは、元の辺と角の切片が交互に並ぶ", () => {
  const got = cutCornersDetail(SQUARE, "chamfer", 100);
  assert.equal(got.outline.length, 8);
  // 角の切片が -1、元の辺が 0,1,2,3
  assert.deepEqual(got.edgeOrigin, [-1, 0, -1, 1, -1, 2, -1, 3]);
});

test("丸めでは、元の辺は 4 本だけで残りは角の切片", () => {
  const got = cutCornersDetail(SQUARE, "fillet", 100);
  const real = got.edgeOrigin.filter((o) => o >= 0);
  assert.deepEqual([...real].sort((a, b) => a - b), [0, 1, 2, 3]);
  // 円弧の分割がそのぶん -1 で埋まる
  assert.ok(
    got.edgeOrigin.length > 20,
    `分割されていない (${got.edgeOrigin.length})`,
  );
});

test("まっすぐな頂点が混ざっても、元の辺の番号がずれない", () => {
  // 右の辺の途中に、曲がらない頂点を 1 つ足す（落とされず 1 点のまま残る）
  const withStraight = [
    vec(-500, -500),
    vec(500, -500),
    vec(500, 0),
    vec(500, 500),
    vec(-500, 500),
  ];
  const got = cutCornersDetail(withStraight, "chamfer", 100);
  // 頂点 2 は触られないので、その両隣の辺 1 と 2 が**どちらも**元の辺として出る
  assert.deepEqual(got.edgeOrigin, [-1, 0, -1, 1, 2, -1, 3, -1, 4]);
});

test("元の辺だと言うからには、向きが元のままである", () => {
  // **これが本題。** 番号が合っていても向きが変わっていたら、
  // 押した先が元の輪郭で表せない
  for (const kind of ["chamfer", "fillet"] as const) {
    const got = cutCornersDetail(SQUARE, kind, 120);
    const m = got.outline.length;
    let checked = 0;
    for (let k = 0; k < m; k++) {
      const o = got.edgeOrigin[k];
      if (o < 0) continue;
      const cut = sub(got.outline[(k + 1) % m], got.outline[k]);
      const base = sub(SQUARE[(o + 1) % SQUARE.length], SQUARE[o]);
      // 外積が 0＝平行、内積が正＝同じ向き
      assert.ok(
        Math.abs(cut.x * base.y - cut.y * base.x) < 1e-6,
        `${kind}: 辺 ${o} の向きが傾いた`,
      );
      assert.ok(cut.x * base.x + cut.y * base.y > 0, `${kind}: 辺 ${o} が逆向き`);
      checked++;
    }
    assert.equal(checked, 4, `${kind}: 元の辺が 4 本そろっていない`);
  }
});

test("角を落とさないときは、辺の番号がそのまま", () => {
  const got = cutCornersDetail(SQUARE, "chamfer", 0);
  assert.deepEqual(got.outline, SQUARE);
  assert.deepEqual(got.edgeOrigin, [0, 1, 2, 3]);
  // 包みの `cutCorners` が同じ輪郭を返すことも見る
  assert.deepEqual(cutCorners(SQUARE, "chamfer", 0), got.outline);
});
