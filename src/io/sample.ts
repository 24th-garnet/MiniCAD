import { createWallDimensions } from '../core/dimension.ts';
import { vec } from '../core/geometry.ts';
import { LAYER_IDS } from '../core/layer.ts';
import { addWall, findOrCreateNode } from '../core/ops.ts';
import { emptyScene, newId, type Opening, type OpeningKind, type Scene } from '../core/types.ts';
import { FURNITURE_PRESETS } from '../core/shape.ts';

/** 初回起動時に表示する 1LDK のサンプル間取り */
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

  const outer: [string, string][] = [
    [sw, southMid],
    [southMid, se],
    [se, eastMid],
    [eastMid, ne],
    [ne, northMid],
    [northMid, nw],
    [nw, sw],
  ];
  for (const [a, b] of outer) addWall(scene, a, b, T + 60);

  // 間仕切り壁は薄く
  addWall(scene, southMid, centerMid, T);
  addWall(scene, centerMid, northMid, T);
  addWall(scene, centerMid, eastMid, T);

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
      layerId: LAYER_IDS.opening,
    };
    scene.openings[id] = opening;
  };

  // 玄関ドアと LDK の掃き出し窓
  addOpening(nw, sw, 1200, 900, 'door');
  addOpening(sw, southMid, 2000, 2600, 'window');
  addOpening(northMid, nw, 1600, 1800, 'window');
  // 洋室
  addOpening(centerMid, northMid, 1400, 800, 'door', true);
  addOpening(eastMid, ne, 1400, 1700, 'window');
  // 水まわり
  addOpening(southMid, centerMid, 1600, 750, 'door');
  addOpening(se, eastMid, 1600, 600, 'window');

  const preset = (name: string) => FURNITURE_PRESETS.find((p) => p.name === name)!;
  const place = (name: string, x: number, y: number, angle: number) => {
    const p = preset(name);
    const id = newId('f');
    scene.furniture[id] = { id, kind: p.kind, name: p.name, x, y, w: p.w, h: p.h, angle, layerId: LAYER_IDS.furniture };
  };

  place('キッチン', 1600, 5585, 0);
  place('ダイニング', 1800, 4000, 0);
  place('ソファ', 2200, 1400, 0);
  place('ベッドS', 5360, 4935, 0);
  place('浴槽', 5500, 600, 0);
  place('トイレ', 7500, 600, Math.PI / 2);
  place('洗面台', 6600, 2700, 0);

  const label = (x: number, y: number, name: string) => {
    const id = newId('l');
    scene.roomLabels[id] = { id, x, y, name, layerId: LAYER_IDS.roomName };
  };
  label(2300, 3000, 'LDK');
  label(6300, 4600, '洋室');
  label(6300, 1600, '水まわり');

  // 寸法は実体のエンティティ。壁の角に紐づくので、角を動かすと値が追従する
  for (const dim of createWallDimensions(scene)) scene.shapes[dim.id] = dim;

  return scene;
}
