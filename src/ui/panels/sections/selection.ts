import { toDeg, toRad } from '../../../core/geometry.ts';
import { wallLength } from '../../../core/ops.ts';
import { isOpeningKind, OPENING_KINDS, type EntityRef } from '../../../core/types.ts';
import { OPENING_PROFILES, OPENING_SYMBOLS } from '../../../core/opening.ts';
import { checkboxField, el, numberField, optionalNumberField, readonlyField, selectField, textField } from '../../dom.ts';
import { shapeFields } from '../../shapeFields.ts';
import { layerOfRef, setLayerOf } from '../../../core/entity.ts';
import { attrsOf } from '../../../core/material.ts';
import { measuredDistance } from '../../../core/annotation.ts';
import { isTakeoffMode, type Attrs } from '../../../core/attrs.ts';
import { BAY_LABELS, BAY_SHAPES, defaultBay, type BayShape } from '../../../core/bay.ts';
import { FIXTURE_SPECS, type Fixture } from '../../../core/fixture.ts';
import { levelOf } from '../../../core/level.ts';
import { blockOf, defineBlock, explodeInstance, instanceSize, renameBlock } from '../../../core/block.ts';
import { resolveSelection, selectionCenter } from '../../../core/selection.ts';
import type { Section, PanelContext } from '../../panel.ts';

/** 選択中のエンティティのプロパティ */
export class SelectionSection implements Section {
  render(ctx: PanelContext): (HTMLElement | null)[] {
    const sel = ctx.editor.store.selection;
    const out: (HTMLElement | null)[] = [el('h2', {}, ['プロパティ'])];

    if (sel.length === 0) {
      out.push(el('p', { class: 'empty-note' }, ['何も選択されていません。']));
      return out;
    }
    if (sel.length > 1) {
      out.push(
        readonlyField('選択数', `${sel.length} 個`),
        ...attrFields(ctx, sel),
        layerField(ctx),
        blockifyButton(ctx),
      );
      out.push(
        el('button', { class: 'wide danger', type: 'button', onclick: () => ctx.deleteSelection() }, ['削除']),
      );
      return out;
    }

    out.push(...fieldsFor(ctx, sel[0]), ...attrFields(ctx, sel), layerField(ctx), blockifyButton(ctx));
    out.push(
      el('button', { class: 'wide danger', type: 'button', onclick: () => ctx.deleteSelection() }, ['削除 (Delete)']),
    );
    return out;
  }
}

