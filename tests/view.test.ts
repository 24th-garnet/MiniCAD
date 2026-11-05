import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activateView,
  activeView,
  captureView,
  clampOpacity,
  DEFAULT_VIEW_ID,
  viewsInOrder,
} from "../src/core/view.ts";
import { LAYER_IDS } from "../src/core/layer.ts";
import { emptyScene, newId } from "../src/core/types.ts";
import { deserialize, serialize } from "../src/io/scene.ts";
import { exportLossReport } from "../src/io/dxf.ts";

/** いまの状態を複製して 2 枚目の図面を作る */
function addView(scene: ReturnType<typeof emptyScene>, name: string): string {
  captureView(scene);
  const id = newId("vw");
  scene.views[id] = {
    id,
    name,
    scale: scene.standard.scale,
    layerStates: structuredClone(scene.views[scene.activeViewId].layerStates),
  };
  return id;
}

test("最初は図面が 4 枚あり、どれもいまの縮尺を持つ", () => {
  // ワイヤー 5 枚目の「初期表示」。注釈と寸法は**画層**なのでここには入れない
  const scene = emptyScene();
  assert.deepEqual(
    viewsInOrder(scene).map((v) => v.name),
    ["現状図", "レイアウト図", "天井伏図", "立面図"],
  );
  assert.equal(scene.activeViewId, DEFAULT_VIEW_ID, "現状図から始まらない");
  for (const v of viewsInOrder(scene)) {
    assert.equal(v.scale, scene.standard.scale, `${v.name}: 縮尺が違う`);
  }
});

test("初期の図面は、流儀で決まる違いだけを持つ", () => {
  const scene = emptyScene();
  const byName = (name: string) =>
    viewsInOrder(scene).find((v) => v.name === name)!;
  // **床置きの家具は天井を見上げた図に出ない**
  assert.equal(
    byName("天井伏図").layerStates[LAYER_IDS.furniture].visible,
    false,
  );
  // 施主に見せる図に構造の基準線は出さない
  assert.equal(
    byName("レイアウト図").layerStates[LAYER_IDS.axis].visible,
    false,
  );
  // 基準の 2 つは何も隠さない
  for (const name of ["現状図", "立面図"]) {
    assert.ok(
      Object.values(byName(name).layerStates).every((st) => st.visible),
      `${name}: 何かを隠している`,
    );
  }
  // **どの図面も全部の画層について意図を持つ。** 持たないと、切り替えた順で
  // 結果が変わる（画面で見つけた）
  const layers = Object.keys(scene.layers).sort();
  for (const v of viewsInOrder(scene)) {
    assert.deepEqual(
      Object.keys(v.layerStates).sort(),
      layers,
      `${v.name}: 欄が足りない`,
    );
  }
});

test("切り替えた順で結果が変わらない", () => {
  // 天井伏図（家具を隠す）を経由してからレイアウト図へ移っても、
  // レイアウト図では家具が出ていること
  const scene = emptyScene();
  const id = (name: string) =>
    viewsInOrder(scene).find((v) => v.name === name)!.id;
  activateView(scene, id("天井伏図"));
  assert.equal(scene.layers[LAYER_IDS.furniture].visible, false);
  activateView(scene, id("レイアウト図"));
  assert.equal(
    scene.layers[LAYER_IDS.furniture].visible,
    true,
    "レイアウト図に家具が出ない",
  );
  assert.equal(
    scene.layers[LAYER_IDS.axis].visible,
    false,
    "通り芯が消えていない",
  );
});

test("天井伏図に切り替えると家具が消え、現状図に戻すと出る", () => {
  const scene = emptyScene();
  const ceiling = viewsInOrder(scene).find((v) => v.name === "天井伏図")!.id;
  assert.equal(scene.layers[LAYER_IDS.furniture].visible, true);
  activateView(scene, ceiling);
  assert.equal(
    scene.layers[LAYER_IDS.furniture].visible,
    false,
    "家具が消えない",
  );
  activateView(scene, DEFAULT_VIEW_ID);
  assert.equal(
    scene.layers[LAYER_IDS.furniture].visible,
    true,
    "戻しても家具が出ない",
  );
});

test("図面を切り替えると画層と縮尺が入れ替わる", () => {
  const scene = emptyScene();
  const second = addView(scene, "天井伏図");

  // 2 枚目を作業中にして、画層と縮尺を変える
  assert.ok(activateView(scene, second));
  scene.layers[LAYER_IDS.furniture].visible = false;
  scene.layers[LAYER_IDS.wall].opacity = 0.3;
  scene.standard.scale = 50;
  captureView(scene);

  // 1 枚目に戻ると、元の状態が当たる
  assert.ok(activateView(scene, DEFAULT_VIEW_ID));
  assert.equal(
    scene.layers[LAYER_IDS.furniture].visible,
    true,
    "家具が消えたまま",
  );
  assert.equal(scene.layers[LAYER_IDS.wall].opacity, 1, "透過が残っている");
  assert.equal(scene.standard.scale, 100, "縮尺が戻っていない");

  // もう一度 2 枚目へ
  assert.ok(activateView(scene, second));
  assert.equal(scene.layers[LAYER_IDS.furniture].visible, false);
  assert.equal(scene.layers[LAYER_IDS.wall].opacity, 0.3);
  assert.equal(scene.standard.scale, 50);
});

