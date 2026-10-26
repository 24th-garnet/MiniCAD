/**
 * どのビューを出しているか。
 *
 * **`Viewer3D.visible` から持ち上げた。** これまでは 3D 側が「自分が見えているか」を
 * 持っていて、それが唯一の権威だった。分割では 2D と 3D が同時に見えるので、
 * 「3D が見えているか」だけでは足りない。
 *
 * ここに置くものは**どのビューか**だけ。カメラも稜線も平行投影も `Viewer3D` の
 * 持ち物のままにしてある。
 */
export type ViewMode = '2d' | '3d' | 'split';

export const VIEW_MODES: ViewMode[] = ['2d', '3d', 'split'];

export const VIEW_LABELS: Record<ViewMode, string> = {
  '2d': '2D',
  '3d': '3D',
  split: '分割',
};

export class ViewState {
  private current: ViewMode = '2d';
  private readonly onChange: (mode: ViewMode) => void;

  // コンストラクタ引数のプロパティ宣言（`constructor(private x)`）は書かない。
  // `npm test` の `node --experimental-strip-types` は型を消すだけで、
  // 構文糖は展開できない。`ui/` のほとんどは DOM を要るのでテストから
  // 読まれないが、ここは素のデータなので読まれる
  constructor(onChange: (mode: ViewMode) => void) {
    this.onChange = onChange;
  }

  get mode(): ViewMode {
    return this.current;
  }

  set(mode: ViewMode): void {
    if (this.current === mode) return;
    this.current = mode;
    this.onChange(mode);
  }

  /**
   * `F3` の行き先。**3D がすでに見えていれば 2D に戻す。**
   *
   * 分割から 3D へ進めると、分割を出した人が 2D を失う。
   * 「3D を見ているか」で折り返すほうが、押した側の心の中の模型に合う
   */
  toggle3d(): void {
    this.set(this.shows3d ? '2d' : '3d');
  }

  get shows2d(): boolean {
    return this.current !== '3d';
  }

  get shows3d(): boolean {
    return this.current !== '2d';
  }

  get isSplit(): boolean {
    return this.current === 'split';
  }
}