function fieldsFor(ctx: PanelContext, ref: EntityRef): (HTMLElement | null)[] {
  const scene = ctx.editor.store.scene;
  const edit = ctx.edit;

  switch (ref.type) {
    case 'wall': {
      const wall = scene.walls[ref.id];
      if (!wall) return [];
      return [
        readonlyField('種類', '壁'),
        readonlyField('長さ', `${Math.round(wallLength(scene, wall))} mm`),
        numberField('壁厚', wall.thickness, (v) => edit(() => void (wall.thickness = Math.max(10, v))), {
          step: 10,
          min: 10,
          suffix: 'mm',
        }),
        // **ツールを増やさずに垂れ壁・腰壁を出すための欄**（奥谷さんの提案）。
        // 下端 1900 / 高さ 500 なら垂れ壁、下端 0 / 高さ 900 なら腰壁
        numberField('下端', wall.base, (v) => edit(() => void (wall.base = Math.max(0, v))), {
          step: 100, min: 0, suffix: 'mm',
        }),
        wall.base > 0
          ? el('p', { class: 'empty-note' }, ['床に着かない壁は部屋を仕切りません（平面では破線）。'])
          : null,
        optionalNumberField(
          '高さ',
          wall.height,
          Math.max(0, levelOf(scene, wall.levelId).wallHeight - wall.base),
          (v) => edit(() => void (wall.height = v === null ? null : Math.max(1, v))),
          { step: 100, min: 1, suffix: 'mm' },
        ),
      ];
    }
    case 'node': {
      const node = scene.nodes[ref.id];
      if (!node) return [];
      return [
        readonlyField('種類', '壁の端点'),
        numberField('X', node.x, (v) => edit(() => void (node.x = v)), { step: 100, suffix: 'mm' }),
        numberField('Y', node.y, (v) => edit(() => void (node.y = v)), { step: 100, suffix: 'mm' }),
      ];
    }
    case 'opening': {
      const op = scene.openings[ref.id];
      if (!op) return [];
      const wall = scene.walls[op.wallId];
      const symbol = OPENING_SYMBOLS[op.kind];
      return [
        // 選択肢は記号の表から作る。手で並べると種別を足したときに静かに抜ける
        selectField(
          '種類',
          op.kind,
          OPENING_KINDS.map((k) => ({ value: k, label: OPENING_SYMBOLS[k].label })),
          (v) => edit(() => void (op.kind = isOpeningKind(v) ? v : op.kind)),
        ),
        numberField('幅', op.width, (v) => edit(() => void (op.width = Math.max(100, v))), { step: 50, suffix: 'mm' }),
        numberField('始点からの位置', op.offset, (v) => edit(() => void (op.offset = v)), { step: 50, suffix: 'mm' }),
        readonlyField('壁の長さ', wall ? `${Math.round(wallLength(scene, wall))} mm` : '-'),
        optionalNumberField(
          '窓台の高さ',
          op.sillHeight,
          OPENING_PROFILES[op.kind].sillHeight,
          (v) => edit(() => void (op.sillHeight = v === null ? null : Math.max(0, v))),
          { step: 50, min: 0, suffix: 'mm' },
        ),
        optionalNumberField(
          '建具の高さ',
          op.height,
          OPENING_PROFILES[op.kind].height,
          (v) => edit(() => void (op.height = v === null ? null : Math.max(1, v))),
          { step: 50, min: 1, suffix: 'mm' },
        ),
        // **符号は種別を増やさないための札。** 上げ下げ・FIX・すべり出しは
        // 平面では同じ記号なので、違いはここで持つ
        textField('建具符号', op.designation, (v) => edit(() => void (op.designation = v.trim()))),
        // 枚数で記号が変わる種別にだけ出す
        symbol.usesLeaves
          ? numberField('枚数', op.leaves, (v) => edit(() => void (op.leaves = Math.max(1, Math.round(v)))), {
              step: 1, min: 1, max: 6,
            })
          : null,
        // 反転が意味を持たない種別では欄自体を出さない
        symbol.usesFlipX ? checkboxField('吊元・引き勝手を反転', op.flipX, (v) => edit(() => void (op.flipX = v))) : null,
        symbol.usesFlipY ? checkboxField('開く向きを反転', op.flipY, (v) => edit(() => void (op.flipY = v))) : null,
        // 出窓とニッチ。**種別ではなく欄**なので、どの建具にも付けられる
        checkboxField('出窓・ニッチ', op.bay !== null, (v) =>
          edit(() => void (op.bay = v ? defaultBay() : null)),
        ),
        ...(op.bay
          ? [
              selectField('張り出しの形', op.bay.shape,
                BAY_SHAPES.map((k) => ({ value: k, label: BAY_LABELS[k] })),
                (v) => edit(() => void (op.bay!.shape = v as BayShape)),
              ),
              numberField('出', op.bay.depth, (v) => edit(() => void (op.bay!.depth = v)), {
                step: 50, suffix: 'mm',
              }),
              checkboxField('反対側へ出す', op.bay.side === -1, (v) =>
                edit(() => void (op.bay!.side = v ? -1 : 1)),
              ),
              el('p', { class: 'empty-note' }, ['出を負にするとニッチ（内側へ凹む）になります。']),
            ]
          : []),
      ];
    }
    case 'blockInstance': {
      const inst = scene.instances[ref.id];
      const def = inst ? blockOf(scene, inst) : null;
      if (!inst || !def) return [];
      const size = instanceSize(def, inst);
      // 寸法は mm で編集させ、尺度に直して持つ。使う側から見れば家具のときと同じ
      const setWidth = (v: number) => void (inst.scaleX = Math.sign(inst.scaleX) * (Math.max(50, v) / def.size.w));
      const setHeight = (v: number) => void (inst.scaleY = Math.sign(inst.scaleY) * (Math.max(50, v) / def.size.h));

      return [
        def.source === 'user'
          ? textField('ブロック名', def.label, (v) => edit(() => renameBlock(scene, def.id, v)))
          : readonlyField('種類', def.label),
        textField('表示名', inst.label ?? '', (v) => edit(() => void (inst.label = v.trim() || null))),
        numberField('幅', size.w, (v) => edit(() => setWidth(v)), { step: 50, suffix: 'mm' }),
        numberField('奥行', size.h, (v) => edit(() => setHeight(v)), { step: 50, suffix: 'mm' }),
        numberField('角度', toDeg(inst.angle), (v) => edit(() => void (inst.angle = toRad(v))), {
          step: 15,
          suffix: '°',
        }),
        numberField('X', inst.x, (v) => edit(() => void (inst.x = v)), { step: 50, suffix: 'mm' }),
        numberField('Y', inst.y, (v) => edit(() => void (inst.y = v)), { step: 50, suffix: 'mm' }),
        checkboxField('左右を反転', inst.scaleX < 0, (v) =>
          edit(() => void (inst.scaleX = Math.abs(inst.scaleX) * (v ? -1 : 1))),
        ),
        el(
          'button',
          {
            class: 'wide',
            type: 'button',
            title: 'ブロックを図形に戻す',
            onclick: () => {
              const created = ctx.editor.store.scene.instances[ref.id]
                ? (ctx.edit(() => void explodeInstance(scene, ref.id)), true)
                : false;
              if (created) ctx.editor.store.clearSelection();
            },
          },
          ['分解する'],
        ),
      ];
    }
    case 'roomLabel': {
      const label = scene.roomLabels[ref.id];
      if (!label) return [];
      // **床と天井の仕上げはここに紐づく。** 部屋は壁から導く派生データで
      // id を持たず、位置依存の id に落ちるので、そこに貼ると壁を 1 本
      // 足しただけで別の部屋のものになる
      const materials = ctx.catalogs.materials ?? [];
      const options = [
        { value: '', label: '（指定なし）' },
        ...materials.map((m) => ({ value: m.ref, label: m.label })),
      ];
      return [
        textField('部屋名', label.name, (v) => edit(() => void (label.name = v))),
        el('h3', { class: 'attr-head' }, ['仕上げ']),
        materials.length === 0
          ? el('p', { class: 'empty-note' }, ['素材カタログを受け取っていません。'])
          : null,
        materials.length > 0
          ? selectField('床', label.floorMaterial ?? '', options,
              (v) => edit(() => void (label.floorMaterial = v || null)))
          : null,
        materials.length > 0
          ? selectField('天井', label.ceilingMaterial ?? '', options,
              (v) => edit(() => void (label.ceilingMaterial = v || null)))
          : null,
      ];
    }
    case 'shape': {
      const shape = scene.shapes[ref.id];
      if (!shape) return [];
      return shapeFields(shape, edit);
    }
    case 'measurement': {
      const m = scene.measurements[ref.id];
      if (!m) return [];
      const auto = measuredDistance(m);
      const end = (which: 'a' | 'b', label: string) =>
        (['x', 'y', 'z'] as const).map((axis) =>
          numberField(`${label} ${axis.toUpperCase()}`, m[which][axis],
            (v) => edit(() => void (m[which][axis] = v)), { step: 50, suffix: 'mm' }),
        );
      return [
        readonlyField('種類', '計測'),
        ...end('a', '始点'),
        ...end('b', '終点'),
        readonlyField('自動計測', `${Math.round(auto)} mm`),
        // **自動と手動を畳まない。** 畳むと「測ったら 1234 だった」と
        // 「1234 だと聞いた」が同じ数字になる
        checkboxField('手で入れる', m.manual !== null, (v) =>
          edit(() => void (m.manual = v ? Math.round(auto) : null)),
        ),
        m.manual !== null
          ? numberField('距離', m.manual, (v) => edit(() => void (m.manual = v)), { step: 1, suffix: 'mm' })
          : null,
        textField('メモ', m.note, (v) => edit(() => void (m.note = v))),
      ];
    }
    case 'fixture': {
      const f = scene.fixtures[ref.id];
      if (!f) return [];
      const spec = FIXTURE_SPECS[f.kind];
      const level = levelOf(scene, f.levelId);
      const round = f.kind === 'roundColumn';
      return [
        readonlyField('種類', spec.label),
        numberField(round ? '直径' : '幅', f.size.w, (v) => edit(() => setSize(f, Math.max(10, v), null)), {
          step: 50, min: 10, suffix: 'mm',
        }),
        // 円柱は直径 1 つで決まる。奥行の欄を出すと、直せない値が見えて混乱する
        round ? null : numberField('奥行', f.size.h, (v) => edit(() => setSize(f, null, Math.max(10, v))), {
          step: 50, min: 10, suffix: 'mm',
        }),
        optionalNumberField(
          '下端',
          f.base,
          spec.defaultBase(level),
          (v) => edit(() => void (f.base = v === null ? null : Math.max(0, v))),
          { step: 50, min: 0, suffix: 'mm' },
        ),
        optionalNumberField(
          '高さ',
          f.height,
          spec.defaultHeight(level),
          (v) => edit(() => void (f.height = v === null ? null : Math.max(1, v))),
          { step: 100, min: 1, suffix: 'mm' },
        ),
        numberField('角度', toDeg(f.angle), (v) => edit(() => void (f.angle = toRad(v))), {
          step: 15, suffix: '°',
        }),
        numberField('X', f.x, (v) => edit(() => void (f.x = v)), { step: 50, suffix: 'mm' }),
        numberField('Y', f.y, (v) => edit(() => void (f.y = v)), { step: 50, suffix: 'mm' }),
        textField('文字', f.label, (v) => edit(() => void (f.label = v.trim()))),
      ];
    }
  }
}

