import { emptyScene, sameRef, type EntityRef, type Id, type Scene } from './types.ts';

export interface Settings {
  /** グリッド間隔 (mm) */
  gridSize: number;
  snapGrid: boolean;
  snapNode: boolean;
  snapWall: boolean;
  /** 直交モード（15度刻みの角度スナップ） */
  ortho: boolean;
  /** 新規に引く壁の厚さ (mm) */
  wallThickness: number;
  showDimensions: boolean;
  showGrid: boolean;
  /** 面積を内法で表示する（false なら壁芯） */
  innerArea: boolean;
  /** DXF 書き出しで日本語を \U+XXXX に変換する */
  dxfEscapeUnicode: boolean;
}

export function defaultSettings(): Settings {
  return {
    gridSize: 100,
    snapGrid: true,
    snapNode: true,
    snapWall: true,
    ortho: true,
    wallThickness: 120,
    showDimensions: true,
    showGrid: true,
    innerArea: false,
    dxfEscapeUnicode: false,
  };
}

type Listener = () => void;

const HISTORY_LIMIT = 100;

/**
 * シーンの単一の持ち主。変更は必ず commit() を通すことで undo/redo が成立する。
 * Excalidraw 流に「状態は素のデータ、更新はスナップショット」で割り切っている。
 */
export class Store {
  scene: Scene = emptyScene();
  settings: Settings = defaultSettings();
  selection: EntityRef[] = [];

  private undoStack: Scene[] = [];
  private redoStack: Scene[] = [];
  private listeners = new Set<Listener>();
  /** commit 中のネストを検出して二重スナップショットを防ぐ */
  private inCommit = false;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** 履歴に残る変更。fn が false を返したら変更なしとして履歴を積まない */
  commit(fn: () => void | boolean): void {
    if (this.inCommit) {
      fn();
      return;
    }
    const snapshot = structuredClone(this.scene);
    this.inCommit = true;
    let result: void | boolean;
    try {
      result = fn();
    } finally {
      this.inCommit = false;
    }
    if (result === false) {
      this.scene = snapshot;
      return;
    }
    this.undoStack.push(snapshot);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.pruneSelection();
    this.emit();
  }

  /**
   * ドラッグのように「開始時のスナップショットを取り、途中は自由に書き換える」種類の操作用。
   * before には操作開始前のシーンを渡す。
   */
  commitFrom(before: Scene): void {
    this.undoStack.push(before);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.pruneSelection();
    this.emit();
  }

  /** 履歴に残さない変更（選択・表示設定など） */
  update(fn: () => void): void {
    fn();
    this.emit();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(structuredClone(this.scene));
    this.scene = prev;
    this.pruneSelection();
    this.emit();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(structuredClone(this.scene));
    this.scene = next;
    this.pruneSelection();
    this.emit();
  }

  replaceScene(scene: Scene, { keepHistory = true }: { keepHistory?: boolean } = {}): void {
    if (keepHistory) {
      this.undoStack.push(structuredClone(this.scene));
      this.redoStack.length = 0;
    } else {
      this.undoStack.length = 0;
      this.redoStack.length = 0;
    }
    this.scene = scene;
    this.selection = [];
    this.emit();
  }

  // --- 選択 ---

  isSelected(ref: EntityRef): boolean {
    return this.selection.some((s) => sameRef(s, ref));
  }

  setSelection(refs: EntityRef[]): void {
    this.selection = refs;
    this.emit();
  }

  toggleSelection(ref: EntityRef): void {
    if (this.isSelected(ref)) {
      this.selection = this.selection.filter((s) => !sameRef(s, ref));
    } else {
      this.selection = [...this.selection, ref];
    }
    this.emit();
  }

  clearSelection(): void {
    if (this.selection.length === 0) return;
    this.selection = [];
    this.emit();
  }

  /** 削除済みエンティティへの参照を選択から落とす */
  private pruneSelection(): void {
    const exists = (ref: EntityRef): boolean => {
      const table = this.tableFor(ref.type);
      return table[ref.id] !== undefined;
    };
    this.selection = this.selection.filter(exists);
  }

  private tableFor(type: EntityRef['type']): Record<Id, unknown> {
    switch (type) {
      case 'node':
        return this.scene.nodes;
      case 'wall':
        return this.scene.walls;
      case 'opening':
        return this.scene.openings;
      case 'furniture':
        return this.scene.furniture;
      case 'roomLabel':
        return this.scene.roomLabels;
    }
  }
}
