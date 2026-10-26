import { removeEntities } from '../core/entity.ts';
import { saveLocal } from '../io/scene.ts';
import type { Scene } from '../core/types.ts';
import { BlockInsertTool } from '../tools/block-insert.ts';
import { MeasureTool } from '../tools/measure.ts';
import { OpeningTool } from '../tools/opening.ts';
import { RoomTool } from '../tools/room.ts';
import { SelectTool } from '../tools/select.ts';
import { DimensionTool } from '../tools/dimension.ts';
import { ShapeTool } from '../tools/shape.ts';
import { ModifyTool } from '../tools/modify.ts';
import { TransformTool } from '../tools/transform.ts';
import { WallTool } from '../tools/wall.ts';
import { CommandInput } from './command-input.ts';
import { Editor } from './editor.ts';
import { defaultBindings, installKeymap } from './keymap.ts';
import type { Panel, PanelContext } from './panel.ts';
import { FileActions } from './panels/file-actions.ts';
import { Inspector } from './panels/inspector.ts';
import { OptionsBar } from './panels/options-bar.ts';
import { Toolbar } from './panels/toolbar.ts';
import { BlocksSection } from './panels/sections/blocks.ts';
import { LayersSection } from './panels/sections/layers.ts';
import { RoomsSection } from './panels/sections/rooms.ts';
import { SelectionSection } from './panels/sections/selection.ts';
import { ConstraintsSection } from './panels/sections/constraints.ts';
import { SettingsSection } from './panels/sections/settings.ts';
import { ShortcutsSection } from './panels/sections/shortcuts.ts';
import { SheetSection } from './panels/sections/sheet.ts';
import { StandardSection } from './panels/sections/standard.ts';
import { StatsSection } from './panels/sections/stats.ts';
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

  constructor(host: HTMLElement) {
    // 骨組みは自分で組む。埋め込まれるとき、MiniCAD は入る箱しか貰えない
    const shell = buildShell(host);
    this.editor = new Editor(shell.canvas);
    this.viewer3d = new Viewer3D(shell.canvas3d, this.editor);
    this.canvasWrap = shell.canvasWrap;
    // **ビューの状態は App が持つ。** `Viewer3D.visible` は従属に降りる
    this.view = new ViewState((mode) => this.applyView(mode));

    // 並び順がそのままツールバーの並び。グループが変わるところに区切りが入る
    for (const tool of [
      new SelectTool(),
      new MeasureTool(),
      new TransformTool('copy', 'copy', '複写', 'Y'),
      new TransformTool('rotate', 'rotate', '回転', 'R'),
      new TransformTool('mirror', 'mirror', '鏡像', 'X'),
      new ModifyTool('offset', 'offset', 'オフセット', 'O'),
      new ModifyTool('trim', 'trim', 'トリム', 'U'),
      new ModifyTool('extend', 'extend', '延長', 'E'),
      new WallTool(),
      new OpeningTool('door', 'door', 'ドア', 'D'),
      new OpeningTool('window', 'window', '窓', 'S'),
      new BlockInsertTool(),
      new ShapeTool('line', 'line', '線', 'L'),
      new ShapeTool('arc', 'arc', '円・弧', 'C'),
      new ShapeTool('point', 'point', '点', 'Q'),
      new ShapeTool('text', 'text', '文字', 'T'),
      new DimensionTool(),
      new RoomTool(),
    ]) {
      this.editor.registerTool(tool);
    }

    this.ctx = {
      editor: this.editor,
      refresh: () => this.refresh(),
      edit: (fn) => this.editor.store.commit(fn),
      set: (fn) => this.editor.store.update(fn),
      deleteSelection: () => this.deleteSelection(),
      loadScene: (scene) => this.loadScene(scene),
      view: this.view,
    };

    const bindings = defaultBindings();
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
    const fileActions = new FileActions(shell.fileActions);
    const commandInput = new CommandInput(shell.numeric, shell.numericInput, shell.numericLabel);
    this.statusBar = new StatusBar(shell.statusHint, shell.statusReadout, this.viewer3d);

    this.panels = [
      toolbar,
      fileActions,
      new OptionsBar(shell.options),
      new Inspector(shell.inspector, [
        new SelectionSection(),
        new ConstraintsSection(),
        new RoomsSection(),
        new StandardSection(),
        new SheetSection(),
        new LayersSection(),
        new BlocksSection(),
        new SettingsSection(),
        new StatsSection(),
        new ShortcutsSection(bindings),
      ]),
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