/** 幅と奥行は別々に直せる。円柱は直径が奥行も決める */
function setSize(f: Fixture, w: number | null, h: number | null): void {
  if (w !== null) f.size.w = w;
  if (h !== null) f.size.h = h;
  if (f.kind === 'roundColumn') f.size.h = f.size.w;
}

/**
 * 選択したものの画層。複数選んでいればまとめて変える。
 * ノードは画層を持たない（接続する壁から導く）ので、そのときは出さない。
 */
/**
 * 素材・色・積算の欄。**選択したものすべてにまとめて効く。**
 *
 * 壁 4 面に別々の壁紙を貼るのも、部屋の壁をまとめて 1 つにするのも、
 * ここから。属性を持たない種別（ノード・室名）を選んでいるときは出さない。
 */
function attrFields(ctx: PanelContext, sel: EntityRef[]): (HTMLElement | null)[] {
  const scene = ctx.editor.store.scene;
  const targets = sel.map((ref) => attrsOf(scene, ref)).filter((a): a is Attrs => a !== null);
  if (targets.length === 0) return [];

  const materials = ctx.catalogs.materials ?? [];
  // 全部が同じ値なら、その値。食い違っていれば空（＝触らなければそのまま）
  const common = <T>(pick: (a: Attrs) => T): T | null => {
    const first = pick(targets[0]);
    return targets.every((a) => pick(a) === first) ? first : null;
  };
  const setAll = (fn: (a: Attrs) => void) => ctx.edit(() => {
    for (const a of targets) fn(a);
  });

  const out: (HTMLElement | null)[] = [el('h3', { class: 'attr-head' }, ['仕上げと積算'])];

  if (materials.length > 0) {
    out.push(
      selectField(
        '素材',
        common((a) => a.materialRef) ?? '',
        [{ value: '', label: '（指定なし）' }, ...materials.map((m) => ({ value: m.ref, label: m.label }))],
        (v) => setAll((a) => void (a.materialRef = v || null)),
      ),
    );
  } else {
    // **持っていないものは、持っていないと書く**
    out.push(el('p', { class: 'empty-note' }, ['素材カタログを受け取っていません。']));
  }

  out.push(
    selectField(
      '積算',
      common((a) => a.takeoff) ?? '',
      [
        // **3 つの状態を畳まない。** 未指定を「対象外」に化けさせると、
        // 書き忘れが黙って数量から消える
        { value: '', label: '（未指定）' },
        { value: 'included', label: '対象' },
        { value: 'excluded', label: '対象外' },
      ],
      (v) => setAll((a) => void (a.takeoff = isTakeoffMode(v) ? v : null)),
    ),
  );
  if (common((a) => a.takeoff) === 'excluded') {
    out.push(el('p', { class: 'empty-note' }, ['対象外にしたものは、実測 JSON の数量から外れます。']));
  }
  return out;
}

