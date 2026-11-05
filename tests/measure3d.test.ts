import { test } from "node:test";
import assert from "node:assert/strict";
import { Measure3D, measurementFaces } from "../src/render3d/measure3d.ts";
import { DEFAULT_LEVEL_ID } from "../src/core/level.ts";
import { measuredDistance } from "../src/core/annotation.ts";
import { Store } from "../src/core/store.ts";
import { vec3, type Vec3 } from "../src/render3d/mat4.ts";
import type { Editor } from "../src/ui/editor.ts";
import type { Pointer3D } from "../src/render3d/interact.ts";

/**
 * 3D の中で距離を測る（第 6 版の 1 段目）。
 *
 * **実体は 1 つも変えていない。** `Measurement` は前から xyz を持っていて、
 * `measuredDistance` も z 込みで出していた。足りなかったのは**道具**だけ。
 * ここで見るのは「3D で拾った高さが落ちずに残ること」。
 */

/** 道具が触るところだけを備えた、最小の editor */
function fakeEditor(): { editor: Editor; store: Store; ui: number } {
  const store = new Store();
  const state = { ui: 0 };
  const editor = {
    store,
    notifyUi: () => void (state.ui += 1),
    requestRender: () => {},
  } as unknown as Editor;
  return {
    editor,
    store,
    get ui() {
      return state.ui;
    },
  };
}

/** 面の上の点を指しているポインタ。格子は切ってあるので丸められない */
function pointerAt(at: Vec3, normal: Vec3 = vec3(0, 0, 1)): Pointer3D {
  return {
    hit: {
      ref: null,
      point: at,
      face: {
        points: [],
        normal,
        color: "",
        bucket: "wall",
        ref: null,
        levelId: "lv-1",
      },
      distance: 1,
    },
    ray: { origin: vec3(0, 0, 10000), direction: vec3(0, 0, -1) },
    shift: false,
    alt: false,
    meta: false,
    button: 0,
  } as unknown as Pointer3D;
}

const click = (tool: Measure3D, editor: Editor, at: Vec3, n?: Vec3): void => {
  tool.onPointerMove(editor, pointerAt(at, n));
  tool.onPointerDown(editor, pointerAt(at, n));
};

test("3D で拾った 2 点の距離は、z 込みで出る", () => {
  const { editor, store } = fakeEditor();
  store.settings.snapGrid = false;
  const tool = new Measure3D();

  // 壁の面の上で、横に 3000・高さに 4000 離れた 2 点
  click(tool, editor, vec3(0, 0, 0), vec3(0, -1, 0));
  click(tool, editor, vec3(3000, 0, 4000), vec3(0, -1, 0));

  const list = Object.values(store.scene.measurements);
  assert.equal(list.length, 1, "計測が残っていない");
  assert.equal(list[0].a.z, 0);
  assert.equal(list[0].b.z, 4000, "高さが落ちている");
  assert.equal(measuredDistance(list[0]), 5000, "3-4-5 にならない");
});

test("2 点目を打つまでは何も残らない", () => {
  const { editor, store } = fakeEditor();
  store.settings.snapGrid = false;
  const tool = new Measure3D();
  click(tool, editor, vec3(0, 0, 0));
  assert.equal(Object.keys(store.scene.measurements).length, 0);
  assert.ok(tool.isActive(), "掴んでいる最中になっていない");
  assert.ok(tool.cancel(editor), "Esc で取り消せない");
  assert.ok(!tool.isActive());
});

test("同じ点を 2 度叩いても残らない", () => {
  const { editor, store } = fakeEditor();
  store.settings.snapGrid = false;
  const tool = new Measure3D();
  click(tool, editor, vec3(500, 500, 100));
  click(tool, editor, vec3(500, 500, 100));
  assert.equal(
    Object.keys(store.scene.measurements).length,
    0,
    "長さ 0 の計測が残った",
  );
});

