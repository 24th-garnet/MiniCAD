import { toDeg, toRad } from '../../../core/geometry.ts';
import { wallLength } from '../../../core/ops.ts';
import { isOpeningKind, OPENING_KINDS, type EntityRef } from '../../../core/types.ts';
import { OPENING_PROFILES, OPENING_SYMBOLS } from '../../../core/opening.ts';
import { checkboxField, el, numberField, optionalNumberField, readonlyField, selectField, textField } from '../../dom.ts';
import { shapeFields } from '../../shapeFields.ts';
import { layerOfRef, setLayerOf } from '../../../core/entity.ts';
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
      out.push(readonlyField('選択数', `${sel.length} 個`), layerField(ctx), blockifyButton(ctx));
      out.push(
        el('button', { class: 'wide danger', type: 'button', onclick: () => ctx.deleteSelection() }, ['削除']),
      );
      return out;
    }

    out.push(...fieldsFor(ctx, sel[0]), layerField(ctx), blockifyButton(ctx));
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
        optionalNumberField(
          '高さ',
          wall.height,
          scene.level.wallHeight,
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
        // 反転が意味を持たない種別では欄自体を出さない
        symbol.usesFlipX ? checkboxField('吊元・引き勝手を反転', op.flipX, (v) => edit(() => void (op.flipX = v))) : null,
        symbol.usesFlipY ? checkboxField('開く向きを反転', op.flipY, (v) => edit(() => void (op.flipY = v))) : null,
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
      return [textField('部屋名', label.name, (v) => edit(() => void (label.name = v)))];
    }
    case 'shape': {
      const shape = scene.shapes[ref.id];
      if (!shape) return [];
      return shapeFields(shape, edit);
    }
  }
}

/**
 * 選択したものの画層。複数選んでいればまとめて変える。
 * ノードは画層を持たない（接続する壁から導く）ので、そのときは出さない。
 */
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
