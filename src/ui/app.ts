import { removeEntities } from '../core/entity.ts';
import { saveLocal } from '../io/scene.ts';
import type { Scene } from '../core/types.ts';
import type { ToolId } from '../tools/tool.ts';
import { CommandInput } from './command-input.ts';
import { Editor } from './editor.ts';
import { defaultBindings, installKeymap, type Binding } from './keymap.ts';
import type { Panel, PanelContext } from './panel.ts';
import { buildSections } from './section-registry.ts';
import { buildTools } from './tool-registry.ts';
import { DEFAULT_MODE, type Mode } from './mode.ts';
import { FileActions } from './panels/file-actions.ts';
import { Inspector } from './panels/inspector.ts';
import { OptionsBar } from './panels/options-bar.ts';
import { Toolbar } from './panels/toolbar.ts';
import { ModeSwitch } from './panels/mode-switch.ts';
import { StatusBar } from './status-bar.ts';
import { ViewTabs } from './panels/view-tabs.ts';
import { Viewer3D } from '../render3d/viewer.ts';
import { ViewState, type ViewMode } from './view-state.ts';
import { buildShell } from './shell.ts';

const AUTOSAVE_DELAY_MS = 600;

/**
 * 画面の配線だけを持つ。描画の中身は各パネルにある。
 * パネルを足すときは、生成して `panels` に入れるだけで済む。
 */
export class App {
  private readonly editor: Editor;
  private readonly panels: Panel[];
  private readonly statusBar: StatusBar;
  private readonly viewer3d: Viewer3D;
  private readonly ctx: PanelContext;
  private autosaveTimer: number | undefined;

  readonly view: ViewState;
  private readonly canvasWrap: HTMLElement;
  private readonly toolbar: Toolbar;
  private readonly inspector: Inspector;
  private readonly bindings: Binding[];
  private currentMode: Mode = DEFAULT_MODE;

  constructor(host: HTMLElement) {
    // 骨組みは自分で組む。埋め込まれるとき、MiniCAD は入る箱しか貰えない
    const shell = buildShell(host);
    this.editor = new Editor(shell.canvas);
    this.viewer3d = new Viewer3D(shell.canvas3d, this.editor);
    this.canvasWrap = shell.canvasWrap;
    // **ビューの状態は App が持つ。** `Viewer3D.visible` は従属に降りる
    this.view = new ViewState((mode) => this.applyView(mode));

    // 何を出すかはレジストリが決める。ここは並べるだけ
    for (const tool of buildTools(this.currentMode)) this.editor.registerTool(tool);

    this.ctx = {
      editor: this.editor,
      refresh: () => this.refresh(),
      edit: (fn) => this.editor.store.commit(fn),
      set: (fn) => this.editor.store.update(fn),
      deleteSelection: () => this.deleteSelection(),
      loadScene: (scene) => this.loadScene(scene),
      view: this.view,
      mode: this.currentMode,
      setMode: (mode) => this.setMode(mode),
      selectTool: (id) => this.selectTool(id),
    };

    const bindings = defaultBindings();
    this.bindings = bindings;
    // 3D の切り替えだけは Viewer を掴む必要があるので、ここで足す。
    // 表に入れておけばショートカット一覧にも自動で出る
    bindings.push({
      keys: ['F3'],
      display: 'F3',
      description: '2D / 3D 切り替え',
      run: (ctx) => {
        this.view.toggle3d();
        ctx.refresh();
      },
    });
    const toolbar = new Toolbar(shell.toolbar);
    this.toolbar = toolbar;
    const fileActions = new FileActions(shell.fileActions);
    const modeSwitch = new ModeSwitch(shell.modeSwitch);
    const commandInput = new CommandInput(shell.numeric, shell.numericInput, shell.numericLabel);
    this.statusBar = new StatusBar(shell.statusHint, shell.statusReadout, this.viewer3d);

    this.inspector = new Inspector(shell.inspector, buildSections({ bindings }, this.currentMode));
    this.panels = [
      toolbar,
      modeSwitch,
      fileActions,
      new OptionsBar(shell.options),
      this.inspector,
      this.statusBar,
      commandInput,
      new ViewTabs(shell.viewTabs, this.viewer3d),
    ];

    toolbar.build(this.ctx);
    fileActions.build(this.ctx);
    commandInput.build(this.ctx);
    installKeymap(this.ctx, bindings, commandInput);

    // 座標表示はポインタが動くたびに更新したいので、全体の再描画とは別経路にする
    shell.canvas.addEventListener('pointermove', () => this.statusBar.refreshReadout(this.ctx));

    this.editor.onChange(() => this.refresh());
    this.refresh();
  }

  loadScene(scene: Scene, { keepHistory = false } = {}): void {
    this.editor.store.replaceScene(scene, { keepHistory });
    this.editor.zoomToFit();
  }

  get editorInstance(): Editor {
    return this.editor;
  }

  get viewer(): Viewer3D {
    return this.viewer3d;
  }

  get mode(): Mode {
    return this.currentMode;
  }

  /**
   * モードの切り替え。**出すものを決め直して組み直すだけ。**
   *
   * 隠すツールは登録から外す（`Editor.setTools`）ので、ツールバーも
   * キーマップもショートカット一覧も `allTools()` を見ていて自動で揃う。
   * 第 2 の codebase は作らない。差は表の `modes` 欄にしかない。
   */
  private setMode(mode: Mode): void {
    if (this.currentMode === mode) return;
    this.currentMode = mode;
    this.ctx.mode = mode;
    this.editor.setTools(buildTools(mode));
    this.toolbar.build(this.ctx);
    this.inspector.setSections(buildSections({ bindings: this.bindings }, mode));
    this.refresh();
  }

  /**
   * ツールを選ぶ。**作図のツールを選んだら 2D に戻す。**
   *
   * 3D では作図できない（Phase 1 で意図して外した）ので、3D を見たまま壁ツールを
   * 選ぶと、押しても何も起きない行き止まりになる。ワイヤーも通常モード・プロモードの
   * 両方で「選択時にビューが 2D に切り替わる」と書いている。
   */
  private selectTool(id: ToolId): void {
    if (id !== 'select' && !this.view.shows2d) this.view.set('2d');
    this.editor.setTool(id);
  }

  private deleteSelection(): void {
    const store = this.editor.store;
    if (store.selection.length === 0) return;
    const refs = [...store.selection];
    store.commit(() => removeEntities(store.scene, refs));
    store.clearSelection();
  }

  /**
   * ビューの切り替え。**CSS のクラスと 3D の表示だけ**を動かす。
   *
   * `Editor.observeResize` にも `Viewer3D.observeResize` にも触らない。
   * 親のレイアウトが変われば、どちらの `ResizeObserver` も自分で気づいて
   * 測り直す。**2 枚のキャンバスに分けた当初の判断が、ここで初めて本当に効く。**
   *
   * クラスを先に当てるのは、`setVisible` が中で `measure()` を呼ぶため。
   * 順番が逆だと、分割になる前の幅で測ってしまう。
   */
  private applyView(mode: ViewMode): void {
    this.canvasWrap.classList.toggle('split', mode === 'split');
    this.viewer3d.setVisible(this.view.shows3d);
    this.editor.requestRender();
    this.refresh();
  }

  private refresh(): void {
    for (const panel of this.panels) panel.refresh(this.ctx);
    this.scheduleAutosave();
  }

  private scheduleAutosave(): void {
    window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => saveLocal(this.editor.store.scene), AUTOSAVE_DELAY_MS);
  }
}
