import { CONSTRAINT_KINDS, CONSTRAINT_SPECS, constraintLabel, type ConstraintKind } from '../../../core/constraints.ts';
import { addConstraint, constraintsOnWall, hasConstraint } from '../../../core/constraintOps.ts';
import { solveScene } from '../../../core/constraintSolver.ts';
import type { Id } from '../../../core/types.ts';
import { el, numberField } from '../../dom.ts';
import type { PanelContext, Section } from '../../panel.ts';

/**
 * 壁に付いた幾何拘束。
 *
 * 選択されるのは壁のままで、拘束は「壁に付いた属性」として扱う。
 * ボタンは `CONSTRAINT_SPECS` を回して出すので、種別を足せば自動で増える。
 */
export class ConstraintsSection implements Section {
  private error: string | null = null;

  render(ctx: PanelContext): (HTMLElement | null)[] {
    const scene = ctx.editor.store.scene;
    const walls = ctx.editor.store.selection.filter((r) => r.type === 'wall').map((r) => r.id);
    const existing = [...new Set(walls.flatMap((id) => constraintsOnWall(scene, id)))];

    if (walls.length === 0 && existing.length === 0) {
      if (Object.keys(scene.constraints).length === 0) return [];
      return [el('h2', {}, ['拘束']), el('p', { class: 'empty-note' }, ['壁を選ぶと拘束を付けられます。'])];
    }

    const out: (HTMLElement | null)[] = [el('h2', {}, ['拘束'])];

    const buttons = CONSTRAINT_KINDS.filter((kind) => CONSTRAINT_SPECS[kind].applicable(scene, walls)).map((kind) =>
      el(
        'button',
        {
          type: 'button',
          disabled: hasConstraint(scene, kind, walls),
          onclick: () => this.add(ctx, kind, walls),
        },
        [CONSTRAINT_SPECS[kind].label],
      ),
    );
    if (buttons.length > 0) out.push(el('div', { class: 'constraint-buttons' }, buttons));
    else if (walls.length > 0) {
      out.push(el('p', { class: 'empty-note' }, ['壁を1本（長さ・水平・垂直）か2本（平行・直角）選んでください。']));
    }

    if (this.error) out.push(el('p', { class: 'warn-note' }, [this.error]));

    for (const c of existing) {
      const spec = CONSTRAINT_SPECS[c.kind];
      const remove = el('button', { type: 'button', class: 'danger', title: '拘束を外す', onclick: () => {
        ctx.edit(() => void delete ctx.editor.store.scene.constraints[c.id]);
      } }, ['×']);

      if (spec.usesValue && c.value !== null) {
        const field = numberField(spec.label, c.value, (v) => this.setValue(ctx, c.id, v), { step: 50, suffix: 'mm' });
        field.append(remove);
        out.push(field);
      } else {
        out.push(el('div', { class: 'field' }, [el('span', {}, [constraintLabel(c)]), remove]));
      }
    }
    return out;
  }

  /**
   * 追加してみて、矛盾したら丸ごと取り消す。
   *
   * `commit` は fn が false を返すとシーンごと巻き戻すので、
   * 追加した拘束も動いた座標も完全に元へ戻る。スナップショットの代金は
   * `commit` が既に払っているので、ここで複製は要らない。
   */
  private add(ctx: PanelContext, kind: ConstraintKind, walls: Id[]): void {
    this.error = null;
    ctx.edit(() => {
      const scene = ctx.editor.store.scene;
      if (!addConstraint(scene, kind, walls)) return false;
      if (!solveScene(scene).ok) {
        this.error = 'この拘束は既存の拘束と矛盾します。';
        return false;
      }
      return true;
    });
    ctx.refresh();
  }

  private setValue(ctx: PanelContext, id: Id, value: number): void {
    this.error = null;
    ctx.edit(() => {
      const scene = ctx.editor.store.scene;
      const c = scene.constraints[id];
      if (!c) return false;
      const before = c.value;
      c.value = Math.max(1, value);
      if (!solveScene(scene).ok) {
        this.error = 'その長さにはできません。';
        c.value = before;
        return false;
      }
      return true;
    });
    ctx.refresh();
  }
}
