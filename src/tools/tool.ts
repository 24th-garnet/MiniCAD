import type { Vec } from '../core/geometry.ts';
import type { SnapResult } from '../core/snap.ts';
import type { Frame } from '../render/renderer.ts';
import type { Editor } from '../ui/editor.ts';

export type ToolId = 'select' | 'wall' | 'door' | 'window' | 'furniture' | 'room' | 'measure';

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
  status(editor: Editor): string;
}
