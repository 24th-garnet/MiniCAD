import { test } from "node:test";
import assert from "node:assert/strict";
import { Draw3D } from "../src/render3d/draw3d.ts";
import {
  localOutline,
  rotateToWorld,
  type Fixture,
} from "../src/core/fixture.ts";
import { signedArea } from "../src/core/geometry.ts";
import { DEFAULT_LEVEL_ID, defaultLevel } from "../src/core/level.ts";
import { Store } from "../src/core/store.ts";
import { buildFixtureFaces } from "../src/render3d/fixture3d.ts";
import {
  dot3,
  normalize3,
  sub3,
  vec3,
  type Vec3,
} from "../src/render3d/mat4.ts";
import type { Face3 } from "../src/render3d/mesh.ts";
import type { Editor } from "../src/ui/editor.ts";
import type { Pointer3D } from "../src/render3d/interact.ts";

/**
 * 作図面の上に多角形を描いて立体にする（第 6 版の 3 段目）。
 *
 * **新しい実体は 1 つも足していない。** 7 段目（第 5 版）の `tiltTo` が
 * 入ったおかげで、作図面の上の多角形は**傾きつきの押し出し立体**で表せる。
 * ここで見るのは「**底面が作図面に乗っていること**」。
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
    // 固定した面に当てる光線。法線の逆向きから入る
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

const click = (
  tool: Draw3D,
  editor: Editor,
  at: Vec3,
  n: Vec3,
  button = 0,
): void => {
  tool.onPointerMove(editor, pointerAt(at, n, button));
  tool.onPointerDown(editor, pointerAt(at, n, button));
};

/** 面の上の点だけを並べた四角形を描いて、出来た立体を返す */
function drawSquare(
  editor: Editor,
  store: Store,
  normal: Vec3,
  pts: Vec3[],
  finish: "right" | "first",
): Fixture | null {
  const tool = new Draw3D();
  for (const q of pts) click(tool, editor, q, normal);
  if (finish === "right") click(tool, editor, pts[0], normal, 2);
  else click(tool, editor, pts[0], normal);
  const list = Object.values(store.scene.fixtures);
  return list[list.length - 1] ?? null;
}

const facesOf = (store: Store, f: Fixture): Face3[] => {
  const out: Face3[] = [];
  buildFixtureFaces(store.scene, f.id, out);
  return out;
};

test("立った作図面の上に描くと、底面がその面に張り付く", () => {
  const { editor, store } = fakeEditor();
  // 南を向いた壁の面（法線 -y）。面の上で縦横に 4 点
  const n = vec3(0, -1, 0);
  const pts = [
    vec3(0, 2000, 500),
    vec3(1500, 2000, 500),
    vec3(1500, 2000, 1300),
    vec3(0, 2000, 1300),
  ];
  const f = drawSquare(editor, store, n, pts, "right");
  assert.ok(f, "立体が出来ていない");
  assert.equal(f.kind, "extrusion");
  assert.ok(f.tilt, "傾きが付いていない");

  // 底面（ローカル −z）の 4 隅が、作図面（y = 2000）から浮いていないこと
  const faces = facesOf(store, f);
  const bottom = faces.find(
    (fc) =>
      Math.hypot(fc.normal.x - -n.x, fc.normal.y - -n.y, fc.normal.z - -n.z) <
      1e-6,
  );
  assert.ok(bottom, "底面が作図面と平行でない");
  for (const q of bottom.points) {
    assert.ok(
      Math.abs(q.y - 2000) < 1e-6,
      `底面の点が面から ${q.y - 2000}mm 浮いている`,
    );
  }
});

test("描いた点が、そのまま立体の底面の隅になる", () => {
  const { editor, store } = fakeEditor();
  const n = vec3(0, -1, 0);
  const pts = [
    vec3(0, 2000, 500),
    vec3(1500, 2000, 500),
    vec3(1500, 2000, 1300),
    vec3(0, 2000, 1300),
  ];
  const f = drawSquare(editor, store, n, pts, "right")!;
  // ローカルの輪郭をワールドへ戻すと、打った点に戻る
  const level = defaultLevel();
  const world = localOutline(f).map((p) => {
    const d = rotateToWorld(f, vec3(p.x, p.y, 0));
    return vec3(f.x + d.x, f.y + d.y, level.floorZ + (f.base ?? 0) + d.z);
  });
  for (const want of pts) {
    assert.ok(
      world.some(
        (q) => Math.hypot(q.x - want.x, q.y - want.y, q.z - want.z) < 1e-6,
      ),
      `打った点 (${want.x}, ${want.y}, ${want.z}) が隅に無い`,
    );
  }
});

/** 当たった面と、カーソルの光線を別々に指定する */
function pointerSplit(
  hitPoint: Vec3,
  hitNormal: Vec3,
  rayOrigin: Vec3,
  rayDir: Vec3,
): Pointer3D {
  return {
    screen: { x: 0, y: 0 },
    hit: {
      ref: null,
      point: hitPoint,
      face: {
        points: [],
        normal: hitNormal,
        color: "",
        bucket: "wall",
        ref: null,
        levelId: DEFAULT_LEVEL_ID,
      },
      distance: 1,
    },
    ray: { origin: rayOrigin, direction: rayDir },
    shift: false,
    alt: false,
    meta: false,
    button: 0,
  } as unknown as Pointer3D;
}

