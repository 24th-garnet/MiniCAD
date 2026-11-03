import { arrayCopy, type ArrayCopy } from '../core/arrayCopy.ts';
import { toRad, type Vec } from '../core/geometry.ts';
import { drawSnapMarker, type Frame } from '../render/renderer.ts';
import type { Editor } from '../ui/editor.ts';
import { copyLayerField } from './tool.ts';
import type { OptionField, PointerInfo, Tool } from './tool.ts';
import type { LayerId } from '../core/layer.ts';

/**
 * 配列複写（ワイヤー 5 枚目の「配列複写」）。
 *
 * **3D のソリッドとは無関係。** 2D でも 3D でも同じものが動く。
 * 中身は `transformEntities(..., { copy: true })` の繰り返しで、
 * このツールは「何個をどこへ」を数値で受け取るだけ。
 *
 * **格子はその場で置ける**（基準が要らない）が、**円周は中心が要る**ので
 * 1 回クリックしてもらう。
 */
export class ArrayCopyTool implements Tool {
  readonly id = 'array' as const;
  readonly label = '配列';
  /**
   * **キーを持たない。** A〜Z が全部埋まっていて、しかも配列複写は
   * 「選んで数値を入れて押す」操作なので、指の記憶で呼ぶものではない。
   * ベクターワークスでもメニュー側にある。
   */
  readonly shortcut = '';
  readonly cursor = 'crosshair';
  readonly group = 'modify' as const;

  kind: ArrayCopy['kind'] = 'grid';
  rows = 2;
  cols = 3;
  rowStep = 1000;
  colStep = 1000;
  angleDeg = 0;
  count = 6;
  sweepDeg = 360;
  /** 複製先の画層。null なら元のまま（ワイヤー 5 枚目の「複製先のレイヤーを選択」） */
  copyLayerId: LayerId | null = null;

  onActivate(editor: Editor): void {
    editor.snapContext = {};
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    // 円周のときだけ、押したところを中心にする
    if (this.kind === 'radial') this.run(editor, p.world);
  }

  /** 格子はオプションバーのボタンから。中心が要らないので、その場で置ける */
  private run(editor: Editor, center: Vec): void {
    const refs = [...editor.store.selection];
    if (refs.length === 0) {
      window.alert('並べるものを先に選んでください。');
      return;
    }
    const spec: ArrayCopy = this.kind === 'grid'
      ? {
          kind: 'grid',
          rows: this.rows,
          cols: this.cols,
          rowStep: this.rowStep,
          colStep: this.colStep,
          angle: toRad(this.angleDeg),
        }
      : { kind: 'radial', center, count: this.count, sweep: toRad(this.sweepDeg) };
    // **1 コミットにまとめる。** undo 1 回で全部戻る
    editor.store.commit(() => arrayCopy(editor.store.scene, refs, spec, this.copyLayerId) > 0);
    editor.requestRender();
  }

  options(editor: Editor): OptionField[] {
    const mm = { step: 100, min: -100000, suffix: 'mm' } as const;
    const head: OptionField = {
      kind: 'select',
      label: '並べ方',
      value: this.kind,
      options: [
        { value: 'grid', label: '格子状' },
        { value: 'radial', label: '円周上' },
      ],
      onChange: (v) => void (this.kind = v === 'radial' ? 'radial' : 'grid'),
    };
    const layer = copyLayerField(editor, this.copyLayerId, (v) => void (this.copyLayerId = v));
    if (this.kind === 'radial') {
      return [
        head,
        layer,
        { kind: 'number', label: '個数', value: this.count, step: 1, min: 2, max: 360,
          onChange: (v) => void (this.count = Math.max(2, Math.min(360, Math.round(v)))) },
        { kind: 'number', label: '全体の角', value: this.sweepDeg, step: 15, suffix: '°',
          onChange: (v) => void (this.sweepDeg = v) },
        { kind: 'note', text: '中心をクリックすると並びます（選択したものが元）' },
      ];
    }
    return [
      head,
      layer,
      { kind: 'number', label: '行', value: this.rows, step: 1, min: 1, max: 200,
        onChange: (v) => void (this.rows = Math.max(1, Math.min(200, Math.round(v)))) },
      { kind: 'number', label: '列', value: this.cols, step: 1, min: 1, max: 200,
        onChange: (v) => void (this.cols = Math.max(1, Math.min(200, Math.round(v)))) },
      { kind: 'number', label: '行の間隔', value: this.rowStep, ...mm,
        onChange: (v) => void (this.rowStep = v) },
      { kind: 'number', label: '列の間隔', value: this.colStep, ...mm,
        onChange: (v) => void (this.colStep = v) },
      { kind: 'number', label: '向き', value: this.angleDeg, step: 15, suffix: '°',
        onChange: (v) => void (this.angleDeg = v) },
      { kind: 'chips', items: ['この設定で並べる'], onPick: () => this.run(editor, { x: 0, y: 0 }) },
    ];
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    // 中心を拾うときだけスナップを見せる。格子は基準が要らない
    const snap = editor.lastSnap;
    if (this.kind === 'radial' && snap && snap.kind !== 'free') {
      drawSnapMarker(frame, snap.point, snap.label);
    }
  }

  status(editor: Editor): string {
    const n = editor.store.selection.length;
    if (n === 0) return '並べるものを選んでから、個数と間隔を入れてください';
    if (this.kind === 'radial') {
      return `${n} 個を中心のまわりに ${this.count} 個。中心をクリック`;
    }
    return `${n} 個を ${this.rows} 行 × ${this.cols} 列に。「この設定で並べる」を押す`;
  }
}
