import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleScene } from '../src/io/sample.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { render } from '../src/render/renderer.ts';
import { Viewport } from '../src/render/viewport.ts';
import { defaultSettings } from '../src/core/store.ts';
import { sceneToSvg } from '../src/io/svg.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { pickAt } from '../src/core/pick.ts';
import { vec } from '../src/core/geometry.ts';
import { addConstraint } from '../src/core/constraintOps.ts';

/** 呼ばれたメソッドを記録するだけの CanvasRenderingContext2D 代替 */
function stubContext() {
  const calls: string[] = [];
  const noop =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(name);
      for (const a of args) {
        if (typeof a === 'number' && !Number.isFinite(a)) {
          throw new Error(`${name} に有限でない数値が渡されました: ${String(a)}`);
        }
      }
    };
  const ctx: Record<string, unknown> = {
    save: noop('save'),
    restore: noop('restore'),
    beginPath: noop('beginPath'),
    closePath: noop('closePath'),
    moveTo: noop('moveTo'),
    lineTo: noop('lineTo'),
    rect: noop('rect'),
    arc: noop('arc'),
    ellipse: noop('ellipse'),
    fill: noop('fill'),
    stroke: noop('stroke'),
    fillRect: noop('fillRect'),
    strokeRect: noop('strokeRect'),
    fillText: noop('fillText'),
    translate: noop('translate'),
    rotate: noop('rotate'),
    setLineDash: noop('setLineDash'),
    measureText: (t: string) => ({ width: t.length * 6 }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

test('サンプル間取りが例外なく描画できる', () => {
  const scene = sampleScene();
  const rooms = detectRooms(scene);
  assert.equal(rooms.length, 3, `検出された部屋: ${rooms.map((r) => r.name).join(',')}`);
  assert.deepEqual(
    rooms.map((r) => r.name).sort(),
    ['LDK', '水まわり', '洋室'].sort(),
  );

  const vp = new Viewport();
  vp.resize(1200, 800);
  vp.fit({ min: vec(0, 0), max: vec(8000, 6000) });

  const { ctx, calls } = stubContext();
  render({ ctx, vp, scene, rooms, settings: defaultSettings(), selected: new Set(), hover: null });

  assert.ok(calls.filter((c) => c === 'fill').length > 10, '塗りが呼ばれていない');
  assert.ok(calls.includes('fillText'), '文字が描かれていない');
  assert.ok(calls.includes('arc'), 'ドアの開き軌跡が描かれていない');
});

test('サンプル間取りの面積が妥当な範囲に収まる', () => {
  const rooms = detectRooms(sampleScene());
  const total = rooms.reduce((s, r) => s + r.area, 0);
  // 壁芯ポリゴンは隙間なく敷き詰まるので、合計は外周 8.0m x 6.0m = 48m2 ちょうどになる
  assert.ok(Math.abs(total - 48) < 1e-6, `総面積 ${total}`);
  const inner = rooms.reduce((s, r) => s + r.innerArea, 0);
  // 内法の合計は壁の分だけ必ず小さい
  assert.ok(inner < total - 3, `内法合計 ${inner}`);
  const ldk = rooms.find((r) => r.name === 'LDK')!;
  assert.ok(ldk.innerArea < ldk.area, '内法面積が壁芯面積を上回っている');
});

test('JSON に保存して読み戻しても内容が一致する', () => {
  const scene = sampleScene();
  const restored = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.deepEqual(Object.keys(restored.walls).sort(), Object.keys(scene.walls).sort());
  assert.deepEqual(Object.keys(restored.openings).sort(), Object.keys(scene.openings).sort());
  assert.equal(detectRooms(restored).length, 3);
});

test('壊れた JSON は読み込み時に弾かれる', () => {
  assert.throws(() => deserialize(null));
  // 存在しないノードを指す壁は捨てられる
  const broken = deserialize({ nodes: {}, walls: { w1: { a: 'nope', b: 'nope' } } });
  assert.equal(Object.keys(broken.walls).length, 0);
});

test('SVG 書き出しが有限な数値だけを含む', () => {
  const scene = sampleScene();
  const svg = sceneToSvg(scene, detectRooms(scene), defaultSettings());
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.trimEnd().endsWith('</svg>'));
  assert.ok(!/NaN|Infinity|undefined/.test(svg), 'SVG に不正な値が含まれている');
  assert.ok(svg.includes('LDK'));
});

test('SVG のタグが XML として壊れていない', () => {
  const scene = sampleScene();
  const svg = sceneToSvg(scene, detectRooms(scene), defaultSettings());
  // 属性値のエスケープ漏れは引用符の数の偶奇に出る
  // （フォント名の "Hiragino Sans" のような値をそのまま埋めると壊れる）
  for (const tag of svg.match(/<[^>]*>/g) ?? []) {
    const quotes = (tag.match(/"/g) ?? []).length;
    assert.equal(quotes % 2, 0, `属性値の引用符が閉じていない: ${tag.slice(0, 120)}`);
  }
  // 開きタグと閉じタグの数が釣り合っている
  const open = (svg.match(/<(?!\/)(?!!)[a-zA-Z]/g) ?? []).length;
  const selfClosing = (svg.match(/\/>/g) ?? []).length;
  const close = (svg.match(/<\/[a-zA-Z]/g) ?? []).length;
  assert.equal(open - selfClosing, close, '開きタグと閉じタグの数が合わない');
});

test('クリック位置から壁とブロックを拾える', () => {
  const scene = sampleScene();
  // 南側の外壁 (y=0) のうち、窓が開いていない部分
  const onWall = pickAt(scene, vec(500, 0), 80);
  assert.equal(onWall?.type, 'wall');
  // ソファの中心
  const sofa = Object.values(scene.instances).find((i) => i.blockId === 'sofa')!;
  const onSofa = pickAt(scene, vec(sofa.x, sofa.y), 80);
  assert.equal(onSofa?.type, 'blockInstance');
  assert.equal(onSofa?.id, sofa.id);
  // 何もない場所
  assert.equal(pickAt(scene, vec(3000, 2500), 20), null);
  // 窓の真上は開口部として拾われる
  assert.equal(pickAt(scene, vec(2000, 0), 80)?.type, 'opening');
});

test('拘束の記号が描かれ、違反は別の色になる', () => {
  const scene = sampleScene();
  const wall = Object.values(scene.walls)[0];
  const c = addConstraint(scene, 'horizontal', [wall.id])!;
  assert.ok(c, '拘束を付けられない');

  const vp = new Viewport();
  vp.resize(1200, 800);
  vp.fit({ min: vec(0, 0), max: vec(8000, 6000) });

  const draw = (violated: Set<string>, showConstraints: boolean) => {
    const { ctx, calls } = stubContext();
    render({
      ctx,
      vp,
      scene,
      rooms: detectRooms(scene),
      settings: { ...defaultSettings(), showConstraints },
      selected: new Set(),
      hover: null,
      violated,
    });
    return calls;
  };

  const withSymbol = draw(new Set(), true).filter((x) => x === 'fillText').length;
  const without = draw(new Set(), false).filter((x) => x === 'fillText').length;
  assert.equal(withSymbol, without + 1, '拘束の記号が1つ増えていない');

  // 違反していても落ちない（色が変わるだけ）
  assert.doesNotThrow(() => draw(new Set([c.id]), true));
});
