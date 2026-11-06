import { test } from "node:test";
import assert from "node:assert/strict";
import { PRO_NOT_YET } from "../src/ui/mode.ts";
import { Draw3D } from "../src/render3d/draw3d.ts";
import { aimOnPlane } from "../src/render3d/aim3d.ts";
import { Store } from "../src/core/store.ts";
import { DEFAULT_LEVEL_ID } from "../src/core/level.ts";
import { FIXTURE_SPECS, type Fixture } from "../src/core/fixture.ts";
import { defaultAttrs } from "../src/core/attrs.ts";
import { vec3, type Vec3 } from "../src/render3d/mat4.ts";
import type { Pointer3D } from "../src/render3d/interact.ts";
import type { Editor } from "../src/ui/editor.ts";

/**
 * 「まだ無いもの」の一覧が本当かどうか（21 段）。
 *
 * **できないことの一覧は、誰も裏を取らない。** できることは画面とテストが
 * 裏を取るが、できないことは実装が追い越しても落ちるものが無い。実際、
 * `PRO_NOT_YET` には長いあいだテストが 1 件も無く、画面に出ている導入文が
 * 「汎用ソリッドはまだありません」と事実の逆を言い続けていた。
 *
 * そこで一覧の**行ごとに、そう言える根拠のテストを 1 つずつ結びつける。**
 * 行を足しても減らしても、下の表を直さない限り落ちる。
 */

function fakeEditor(): { editor: Editor; store: Store } {
  const store = new Store();
  store.settings.snapGrid = false;
  const editor = {
    store,
    notifyUi: () => {},
    requestRender: () => {},
  } as unknown as Editor;
  return { editor, store };
}

function pointerAt(at: Vec3, normal: Vec3, button = 0): Pointer3D {
  return {
    screen: { x: 0, y: 0 },
    hit: {
      ref: null,
      point: at,
      face: {
        points: [],
        normal,
        color: "",
        bucket: "wall",
        ref: null,
        levelId: DEFAULT_LEVEL_ID,
      },
      distance: 1,
    },
    ray: {
      origin: vec3(
        at.x + normal.x * 5000,
        at.y + normal.y * 5000,
        at.z + normal.z * 5000,
      ),
      direction: vec3(-normal.x, -normal.y, -normal.z),
    },
    shift: false,
    alt: false,
    meta: false,
    button,
  } as unknown as Pointer3D;
}

/** 一覧の行 → そう言える根拠 */
const GROUNDS: Record<string, () => void> = {
  "3D の中で線を描く（多角形は描けます。線は 2D で引いてください）": () => {
    // 2 点だけ打って閉じようとしても、何も出来ない＝線は引けない
    const { editor, store } = fakeEditor();
    const tool = new Draw3D();
    const up = vec3(0, 0, 1);
    for (const at of [vec3(0, 0, 0), vec3(1000, 0, 0)]) {
      tool.onPointerMove(editor, pointerAt(at, up));
      tool.onPointerDown(editor, pointerAt(at, up));
    }
    // 右クリックは「その場で閉じる」。3 点無ければ何も作らない
    tool.onPointerDown(editor, pointerAt(vec3(1000, 0, 0), up, 2));
    assert.equal(
      Object.keys(store.scene.fixtures).length,
      0,
      "2 点で何かが出来てしまった（線が引けている）",
    );
    // 3 点目を足せば閉じられる＝多角形は描ける
    tool.onPointerMove(editor, pointerAt(vec3(1000, 1000, 0), up));
    tool.onPointerDown(editor, pointerAt(vec3(1000, 1000, 0), up));
    tool.onPointerDown(editor, pointerAt(vec3(1000, 1000, 0), up, 2));
    assert.equal(
      Object.keys(store.scene.fixtures).length,
      1,
      "3 点でも多角形が出来ない（根拠の立て方が間違っている）",
    );
  },

  "3D の頂点・辺へのスナップ（いまは床の格子と、指した面の上の点だけ）": () => {
    const { editor, store } = fakeEditor();
    // 角が (500, 500) にある箱を置く
    const f: Fixture = {
      id: "b",
      kind: "box",
      x: 0,
      y: 0,
      angle: 0,
      size: { w: 1000, h: 1000 },
      tilt: null,
      outline: null,
      combine: null,
      edge: null,
      base: 0,
      height: 1000,
      label: "箱",
      layerId: FIXTURE_SPECS.box.defaultLayer,
      levelId: DEFAULT_LEVEL_ID,
      attrs: defaultAttrs(),
    };
    store.scene.fixtures.b = f;
    // 角の 1mm 隣を指す。吸い付くなら角の座標が返るはず
    const near = vec3(501, 500, 1000);
    const aim = aimOnPlane(editor, pointerAt(near, vec3(0, 0, 1)));
    assert.ok(aim, "面の上を指せていない");
    assert.equal(aim.at.x, 501, "頂点に吸い付いた（一覧のほうが古い）");
    assert.equal(aim.at.y, 500);

    // **床の格子は効く。** 面を指していないときは床が作図面になり、
    // その原点はワールドの (0,0) なので丸めが意味を持つ
    store.settings.snapGrid = true;
    store.settings.gridSize = 500;
    const onFloor = { ...pointerAt(vec3(501, 500, 0), vec3(0, 0, 1)), hit: null };
    const floorAim = aimOnPlane(editor, onFloor as Pointer3D);
    assert.ok(floorAim, "床を指せていない");
    assert.equal(floorAim.at.x, 500, "床の格子に乗っていない");
  },
};

test("「まだ無いもの」の各行に、そう言える根拠がある", () => {
  // **行を足し引きするとここで落ちる。** 根拠の無い断り書きを残さないため
  assert.deepEqual(
    [...PRO_NOT_YET].sort(),
    Object.keys(GROUNDS).sort(),
    "一覧と根拠の表が食い違っている",
  );
});

for (const [claim, ground] of Object.entries(GROUNDS)) {
  test(`根拠: ${claim}`, ground);
}
