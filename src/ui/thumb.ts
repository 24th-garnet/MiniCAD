import { vec, type Vec } from '../core/geometry.ts';
import { newId } from '../core/id.ts';
import { defaultAttrs } from '../core/attrs.ts';
import { LAYER_IDS, getLayer } from '../core/layer.ts';
import { addWall, findOrCreateNode } from '../core/ops.ts';
import { emptyScene, type Opening, type Scene } from '../core/types.ts';
import type { Primitive } from '../core/primitive.ts';
import { openingPrimitives } from '../core/opening.ts';
import { wallOutline } from '../core/shape.ts';
import {
  FIXTURE_SPECS,
  fixturePrimitives,
  type Fixture,
  type FixtureKind,
} from '../core/fixture.ts';
import { Viewport } from '../render/viewport.ts';
import { drawPrimitives } from '../render/primitive.ts';
import type { Frame } from '../render/frame.ts';
import { defaultSettings } from '../core/store.ts';

/**
 * パーツ一覧の小さな絵。**自分の描画でそのまま作る。**
 *
 * ワイヤー（`ベース図面.html`）も Coohom も、パーツは絵付きのタイル。
 * いまの MiniCAD は文字ボタンが 60 個並ぶだけで、ここがいちばん古く見えていた。
 *
 * **画像ファイルは 1 枚も持たない。** 平面の記号を引くコードは
 * `fixturePrimitives` / `openingPrimitives` として既にあるので、
 * それを小さなキャンバスに 1 回描いて `dataURL` にする。おかげで
 * **記号を直せば絵も自動で追従する**——別に絵を描き起こすと、記号を直した
 * ときに絵だけ古いまま残り、パレットと図面で違うものが見えることになる。
 *
 * 実行時依存はゼロのまま。描くのは `OffscreenCanvas` ではなく普通の
 * `<canvas>`——`OffscreenCanvas` は Safari に無い。
 */

/** 絵の中の余白（画素）。記号が縁に触ると窮屈に見える */
const PAD = 5;

/**
 * 絵の大きさ（画素）。**正方形にしない。**
 *
 * 平面の建具は細長い——幅 1600mm に対して壁の厚みは 120mm しかない。
 * 40×40 に収めると壁の帯が 1.6px に潰れ、引き戸がただの線に見えた。
 * 横長にして横幅で合わせると、帯が 6px ほどになって「戸」に読める
 */
const THUMB_W = 96;
const THUMB_H = 40;

/** 1 度作った絵は使い回す。パーツは 60 個あり、束を開くたびに描き直すのは重い */
const cache = new Map<string, string>();

/**
 * 記号を 1 枚の `dataURL` にする。
 *
 * **範囲は記号自身から測る。** 品ごとに大きさが違う（柱 300mm、横連窓 3600mm）
 * ので、決め打ちの縮尺では小さすぎたり縁からはみ出したりする。
 */
function render(key: string, prims: Primitive[], scene: Scene, w: number, h: number): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const dpr = Math.min(3, Math.max(1, Math.round(globalThis.devicePixelRatio ?? 1)));
  const canvas = document.createElement('canvas');
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.scale(dpr, dpr);

  const box = bounds(prims);
  const vp = new Viewport();
  vp.resize(w, h);
  if (box) {
    // **縦横それぞれで合わせる。** 長いほうだけで決めると、細長い記号が
    // 短いほうの余白に埋もれて潰れる
    const spanX = Math.max(box.max.x - box.min.x, 1);
    const spanY = Math.max(box.max.y - box.min.y, 1);
    vp.scale = Math.min((w - PAD * 2) / spanX, (h - PAD * 2) / spanY);
    const cx = (box.min.x + box.max.x) / 2;
    const cy = (box.min.y + box.max.y) / 2;
    vp.origin = vec(w / 2 - cx * vp.scale, h / 2 + cy * vp.scale);
  }

  const frame: Frame = {
    ctx,
    vp,
    scene,
    rooms: [],
    settings: defaultSettings(),
    selected: new Set(),
    hover: null,
  };
  drawPrimitives(frame, prims, getLayer(scene.layers, LAYER_IDS.wall, LAYER_IDS.wall));

  const url = canvas.toDataURL();
  cache.set(key, url);
  return url;
}

