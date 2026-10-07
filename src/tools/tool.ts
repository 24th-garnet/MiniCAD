import type { Vec } from '../core/geometry.ts';
import type { SnapResult } from '../core/snap.ts';
import type { Frame } from '../render/renderer.ts';
import type { Editor } from '../ui/editor.ts';

export type ToolId =
  | 'select'
  | 'measure'
  | 'wall'
  | 'door'
  | 'window'
  | 'furniture'
  | 'line'
  | 'arc'
  | 'point'
  | 'text'
  | 'room';

export interface PointerInfo {
  screen: Vec;
  /** スナップ適用後のワールド座標 */
  world: Vec;
  /** スナップ適用前のワールド座標 */
  raw: Vec;
  snap: SnapResult;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  button: number;
}

/**
 * オプションバーに出す項目の記述子。
 *
 * ツールが DOM を組み立てると「core / tools は DOM に触らない」という設計が崩れ、
 * かといって UI 側で `switch (activeToolId)` を書くとツールが増えるたびに膨らむ。
 * 記述子を返させることで、ツールは自己記述的になり、UI はツールを知らなくて済む。
 */
export type OptionField =
  | { kind: 'number'; label: string; value: number; step?: number; min?: number;
      max?: number; suffix?: string; onChange(v: number): void }
  | { kind: 'select'; label: string; value: string;
      options: { value: string; label: string }[]; onChange(v: string): void }
  | { kind: 'text'; label: string; value: string; placeholder?: string; onChange(v: string): void }
  | { kind: 'toggle'; label: string; value: boolean; onChange(v: boolean): void }
  /** その場で押せる候補。押すと onPick が呼ばれ、オプションバーが描き直される */
  | { kind: 'chips'; items: string[]; onPick(s: string): void }
  | { kind: 'note'; text: string };

/** ツールバーの並びを区切るためのグループ */
export type ToolGroup = 'draw' | 'modify' | 'annotate';

/** 作図中に長さ・角度を打ち込むための入力欄の仕様 */
export interface NumericEntry {
  placeholder: string;
  hint: string;
  submit(editor: Editor, text: string): void;
}

export interface Tool {
  readonly id: ToolId;
  readonly label: string;
  readonly shortcut: string;
  readonly cursor: string;
  /** ツールバーの区切り。省略すると 'draw' 扱い */
  readonly group?: ToolGroup;

  onActivate?(editor: Editor): void;
  onDeactivate?(editor: Editor): void;
  onPointerDown?(editor: Editor, p: PointerInfo): void;
  onPointerMove?(editor: Editor, p: PointerInfo): void;
  onPointerUp?(editor: Editor, p: PointerInfo): void;
  onDoubleClick?(editor: Editor, p: PointerInfo): void;
  /** true を返すとエディタ側の既定処理を抑止する */
  onKeyDown?(editor: Editor, e: KeyboardEvent): boolean;
  drawOverlay?(editor: Editor, frame: Frame): void;
  /** 進行中の作図があるか。Esc の扱いに使う */
  isActive?(editor: Editor): boolean;
  cancel?(editor: Editor): void;
  numericEntry?(editor: Editor): NumericEntry | null;
  /** オプションバーに出す項目。DOM は返さない */
  options?(editor: Editor): OptionField[];
  status(editor: Editor): string;
}
