import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraEye, defaultCamera, lookAt, orbit, pivotAround, flyOver,
} from '../src/render3d/camera.ts';
import { vec3 } from '../src/render3d/mat4.ts';
import { OpeningTool } from '../src/tools/opening.ts';

/**
 * 「いま何が効いているか」の持ち主をはっきりさせるための試験。
 *
 * **重なったモードは、画面のどこにも出ない形で壊れる。** 歩いている位置が
 * 1 回のドラッグで消える、2D と 3D の道具が同時に武装する、押しても何も
 * 起きない札が立ったまま——どれも例外は出ないので、試験で縛る。
 */

// --- 回る中心と、カメラの位置 ---

test('回る中心を移しても、目の位置は 1mm も動かない', () => {
  const cam = defaultCamera();
  flyOver(cam, vec3(4000, 3000, 0), 1500); // 歩いている位置
  const before = cameraEye(cam);

  pivotAround(cam, vec3(9000, 1000, 500));
  const after = cameraEye(cam);

  for (const k of ['x', 'y', 'z'] as const) {
    assert.ok(
      Math.abs(after[k] - before[k]) < 1e-6,
      `目の ${k} が ${before[k]} → ${after[k]} と動いた`,
    );
  }
  // 中心は移っている
  assert.deepEqual(
    [cam.target.x, cam.target.y, cam.target.z].map(Math.round),
    [9000, 1000, 500],
  );
});

test('注視点を置き換えると目も同じだけ飛ぶ（pivotAround が要る理由）', () => {
  // **`lookAt` は注視点を差し替えるだけ。** 目の位置はそこから導かれるので、
  // 「ここを中心に回す」つもりで呼ぶと視点ごと飛ぶ
  const cam = defaultCamera();
  flyOver(cam, vec3(4000, 3000, 0), 1500);
  const before = cameraEye(cam);
  lookAt(cam, vec3(9000, 1000, 500));
  const after = cameraEye(cam);
  assert.ok(
    Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) > 1000,
    '飛ばないなら pivotAround と区別が付かない',
  );
});

test('中心を移したあとも、回すと新しい中心のまわりを回る', () => {
  const cam = defaultCamera();
  const pivot = vec3(1000, 2000, 300);
  pivotAround(cam, pivot);
  const r = cam.distance;
  orbit(cam, 40, 15);
  const eye = cameraEye(cam);
  const d = Math.hypot(eye.x - pivot.x, eye.y - pivot.y, eye.z - pivot.z);
  assert.ok(Math.abs(d - r) < 1e-6, `中心からの距離が ${r} → ${d} と変わった`);
});

test('目の位置そのものを中心にはしない（向きが決まらない）', () => {
  const cam = defaultCamera();
  const eye = cameraEye(cam);
  const before = { ...cam };
  pivotAround(cam, eye);
  assert.deepEqual(
    [cam.target, cam.distance, cam.yaw, cam.pitch],
    [before.target, before.distance, before.yaw, before.pitch],
    'カメラが壊れた値になった',
  );
});

// --- 隠れた札 ---

const fieldOf = (tool: OpeningTool, label: string) =>
  (tool.options?.() ?? []).find(
    (f): f is Extract<ReturnType<NonNullable<OpeningTool['options']>>[number], { kind: 'select' }> =>
      f.kind === 'select' && f.label === label,
  );

test('「角に置く」は画面に出る（出ていないと、押しても何も起きない理由が分からない）', () => {
  const tool = new OpeningTool('window', 'window', '窓', 'S');
  const field = fieldOf(tool, '置き方');
  assert.ok(field, '「置き方」が出ていない');
  assert.equal(field.value, 'wall', '既定が壁の上でない');
  assert.deepEqual(field.options.map((o) => o.value), ['wall', 'corner']);

  field.onChange('corner');
  assert.equal(tool.corner, true, '角に切り替わっていない');
  assert.equal(fieldOf(tool, '置き方')?.value, 'corner', '画面に出ている値が追いついていない');

  fieldOf(tool, '置き方')!.onChange('wall');
  assert.equal(tool.corner, false, '壁の上に戻せない');
});

test('ドアには「置き方」を出さない（角に置く建具は窓だけ）', () => {
  const tool = new OpeningTool('door', 'door', 'ドア', 'D');
  assert.equal(fieldOf(tool, '置き方'), undefined, 'ドアに出ている');
});

test('選んだ品の名前と窓台が画面に出る', () => {
  // 掃き出し窓（窓台 0）を選んだあと、ショートカットで窓ツールに入り直しても
  // **床まで開いた窓が黙って置かれる**ことが無いように、何が効いているかを出す
  const tool = new OpeningTool('window', 'window', '窓', 'S');
  const notes = () =>
    (tool.options?.() ?? []).filter((f) => f.kind === 'note').map((f) => (f as { text: string }).text);
  assert.equal(notes().filter((t) => t.includes('窓台')).length, 0, '何も選んでいないのに出ている');

  tool.partLabel = '掃き出し窓';
  tool.sillHeight = 0;
  assert.ok(
    notes().some((t) => t.includes('掃き出し窓') && t.includes('窓台 0mm')),
    `品の名前と窓台が出ていない: ${JSON.stringify(notes())}`,
  );

  // 種類を変えたら、品の既定から離れたので名前は下ろす
  const kind = (tool.options?.() ?? []).find(
    (f): f is Extract<typeof f, { kind: 'select' }> => f.kind === 'select' && f.label === '種類',
  )!;
  kind.onChange('windowSliding');
  assert.equal(tool.partLabel, '', '種類を変えても品の名前が残っている');
});