function layerField(ctx: PanelContext): HTMLElement | null {
  const scene = ctx.editor.store.scene;
  const refs = ctx.editor.store.selection.filter((r) => r.type !== 'node');
  if (refs.length === 0) return null;

  const current = new Set(refs.map((r) => layerOfRef(scene, r)?.id).filter((id) => id !== undefined));
  const value = current.size === 1 ? [...current][0]! : '';

  return selectField(
    '画層',
    value,
    [
      ...(current.size === 1 ? [] : [{ value: '', label: '(複数の画層)' }]),
      ...Object.values(scene.layers).map((l) => ({ value: l.id, label: l.name })),
    ],
    (v) => {
      if (v) ctx.edit(() => setLayerOf(scene, refs, v));
    },
  );
}


/** 既存のブロックと重ならない表示名を作る */
function uniqueBlockLabel(scene: PanelContext['editor']['store']['scene'], base: string): string {
  const taken = new Set(Object.values(scene.blocks).map((b) => b.label));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

/**
 * 選んだ図形をブロックにする。
 * 対象は汎用図形だけ。壁や建具はノードのグラフを定義に持ち込むことになるので入れない。
 */
function blockifyButton(ctx: PanelContext): HTMLElement | null {
  const scene = ctx.editor.store.scene;
  const shapeIds = ctx.editor.store.selection.filter((r) => r.type === 'shape').map((r) => r.id);
  if (shapeIds.length === 0) return null;

  return el(
    'button',
    {
      class: 'wide',
      type: 'button',
      title: '選んだ図形を名前付きの部品にする',
      onclick: () => {
        const center = selectionCenter(scene, resolveSelection(scene, ctx.editor.store.selection));
        if (!center) return;
        // モーダルで名前を聞かない。既定の名前で作って、あとから改名できるようにする
        const label = uniqueBlockLabel(scene, '部品');
        let created: string | null = null;
        ctx.edit(() => {
          created = defineBlock(scene, shapeIds, center, label);
          return created !== null;
        });
        if (created) ctx.editor.store.setSelection([{ type: 'blockInstance', id: created }]);
      },
    },
    ['ブロックにする'],
  );
}