/** 記号が占める範囲。線・円弧・文字をまとめて見る */
function bounds(prims: Primitive[]): { min: Vec; max: Vec } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const put = (p: Vec) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };
  for (const prim of prims) {
    switch (prim.kind) {
      case 'segments':
        for (const seg of prim.segments) {
          put(seg.a);
          put(seg.b);
        }
        break;
      case 'polygon':
        for (const p of prim.points) put(p);
        break;
      case 'arc':
        // 円弧は外接する正方形で足りる。端点だけだと膨らみが切れる
        put(vec(prim.center.x - prim.radius, prim.center.y - prim.radius));
        put(vec(prim.center.x + prim.radius, prim.center.y + prim.radius));
        break;
      case 'circle':
        put(vec(prim.center.x - prim.radius, prim.center.y - prim.radius));
        put(vec(prim.center.x + prim.radius, prim.center.y + prim.radius));
        break;
      default:
        // 文字など、場所だけ持つもの。**範囲には足さない**——
        // 符号の文字まで入れると記号が小さく潰れる
        break;
    }
  }
  return Number.isFinite(minX) ? { min: vec(minX, minY), max: vec(maxX, maxY) } : null;
}

/** 壁 1 本の上に建具を 1 つだけ置いたシーン。**記号を引くのに壁が要る** */
export function openingThumb(
  part: { label: string; kind: Opening['kind']; width?: number; leaves?: number; bay?: Opening['bay'] },
): string {
  const width = part.width ?? 1600;
  // 両端に壁を少し残す。**開口だけを切り出すと、壁のどこが開いたのか分からない**
  const span = width + Math.min(600, width * 0.5);
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(span, 0));
  const wall = addWall(scene, a, b, 120);
  if (!wall) return '';
  const opening: Opening = {
    id: newId('op'),
    wallId: wall.id,
    offset: span / 2,
    width,
    kind: part.kind,
    leaves: part.leaves ?? 2,
    // **符号は出さない。** 44px に文字を入れても読めず、記号だけ小さくなる
    designation: '',
    sillHeight: null,
    height: null,
    bay: part.bay ?? null,
    flipX: false,
    flipY: false,
    layerId: LAYER_IDS.opening,
    attrs: defaultAttrs(),
  };
  scene.openings[opening.id] = opening;
  /*
   * **壁も一緒に引く。** 建具の記号だけだと、引き戸は線 1 本にしか見えない
   * ——図面の上では壁の帯の中に収まって初めて「戸」に読める。
   * `wallOutline` は開口の分だけ切れた壁の面を返すので、そのまま足せば
   * 図面とまったく同じ絵になる
   */
  const prims: Primitive[] = [
    { kind: 'segments', segments: wallOutline(scene, wall) },
    ...openingPrimitives(scene, opening),
  ];
  return render(`op:${part.label}`, prims, scene, THUMB_W, THUMB_H);
}

/**
 * 構造物の記号。
 *
 * **階は既定のものを使う。** `fixturePrimitives` は階高から梁の下がりなどを
 * 決めるが、絵は平面なので高さは効かない。
 */
export function fixtureThumb(kind: FixtureKind): string {
  const spec = FIXTURE_SPECS[kind];
  const scene = emptyScene();
  const fixture: Fixture = {
    id: newId('f'),
    kind,
    x: 0,
    y: 0,
    angle: 0,
    size: spec.defaultSize,
    tilt: null,
    outline: null,
    combine: null,
    edge: null,
    base: null,
    height: null,
    label: spec.defaultLabel,
    layerId: spec.defaultLayer,
    levelId: scene.activeLevelId,
    attrs: defaultAttrs(),
  };
  // 文字の高さは図面と同じ規約から。絵の中では範囲に入れないので効かないが、
  // 引数を省くと既定が別の値になり、記号の中の文字だけ大きさが変わる
  const prims = fixturePrimitives(fixture, scene.standard.textHeight.furniture);
  return render(`fx:${kind}`, prims, scene, THUMB_W, THUMB_H);
}
