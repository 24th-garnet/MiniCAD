import { test } from "node:test";
import assert from "node:assert/strict";
import { Comment3D } from "../src/render3d/comment3d.ts";
import type { CommentAnchor } from "../src/core/annotation.ts";
import { DEFAULT_LEVEL_ID } from "../src/core/level.ts";
import { Store } from "../src/core/store.ts";
import { vec3, type Vec3 } from "../src/render3d/mat4.ts";
import type { Editor } from "../src/ui/editor.ts";
import type { Pointer3D } from "../src/render3d/interact.ts";
import type { EntityRef } from "../src/core/types.ts";

/**
 * 3D でコメントを置く（第 6 版の 2 段目）。
 *
 * **MiniCAD は点を置いてホストに知らせるだけ。** 本文もリプライも解決状態も
 * ホストの仕事。ここで見るのは「**シーンを一切変えない**こと」と
 * 「拾った高さが落ちないこと」。
 */

function fakeEditor(): { editor: Editor; store: Store } {
  const store = new Store();
  const editor = {
    store,
    comments: [] as CommentAnchor[],
    notifyUi: () => {},
    requestRender: () => {},
  } as unknown as Editor;
  return { editor, store };
}

function pointerAt(at: Vec3, ref: EntityRef | null = null): Pointer3D {
  return {
    hit: {
      ref,
      point: at,
      face: {
        points: [],
        normal: vec3(0, 0, 1),
        color: "",
        bucket: "wall",
        ref,
        levelId: DEFAULT_LEVEL_ID,
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

const click = (
  tool: Comment3D,
  editor: Editor,
  at: Vec3,
  ref: EntityRef | null = null,
): void => {
  tool.onPointerMove(editor, pointerAt(at, ref));
  tool.onPointerDown(editor, pointerAt(at, ref));
};

test("3D で置いたコメントは、xyz 付きでホストへ届く", () => {
  const { editor, store } = fakeEditor();
  store.settings.snapGrid = false;
  const tool = new Comment3D();
  const sent: CommentAnchor[] = [];
  tool.onPlace = (a) => void sent.push(a);

  click(tool, editor, vec3(1200, -400, 1800));
  assert.equal(sent.length, 1, "ホストへ届いていない");
  assert.equal(sent[0].at.x, 1200);
  assert.equal(sent[0].at.y, -400);
  assert.equal(sent[0].at.z, 1800, "高さが落ちている");
  assert.equal(sent[0].levelId, DEFAULT_LEVEL_ID);
});

test("シーンは一切変わらない（図面の一部ではない）", () => {
  const { editor, store } = fakeEditor();
  store.settings.snapGrid = false;
  const before = JSON.stringify(store.scene);
  const tool = new Comment3D();
  click(tool, editor, vec3(0, 0, 500));
  assert.equal(JSON.stringify(store.scene), before, "シーンが変わった");
  assert.equal(editor.comments.length, 1, "画面に先に出ていない");
});

test("下に何かあれば紐づけ、無ければ空間の点", () => {
  const { editor, store } = fakeEditor();
  store.settings.snapGrid = false;
  const tool = new Comment3D();
  const ref: EntityRef = { type: "wall", id: "w1" };
  click(tool, editor, vec3(0, 0, 0), ref);
  assert.deepEqual(editor.comments[0].ref, ref);
  click(tool, editor, vec3(100, 0, 0), null);
  assert.equal(editor.comments[1].ref, null);
});

test("z は階の床からの高さで持つ", () => {
  // コメントのバッジは `level.floorZ + at.z` で描かれる（`commentScreen`）
  const { editor, store } = fakeEditor();
  store.settings.snapGrid = false;
  store.scene.levels[DEFAULT_LEVEL_ID].floorZ = 3000;
  const tool = new Comment3D();
  click(tool, editor, vec3(0, 0, 4200));
  assert.equal(editor.comments[0].at.z, 1200, "階の床を引いていない");
});

test("置ける場所の印が面として出る", () => {
  const { editor } = fakeEditor();
  const tool = new Comment3D();
  assert.equal(tool.overlay(editor).length, 0, "何も指していないのに出ている");
  tool.onPointerMove(editor, pointerAt(vec3(0, 0, 0)));
  const faces = tool.overlay(editor);
  assert.ok(faces.length > 0, "印が出ていない");
  for (const f of faces) assert.ok(f.points.length >= 3, "面になっていない");
  // **図面の実体ではない。** 拾う側から見ても図面に属さない
  for (const f of faces) assert.equal(f.ref, null);
});

test("1 クリックで置くので、Esc で取り消すものが無い", () => {
  const tool = new Comment3D();
  assert.equal(tool.isActive(), false);
  assert.equal(tool.cancel(), false);
});
