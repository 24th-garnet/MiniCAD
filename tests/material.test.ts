import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attrsOf, materialRefOf } from '../src/core/material.ts';
import { sampleScene } from '../src/io/sample.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { ENTITY_KINDS, ENTITY_TYPES } from '../src/core/entity.ts';
import type { EntityRef } from '../src/core/types.ts';

/**
 * シーンから、その種別の実体を 1 つ拾う。
 *
 * **表は `ENTITY_KINDS` から引く。** ここに手で書いた表を置くと、
 * 種別を足したときに黙って飛ばされる（実際に一度やった）。
 */
function someRef(type: EntityRef['type']) {
  const scene = sampleScene();
  const id = Object.keys(ENTITY_KINDS[type].table(scene))[0];
  return { scene, ref: id ? ({ type, id } as EntityRef) : null };
}

test('属性を持つ種別と持たない種別がはっきり分かれている', () => {
  // ノードと室名は属性を持たない。表に 2 行「持たない」を書く代わりに、
  // switch が網羅していることを型と、この 1 件で見る
  const holds = new Set(['wall', 'opening', 'blockInstance', 'shape', 'fixture', 'measurement']);
  for (const type of ENTITY_TYPES) {
    const { scene, ref } = someRef(type);
    if (!ref) continue;
    const got = attrsOf(scene, ref);
    assert.equal(got !== null, holds.has(type), `${type} の扱いが違う`);
  }
});

test('素材は不透明な識別子として往復する', () => {
  // **MiniCAD は中身を解釈しない。** ホストの識別子をそのまま運ぶ
  const scene = sampleScene();
  const wallId = Object.keys(scene.walls)[0];
  const opaque = 'host://materials/クロス_松_001?v=3';
  scene.walls[wallId].attrs.materialRef = opaque;

  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.equal(back.walls[wallId].attrs.materialRef, opaque);
  assert.equal(materialRefOf(back, { type: 'wall', id: wallId }), opaque);
});

test('素材を指定していなければ null のまま', () => {
  const scene = sampleScene();
  const wallId = Object.keys(scene.walls)[0];
  assert.equal(materialRefOf(scene, { type: 'wall', id: wallId }), null);
});

test('消えた実体を引いても落ちない', () => {
  const scene = sampleScene();
  assert.equal(attrsOf(scene, { type: 'wall', id: 'いない' }), null);
  assert.equal(materialRefOf(scene, { type: 'fixture', id: 'いない' }), null);
});
