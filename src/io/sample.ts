import { defaultAttrs } from '../core/attrs.ts';
import { createWallDimensions } from '../core/dimension.ts';
import { vec } from '../core/geometry.ts';
import { OPENING_SYMBOLS } from '../core/opening.ts';
import { LAYER_IDS } from '../core/layer.ts';
import { addWall, findOrCreateNode } from '../core/ops.ts';
import { emptyScene, newId, type Opening, type OpeningKind, type Scene } from '../core/types.ts';
import { BLOCK_PRESETS } from '../core/blockPresets.ts';

/**
 * 初回起動時に表示する 1LDK のサンプル間取り（8000 × 6000 mm、48 m²）。
 *
 * **図面として筋が通っていることを優先する。** 以前のサンプルには
 * 住宅としてありえない点が 3 つあった——浴槽・トイレ・洗面台が仕切りの無い
 * 1 室に同居し、玄関が無くて外から直接 LDK に入り、収納が 1 つも無かった。
 * 見本は最初に目に入るものなので、間取りとして読めないと道具の評価に進めない。
 *
 * **外周と既存の建具は 1mm も動かしていない。** 直したのは中の仕切りと
 * 家具の居場所だけ。外周を動かすと、座標で図面を叩く通し確認（`clickWorld`）と
 * 単体試験が総崩れになる——見本を直すために試験を書き直すのは順序が逆。
 *
 * 間取り：
 * ```
 *   y=6000 ┌──────┬────────────┬──────┬──────┐
 *          │ 玄関 │  キッチン   │  CL  │      │
 *   y=5100 ├──────┘            ├──────┘      │
 *          │                   │             │
 *          │      L D K        │    洋室     │
 *   y=3200 │              ┌────┴──────┬──────┤
 *          │              │           │ 浴室 │
 *   y=1100 │              │ 洗面脱衣室 ├──────┤
 *          │              │           │ トイレ│
 *      y=0 └──────────────┴───────────┴──────┘
 *          x=0         x=4600      x=6400  x=8000
 * ```
 */