test("測り終えると、次の計測のために 1 点目が外れる", () => {
  const { editor, store } = fakeEditor();
  store.settings.snapGrid = false;
  const tool = new Measure3D();
  click(tool, editor, vec3(0, 0, 0));
  click(tool, editor, vec3(1000, 0, 0));
  assert.ok(!tool.isActive(), "1 点目が残っている");
  click(tool, editor, vec3(0, 0, 0));
  click(tool, editor, vec3(0, 2000, 0));
  assert.equal(
    Object.keys(store.scene.measurements).length,
    2,
    "2 本目が測れない",
  );
});

test("undo 1 回で戻る（2D と同じ出口を通っている）", () => {
  const { editor, store } = fakeEditor();
  store.settings.snapGrid = false;
  const tool = new Measure3D();
  click(tool, editor, vec3(0, 0, 0));
  click(tool, editor, vec3(1000, 0, 500));
  assert.equal(Object.keys(store.scene.measurements).length, 1);
  store.undo();
  assert.equal(
    Object.keys(store.scene.measurements).length,
    0,
    "undo で戻らない",
  );
});

test("打っている最中は、印と線が面として出る", () => {
  // `Tool3D.overlay()` は `ctx` に直に描かず**面を返す**契約
  const { editor } = fakeEditor();
  const tool = new Measure3D();
  assert.equal(tool.overlay(editor).length, 0, "何も指していないのに出ている");
  tool.onPointerMove(editor, pointerAt(vec3(0, 0, 0)));
  const aimOnly = tool.overlay(editor).length;
  assert.ok(aimOnly > 0, "カーソルの印が出ていない");
  tool.onPointerDown(editor, pointerAt(vec3(0, 0, 0)));
  tool.onPointerMove(editor, pointerAt(vec3(2000, 0, 0)));
  const withLine = tool.overlay(editor);
  assert.ok(withLine.length > aimOnly, "測っている線が出ていない");
  for (const f of withLine) {
    assert.ok(f.points.length >= 3, "面になっていない");
    assert.ok(
      Math.abs(Math.hypot(f.normal.x, f.normal.y, f.normal.z) - 1) < 1e-6,
      "法線が単位でない",
    );
  }
});

test("z は階の床からの高さで持つ（2 階で倍に積み上がらない）", () => {
  // **コメントと同じ約束。** 描くときに `level.floorZ` を足し直すので、
  // ワールドの z をそのまま入れると 2 階で倍になる
  const { editor, store } = fakeEditor();
  store.settings.snapGrid = false;
  store.scene.levels[DEFAULT_LEVEL_ID].floorZ = 3000;
  const tool = new Measure3D();
  click(tool, editor, vec3(0, 0, 3000)); // 2 階の床の上
  click(tool, editor, vec3(0, 0, 5000)); // そこから 2000 上
  const m = Object.values(store.scene.measurements)[0];
  assert.equal(m.a.z, 0, "階の床が 0 になっていない");
  assert.equal(m.b.z, 2000);
  assert.equal(measuredDistance(m), 2000);
});

test("測った結果は、道具を離れても 3D に出る", () => {
  const { editor, store } = fakeEditor();
  store.settings.snapGrid = false;
  assert.equal(measurementFaces(store.scene).length, 0);
  const tool = new Measure3D();
  click(tool, editor, vec3(0, 0, 0));
  click(tool, editor, vec3(3000, 0, 0));
  assert.ok(
    measurementFaces(store.scene).length > 0,
    "確定したものが 3D から消えた",
  );

  // 画層を隠したら出ない（2D と同じ約束）
  const m = Object.values(store.scene.measurements)[0];
  store.scene.layers[m.layerId].visible = false;
  assert.equal(
    measurementFaces(store.scene).length,
    0,
    "隠した画層のものが出ている",
  );
});

test("確定したら、状況表示が始点待ちに戻る", () => {
  // **画面で見つけた。** `commit` は図面が変わったことしか知らせない
  const { editor, store } = fakeEditor();
  store.settings.snapGrid = false;
  const tool = new Measure3D();
  click(tool, editor, vec3(0, 0, 0));
  click(tool, editor, vec3(3000, 0, 0));
  assert.ok(
    tool.status().includes("始点"),
    `確定後の表示が「${tool.status()}」`,
  );
});