test("切り替える前に、いまの状態が控えられる", () => {
  // **控えないと、触ったことが切り替えで消える**
  const scene = emptyScene();
  const second = addView(scene, "躯体図");
  scene.layers[LAYER_IDS.dimension].visible = false; // 控えずに切り替える
  activateView(scene, second);
  activateView(scene, DEFAULT_VIEW_ID);
  assert.equal(
    scene.layers[LAYER_IDS.dimension].visible,
    false,
    "触ったことが消えた",
  );
});

test("同じ図面への切り替えは何もしない", () => {
  const scene = emptyScene();
  scene.layers[LAYER_IDS.wall].visible = false;
  assert.equal(activateView(scene, DEFAULT_VIEW_ID), false);
  // 控えて当て直すと、layerStates を持たない画層の状態が消えうる
  assert.equal(scene.layers[LAYER_IDS.wall].visible, false);
});

test("知らない図面には切り替わらない", () => {
  const scene = emptyScene();
  assert.equal(activateView(scene, "いない"), false);
  assert.equal(scene.activeViewId, DEFAULT_VIEW_ID);
});

test("図面が JSON の往復を生き延びる", () => {
  const scene = emptyScene();
  const second = addView(scene, "天井伏図");
  activateView(scene, second);
  scene.layers[LAYER_IDS.furniture].visible = false;
  scene.layers[LAYER_IDS.wall].opacity = 0.25;
  scene.standard.scale = 50;
  captureView(scene);

  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.equal(viewsInOrder(back).length, 5, "初期の 4 枚＋足した 1 枚");
  assert.equal(back.activeViewId, second);
  assert.equal(back.views[second].name, "天井伏図");
  assert.equal(back.views[second].scale, 50);
  assert.equal(
    back.views[second].layerStates[LAYER_IDS.furniture].visible,
    false,
  );
  assert.equal(back.views[second].layerStates[LAYER_IDS.wall].opacity, 0.25);
});

test("図面を持たない古いファイルは 1 枚に落ちる", () => {
  const raw = {
    format: "minicad",
    version: 10,
    unit: "mm",
    scene: { standard: { scale: 30 } },
  };
  const scene = deserialize(raw);
  assert.deepEqual(Object.keys(scene.views), [DEFAULT_VIEW_ID]);
  assert.equal(
    activeView(scene).scale,
    30,
    "そのときの縮尺が引き継がれていない",
  );
});

test("知らない画層を指す欄は捨てる", () => {
  const raw = {
    format: "minicad",
    version: 11,
    unit: "mm",
    scene: {
      views: {
        v1: {
          name: "X",
          scale: 100,
          layerStates: { wall: { visible: false }, いない: { visible: false } },
        },
      },
      activeViewId: "v1",
    },
  };
  const scene = deserialize(raw);
  assert.deepEqual(Object.keys(scene.views.v1.layerStates), ["wall"]);
});

test("不透明度は 0〜1 に収まる", () => {
  assert.equal(clampOpacity(1.5), 1);
  assert.equal(clampOpacity(-1), 0);
  assert.equal(clampOpacity("半分"), 1, "数でなければ不透明");
  assert.equal(clampOpacity(NaN), 1);
  assert.equal(clampOpacity(0.4), 0.4);
});

test("書き出しで落ちるものを報告する", () => {
  // **持っていないものは、持っていないと書く**
  const scene = emptyScene();
  // **図面は最初から 4 枚ある**ので、書き出すのが 1 枚だけだと必ず断りが出る
  const fresh = exportLossReport(scene);
  assert.equal(fresh.length, 1, `新しい図面の報告が ${fresh.length} 件`);
  assert.match(fresh[0], /図面は 4 枚/);

  scene.layers[LAYER_IDS.wall].opacity = 0.5;
  const faded = exportLossReport(scene);
  assert.equal(faded.length, 2);
  assert.match(faded[0], /透過を落としました/);
  assert.match(faded[0], /50%/);

  addView(scene, "5 枚目");
  const many = exportLossReport(scene);
  assert.match(many[1], /図面は 5 枚/);
});

test("隠した画層の透過は報告しない", () => {
  // 見えていないものの透過が落ちても、受け取った側に違いは出ない
  const scene = emptyScene();
  scene.layers[LAYER_IDS.wall].opacity = 0.5;
  scene.layers[LAYER_IDS.wall].visible = false;
  assert.ok(
    exportLossReport(scene).every((line) => !line.includes("透過")),
    "隠した画層の透過を報告した",
  );
});