export function sampleScene(): Scene {
  const scene = emptyScene();
  const T = 120;

  const n = (x: number, y: number) => findOrCreateNode(scene, vec(x, y));

  // 外周 8000 x 6000
  const sw = n(0, 0);
  const se = n(8000, 0);
  const ne = n(8000, 6000);
  const nw = n(0, 6000);

  // 間仕切りの取り付き点
  const southMid = n(4600, 0);
  const northMid = n(4600, 6000);
  const eastMid = n(8000, 3200);
  const centerMid = n(4600, 3200);

  /*
   * **外周に取り付き点を足す。** 外周の形は変えないが、中の仕切りを
   * ぶつける場所には節点が要る。節点を置くだけでは壁は割れないので
   * （割るのは作図ツールの `splitWall`）、**最初から分けて建てる**。
   * 割らないまま節点だけ置くと、部屋の検出が半辺をたどれなくなる
   */
  const sWater = n(6400, 0); // 水まわりの縦の仕切りが南の外壁に取り付く
  const eWater = n(8000, 1100); // 浴室とトイレの境が東の外壁に取り付く
  const nCloset = n(6400, 6000); // クローゼットの仕切りが北の外壁に取り付く
  const nGenkan = n(1700, 6000); // 玄関の仕切りが北の外壁に取り付く
  const wGenkan = n(0, 3900); // 玄関の仕切りが西の外壁に取り付く

  const outer: [string, string][] = [
    [sw, southMid],
    [southMid, sWater],
    [sWater, se],
    [se, eWater],
    [eWater, eastMid],
    [eastMid, ne],
    [ne, nCloset],
    [nCloset, northMid],
    [northMid, nGenkan],
    [nGenkan, nw],
    [nw, wGenkan],
    [wGenkan, sw],
  ];
  /** 外周の壁。寸法を入れるのはここだけ */
  const outerEnds = new Set<string>();
  for (const [a, b] of outer) {
    addWall(scene, a, b, T + 60);
    outerEnds.add(`${a}|${b}`);
  }

  // 間仕切りの取り付き点（内側）
  const closetWest = n(4600, 5250);
  const waterTop = n(6400, 3200);
  const waterMid = n(6400, 1100);
  const genkanCorner = n(1700, 3900);

  // 間仕切り壁は薄く
  addWall(scene, southMid, centerMid, T);
  addWall(scene, centerMid, closetWest, T);
  addWall(scene, closetWest, northMid, T);
  addWall(scene, centerMid, waterTop, T);
  addWall(scene, waterTop, eastMid, T);

  // 玄関（1700 × 2100）。**外から直接 LDK に入らせない**
  addWall(scene, wGenkan, genkanCorner, T);
  addWall(scene, genkanCorner, nGenkan, T);

  // 水まわりを 3 室に分ける。洗面脱衣室 / 浴室 / トイレ
  addWall(scene, sWater, waterMid, T);
  addWall(scene, waterMid, waterTop, T);
  addWall(scene, waterMid, eWater, T);

  // 洋室のクローゼット（1800 × 750）
  addWall(scene, closetWest, n(6400, 5250), T);
  addWall(scene, n(6400, 5250), nCloset, T);

  const wallBetween = (a: string, b: string) =>
    Object.values(scene.walls).find((w) => (w.a === a && w.b === b) || (w.a === b && w.b === a));

  const addOpening = (a: string, b: string, offset: number, width: number, kind: OpeningKind, flipY = false) => {
    const wall = wallBetween(a, b);
    if (!wall) return;
    const id = newId('o');
    const opening: Opening = {
      id,
      wallId: wall.id,
      offset,
      width,
      kind,
      flipX: false,
      flipY,
      sillHeight: null,
      bay: null,
      designation: '',
      // **種別ごとの既定。** 片開き戸に 2 を書くと 2 枚の戸が並んで描かれる
      leaves: OPENING_SYMBOLS[kind].defaultLeaves,
      height: null,
      layerId: LAYER_IDS.opening,
      attrs: defaultAttrs(),
    };
    scene.openings[id] = opening;
  };

  /*
   * **建具の世界座標は 1 つも動かしていない。** 外周を割ったので取り付く壁は
   * 変わるが、割った分だけ基点からの距離を引き直して同じ場所に出している
   */
  // 玄関ドア（西の外壁、y=4800）と LDK の掃き出し窓
  addOpening(nw, wGenkan, 1200, 900, 'door');
  addOpening(sw, southMid, 2000, 2600, 'window');
  addOpening(northMid, nGenkan, 1600, 1800, 'window');
  // 洋室
  addOpening(centerMid, closetWest, 1400, 800, 'door', true);
  addOpening(eastMid, ne, 1400, 1700, 'window');
  // 水まわりへの入口（LDK から洗面脱衣室へ）
  addOpening(southMid, centerMid, 1600, 750, 'door');
  // 東の外壁の窓（y=1600）。外壁を y=1100 で割ったので基点が変わる
  addOpening(eWater, eastMid, 500, 600, 'window');

  // --- ここから今回足した建具 ---
  // 玄関から LDK へ
  addOpening(genkanCorner, nGenkan, 1100, 800, 'door');
  // 洗面脱衣室から浴室・トイレへ。**浴室は折れ戸**（開き戸だと中で開けない）
  addOpening(waterMid, waterTop, 1100, 700, 'folding');
  addOpening(sWater, waterMid, 550, 700, 'door');
  // クローゼットは折れ戸
  addOpening(closetWest, n(6400, 5250), 900, 1400, 'folding');

  const place = (label: string, x: number, y: number, angle: number) => {
    const preset = BLOCK_PRESETS.find((p) => p.label === label)!;
    const id = newId('i');
    scene.instances[id] = {
      id,
      blockId: preset.id,
      layerId: LAYER_IDS.furniture,
      x,
      y,
      scaleX: 1,
      scaleY: 1,
      angle,
      label: null,
      levelId: scene.activeLevelId,
      attrs: defaultAttrs(),
    };
  };

  /*
   * **家具はそれぞれの部屋に入れる。** 以前は浴槽・トイレ・洗面台が
   * 仕切りの無い 1 室に並んでいた。ソファだけは場所が変わっていない
   * （`tests/render.test.ts` がソファの中心を拾えることを見ている）
   */
  place('キッチン', 3100, 5560, 0); // 玄関の東、北の窓の下
  place('ダイニング', 2800, 4000, 0);
  place('ソファ', 2200, 1400, 0);
  place('ベッドS', 7200, 4500, 0); // クローゼットの東
  place('洗面台', 5500, 2800, 0);
  /*
   * **部屋名は重心に出る**（`drawRoomLabels` は `room.center` に描く。
   * `roomLabels` の x/y は「どの部屋の名前か」を決めるだけで、描く場所では
   * ない）。だから小さい部屋では、**器具のほうを重心から寄せる**しかない。
   *
   * トイレは便器を東の隅へ寄せて、重心（x=7185）に名前の居場所を作った。
   * **浴室は寄せても空かない**——内法 1450 に浴槽が 800 あり、重心を外すには
   * 400 以上ずらす必要があって、ずらすと反対側が壁を突き抜ける。
   * 間取り図で浴室名が浴槽に重なるのは普通なので、ここはそのままにする
   */
  place('浴槽', 7200, 2350, Math.PI / 2); // 浴室は 1600 幅なので縦に置く
  place('トイレ', 7650, 540, 0);

  const label = (x: number, y: number, name: string) => {
    const id = newId('l');
    scene.roomLabels[id] = {
      id, x, y, name, floorMaterial: null, ceilingMaterial: null,
      layerId: LAYER_IDS.roomName, levelId: scene.activeLevelId,
    };
  };
  label(2300, 2400, 'LDK');
  label(850, 4950, '玄関');
  label(7100, 4000, '洋室');
  label(5500, 5550, 'CL'); // 1800 × 900 に「クローゼット」は入らない
  label(5500, 1800, '洗面脱衣室');
  // **この x/y は「どの部屋か」を決めるだけ。** 名前が出るのは部屋の重心
  label(7185, 1360, '浴室');
  label(6750, 560, 'トイレ');

  /*
   * 寸法は実体のエンティティ。壁の角に紐づくので、角を動かすと値が追従する。
   *
   * **入れるのは外周だけ。** 仕切りが 12 本に増えたので、壁ぶん全部に
   * 入れると図面が寸法線で埋まって間取りが読めない。実際の図面も、
   * 見本として出すときは外形の寸法から見せる
   */
  for (const dim of createWallDimensions(scene)) {
    if (!outerEnds.has(`${dim.a.nodeId}|${dim.b.nodeId}`)) continue;
    scene.shapes[dim.id] = dim;
  }

  return scene;
}
