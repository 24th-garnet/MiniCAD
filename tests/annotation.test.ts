import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceOf,
  measuredDistance,
  planLength,
  point3,
  readPoint3,
  type Measurement,
} from '../src/core/annotation.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { emptyScene } from '../src/core/types.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { ENTITY_KINDS } from '../src/core/entity.ts';

const make = (over: Partial<Measurement> = {}): Measurement => ({
  id: 'ms1',
  a: point3(0, 0, 0),
  b: point3(3000, 4000, 0),
  manual: null,
  note: '',
  layerId: LAYER_IDS.draft,
  levelId: DEFAULT_LEVEL_ID,
  attrs: defaultAttrs(),
  ...over,
});

test('距離は z も見る', () => {
  const flat = make();
  assert.equal(measuredDistance(flat), 5000);
  assert.equal(planLength(flat), 5000);

  const raised = make({ b: point3(3000, 4000, 1200) });
  assert.ok(Math.abs(measuredDistance(raised) - Math.hypot(5000, 1200)) < 1e-9);
  // 平面の長さは z を無視する。ラベルを置く位置に使う
  assert.equal(planLength(raised), 5000);
});

test('手入力は自動計測より優先され、両方とも残る', () => {
  // **畳まない。** 畳むと「測ったら 5000 だった」と「5000 だと聞いた」が
  // 同じ数字になり、どちらか分からなくなる
  const m = make({ manual: 4800 });
  assert.equal(distanceOf(m), 4800);
  assert.equal(measuredDistance(m), 5000, '自動の値が消えている');
});

test('手入力を外すと自動計測に戻る', () => {
  const m = make({ manual: 4800 });
  m.manual = null;
  assert.equal(distanceOf(m), 5000);
});

test('計測が JSON の往復を生き延びる', () => {
  const scene = emptyScene();
  scene.measurements.ms1 = make({ manual: 4800, note: '天井まで', b: point3(1, 2, 3) });
  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.deepEqual(back.measurements.ms1, scene.measurements.ms1);
});

test('手入力の 0 が未入力に化けない', () => {
  const scene = emptyScene();
  scene.measurements.ms1 = make({ manual: 0 });
  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.equal(back.measurements.ms1.manual, 0);
});

test('壊れた計測は捨てる', () => {
  const raw = {
    format: 'minicad', version: 10, unit: 'mm',
    scene: {
      measurements: {
        ok: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
        noB: { a: { x: 0, y: 0 } },
        badA: { a: { x: 'ゼロ', y: 0 }, b: { x: 100, y: 0 } },
      },
    },
  };
  const scene = deserialize(raw);
  assert.deepEqual(Object.keys(scene.measurements), ['ok']);
  assert.equal(scene.measurements.ok.a.z, 0, 'z が既定に落ちていない');
});

test('z の無い点は床の高さに落ちる', () => {
  assert.deepEqual(readPoint3({ x: 1, y: 2 }), { x: 1, y: 2, z: 0 });
  assert.equal(readPoint3({ x: 1 }), null);
  assert.equal(readPoint3(null), null);
  assert.equal(readPoint3({ x: Infinity, y: 0 }), null);
});

test('計測は図面範囲に入らない', () => {
  // **打ち合わせの道具。** これで全体表示の倍率が変わると邪魔になる
  const scene = emptyScene();
  scene.measurements.ms1 = make({ b: point3(999999, 999999, 0) });
  assert.deepEqual(ENTITY_KINDS.measurement.points(scene, 'ms1'), []);
});

test('計測を消せる', () => {
  const scene = emptyScene();
  scene.measurements.ms1 = make();
  assert.equal(ENTITY_KINDS.measurement.remove(scene, 'ms1'), true);
  assert.deepEqual(Object.keys(scene.measurements), []);
  assert.equal(ENTITY_KINDS.measurement.remove(scene, 'ms1'), false);
});
