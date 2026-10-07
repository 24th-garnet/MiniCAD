import type { Panel, PanelContext } from './panel.ts';

/**
 * 作図中に長さ・角度を打ち込む入力欄。
 * 出すかどうかはアクティブなツールの `numericEntry()` が決める。
 */
export class CommandInput implements Panel {
  constructor(
    private readonly form: HTMLFormElement,
    private readonly input: HTMLInputElement,
    private readonly label: HTMLElement,
  ) {}

  build(ctx: PanelContext): void {
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const entry = ctx.editor.tool.numericEntry?.(ctx.editor);
      if (!entry) return;
      entry.submit(ctx.editor, this.input.value);
      this.input.value = '';
      ctx.editor.canvas.focus();
      ctx.refresh();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.input.value = '';
        ctx.editor.canvas.focus();
      }
      e.stopPropagation();
    });
  }

  get visible(): boolean {
    return !this.form.hidden;
  }

  /** キーボードから打たれた1文字を入力欄へ送り込む */
  beginWith(char: string): void {
    this.input.value = char;
    this.input.focus();
  }

  refresh(ctx: PanelContext): void {
    const entry = ctx.editor.tool.numericEntry?.(ctx.editor);
    if (!entry) {
      this.form.hidden = true;
      this.input.value = '';
      return;
    }
    this.form.hidden = false;
    this.input.placeholder = entry.placeholder;
    this.label.textContent = entry.hint;
  }
}