test("1 点目で作図面が決まり、以後は別の面を指しても動かない", () => {
  // **動くと 2 点目が別の面に落ちて、平らでない多角形になる。**
  // 2 点目以降はカーソルの光線を固定した面に当てた点を使う
  const { editor, store } = fakeEditor();
  const wall = vec3(0, -1, 0);
  const tool = new Draw3D();
  click(tool, editor, vec3(0, 2000, 500), wall);

  // 2 点目は「床に当たっている」ことにして、光線は壁の面（y = 2000）を
  // (1500, 2000, 500) で貫く。面が動かなければ、こちらが採られる
  for (const [hx, hz] of [
    [1500, 500],
    [1500, 1300],
  ] as const) {
    const p = pointerSplit(
      vec3(hx, 400, 0), // 床に当たった点（面の外）
      vec3(0, 0, 1), // 床の法線
      vec3(hx, -3000, hz),
      vec3(0, 1, 0),
    );
    tool.onPointerMove(editor, p);
    tool.onPointerDown(editor, p);
  }
  click(tool, editor, vec3(0, 2000, 1300), wall, 2);

  const f = Object.values(store.scene.fixtures)[0];
  assert.ok(f, "立体が出来ていない");
  const level = defaultLevel();
  const world = localOutline(f).map((q) => {
    const d = rotateToWorld(f, vec3(q.x, q.y, 0));
    return vec3(f.x + d.x, f.y + d.y, level.floorZ + (f.base ?? 0) + d.z);
  });
  for (const q of world) {
    assert.ok(
      Math.abs(q.y - 2000) < 1e-6,
      `点が作図面から ${q.y - 2000}mm 外れた`,
    );
  }
  // 床の点 (y = 400) を採っていたら、x の広がりは残るが y がばらける
  assert.ok(
    world.some((q) => Math.abs(q.x - 1500) < 1e-6),
    "光線を面に当てた点が採られていない",
  );
});

test("時計回りに描いても、輪郭は反時計回りに揃う", () => {
  // 時計回りのまま押し出すと法線が内を向き、見えているのにクリックが素通りする
  const { editor, store } = fakeEditor();
  const n = vec3(0, 0, 1);
  const cw = [
    vec3(0, 0, 0),
    vec3(0, 1000, 0),
    vec3(1000, 1000, 0),
    vec3(1000, 0, 0),
  ];
  const f = drawSquare(editor, store, n, cw, "right")!;
  assert.ok(signedArea(localOutline(f)) > 0, "輪郭が時計回りのまま");
  // 法線は全部外を向く
  for (const face of facesOf(store, f)) {
    const centre = face.points.reduce(
      (t, q) =>
        vec3(
          t.x + q.x / face.points.length,
          t.y + q.y / face.points.length,
          t.z + q.z / face.points.length,
        ),
      vec3(0, 0, 0),
    );
    const inside = vec3(500, 500, 500);
    const outward = normalize3(sub3(centre, inside), vec3(0, 0, 1));
    assert.ok(dot3(face.normal, outward) > -0.2, "法線が内を向いている");
  }
});

test("1 点目をクリックしても閉じられる", () => {
  const { editor, store } = fakeEditor();
  const n = vec3(0, 0, 1);
  const pts = [vec3(0, 0, 0), vec3(1000, 0, 0), vec3(1000, 1000, 0)];
  const f = drawSquare(editor, store, n, pts, "first");
  assert.ok(f, "1 点目で閉じられない");
  assert.equal(localOutline(f).length, 3, "三角形になっていない");
});

test("3 点に満たなければ立体にならない", () => {
  const { editor, store } = fakeEditor();
  const n = vec3(0, 0, 1);
  const tool = new Draw3D();
  click(tool, editor, vec3(0, 0, 0), n);
  click(tool, editor, vec3(1000, 0, 0), n);
  click(tool, editor, vec3(0, 0, 0), n, 2); // 右クリックで閉じようとする
  assert.equal(
    Object.keys(store.scene.fixtures).length,
    0,
    "2 点で立体が出来た",
  );
  assert.ok(tool.isActive(), "打った点が捨てられている");
});

test("自己交差した形は断る", () => {
  const { editor, store } = fakeEditor();
  const n = vec3(0, 0, 1);
  // 蝶の形
  const bow = [
    vec3(0, 0, 0),
    vec3(1000, 1000, 0),
    vec3(1000, 0, 0),
    vec3(0, 1000, 0),
  ];
  const f = drawSquare(editor, store, n, bow, "right");
  assert.equal(f, null, "自己交差した形が立体になった");
  assert.ok(new Draw3D().status().length > 0);
});

test("Esc で取り消せる", () => {
  const { editor, store } = fakeEditor();
  const n = vec3(0, 0, 1);
  const tool = new Draw3D();
  click(tool, editor, vec3(0, 0, 0), n);
  click(tool, editor, vec3(1000, 0, 0), n);
  assert.ok(tool.isActive());
  assert.ok(tool.cancel(editor));
  assert.ok(!tool.isActive());
  assert.equal(Object.keys(store.scene.fixtures).length, 0);
});

test("undo 1 回で戻る（2D と同じ出口を通っている）", () => {
  const { editor, store } = fakeEditor();
  const n = vec3(0, 0, 1);
  drawSquare(
    editor,
    store,
    n,
    [vec3(0, 0, 0), vec3(1000, 0, 0), vec3(1000, 1000, 0)],
    "right",
  );
  assert.equal(Object.keys(store.scene.fixtures).length, 1);
  store.undo();
  assert.equal(Object.keys(store.scene.fixtures).length, 0, "undo で戻らない");
});
