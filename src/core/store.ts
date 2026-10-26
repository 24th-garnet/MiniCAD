import { ENTITY_KINDS } from './entity.ts';
import { pruneConstraints } from './constraintOps.ts';
import { solveScene, type SolveResult } from './constraintSolver.ts';
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
  showGrid: boolean;
  /** 面積を内法で表示する（false なら壁芯） */
  innerArea: boolean;
  /** DXF 書き出しで日本語を \U+XXXX に変換する */
  dxfEscapeUnicode: boolean;
  /** DXF を Shift-JIS (cp932) で書く。Jw_cad は Shift-JIS しか読めない */
  dxfShiftJis: boolean;
  /** DXF 書き出しで寸法を本物の DIMENSION エンティティにする */
  dxfTrueDimension: boolean;
  /** 幾何拘束の記号を画面に出す */
  showConstraints: boolean;
  /** 新しく作るものを置く画層。null なら種別ごとの既定 */
  currentLayerId: string | null;
}

export function defaultSettings(): Settings {
  return {
    gridSize: 100,
    snapGrid: true,
    snapNode: true,
    snapWall: true,
    ortho: true,
    wallThickness: 120,
    showGrid: true,
    innerArea: false,
    dxfEscapeUnicode: false,
    dxfShiftJis: false,
    dxfTrueDimension: true,
    showConstraints: true,
    currentLayerId: null,
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

  /**
   * 次の solve で動かさないノード。`commit` / `commitFrom` が1回使って必ず空にする。
   *
   * `commit` の呼び出しは17箇所あるのでシグネチャは変えない。
   * pin は正しさの要件ではなく「どちらが動くか」の指定で、ソルバは現在の配置から
   * 出発して近傍にとどまるので、pin を渡さなくても最小変更な解が得られる。
   */
  solverPins = new Set<Id>();

  private undoStack: Scene[] = [];
  private redoStack: Scene[] = [];
  private listeners = new Set<Listener>();
  /** commit 中のネストを検出して二重スナップショットを防ぐ */
  private inCommit = false;

  /**
   * 閲覧のみ。ホストが `capabilities.edit: false` を渡したとき立つ。
   *
   * **画面で道具を隠すだけにはしない。** 隠すのは行き止まりを減らすためで、
   * 保証にはならない——インスペクタの入力欄も、ドラッグも、ショートカットも、
   * それぞれ別の経路で書きに来る。`commit` / `commitFrom` / `undo` / `redo` は
   * **図面を書き換える経路の全部**なので、ここで 1 回止めれば漏れない。
   *
   * `update` は止めない。スナップやグリッドのような表示の設定で、
   * 図面の中身ではないため。
   */
  readOnly = false;

  /**
   * シーンの版。**シーンが実際に変わったときだけ上がる。**
   *
   * `emit()` は選択や表示設定の変更でも飛ぶ。派生データ（部屋の検出・3D の
   * メッシュ）がそれで作り直されると、**クリックしただけで全部組み直す**ことになる。
   * 通知と「中身が変わったか」を分けておく。
   *
   * 単調増加なので、`undo` でシーンが差し替わっても腐らない。
   */
  private version = 0;
  /** 直近の拘束の解き結果。画面で違反を赤く出すのに使う */
  lastSolve: SolveResult | null = null;

  /** シーンの版。派生データをキャッシュする側が、作り直す判断に使う */
  get sceneVersion(): number {
    return this.version;
  }

  /**
   * シーンを直に書き換えたあとの通知。ドラッグの途中のように、
   * `commit` を挟まずに中身が変わる経路で使う。
   */
  touchScene(): void {
    this.version += 1;
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** 履歴に残る変更。fn が false を返したら変更なしとして履歴を積まない */
  commit(fn: () => void | boolean): void {
    if (this.readOnly) return;
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
    const pins = this.takePins();
    if (result === false) {
      this.scene = snapshot;
      return;
    }
    this.applyConstraints(pins);
    this.undoStack.push(snapshot);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.pruneSelection();
    this.version += 1;
    this.emit();
  }

  /** 成否に関わらず pin は1回で使い切る */
  private takePins(): Set<Id> {
    const pins = this.solverPins;
    this.solverPins = new Set();
    return pins;
  }

  /**
   * 拘束を解く。
   *
   * ここが全編集経路の網になる。`undo` / `redo` / `replaceScene` では**解かない** —
   * 過去の状態を解き直すと undo → redo → undo が元に戻らず履歴が壊れるし、
   * 読み込んだ他人のファイルの形を勝手に動かすのも筋が悪い。
   */
  private applyConstraints(pinned: Set<Id>): void {
    pruneConstraints(this.scene);
    this.lastSolve = solveScene(this.scene, { pinned });
  }

  /**
   * ドラッグのように「開始時のスナップショットを取り、途中は自由に書き換える」種類の操作用。
   * before には操作開始前のシーンを渡す。
   */
  commitFrom(before: Scene): void {
    if (this.readOnly) {
      // 途中まで書き換わっているので、開始時の形に戻す
      this.scene = before;
      this.version += 1;
      this.emit();
      return;
    }
    this.applyConstraints(this.takePins());
    this.undoStack.push(before);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.pruneSelection();
    this.version += 1;
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
    if (this.readOnly) return;
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(structuredClone(this.scene));
    this.scene = prev;
    this.pruneSelection();
    this.version += 1;
    this.emit();
  }

  redo(): void {
    if (this.readOnly) return;
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(structuredClone(this.scene));
    this.scene = next;
    this.pruneSelection();
    this.version += 1;
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
    this.version += 1;
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
    this.selection = this.selection.filter(
      (ref) => ENTITY_KINDS[ref.type].table(this.scene)[ref.id] !== undefined,
    );
  }

}
