import { removeEntities } from '../core/entity.ts';
import { saveLocal } from '../io/scene.ts';
import type { Scene } from '../core/types.ts';
import { FurnitureTool } from '../tools/furniture.ts';
import { MeasureTool } from '../tools/measure.ts';
import { OpeningTool } from '../tools/opening.ts';
import { RoomTool } from '../tools/room.ts';
import { SelectTool } from '../tools/select.ts';
import { DimensionTool } from '../tools/dimension.ts';
import { ShapeTool } from '../tools/shape.ts';
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
import { LayersSection } from './panels/sections/layers.ts';
import { RoomsSection } from './panels/sections/rooms.ts';
import { SelectionSection } from './panels/sections/selection.ts';
import { SettingsSection } from './panels/sections/settings.ts';
import { ShortcutsSection } from './panels/sections/shortcuts.ts';
import { SheetSection } from './panels/sections/sheet.ts';
import { StandardSection } from './panels/sections/standard.ts';
import { StatsSection } from './panels/sections/stats.ts';
import { StatusBar } from './status-bar.ts';

const AUTOSAVE_DELAY_MS = 600;

/**
 * 画面の配線だけを持つ。描画の中身は各パネルにある。
 * パネルを足すときは、生成して `panels` に入れるだけで済む。
 */
export class App {
  private readonly editor: Editor;
  private readonly panels: Panel[];
  private readonly statusBar: StatusBar;
  private readonly ctx: PanelContext;
  private autosaveTimer: number | undefined;

  constructor(root: Document = document) {
    const canvas = root.getElementById('canvas') as HTMLCanvasElement;
    this.editor = new Editor(canvas);

    // 並び順がそのままツールバーの並び。グループが変わるところに区切りが入る
    for (const tool of [
      new SelectTool(),
      new MeasureTool(),
      new TransformTool('copy', 'copy', '複写', 'Y'),
      new TransformTool('rotate', 'rotate', '回転', 'R'),
      new TransformTool('mirror', 'mirror', '鏡像', 'X'),
      new WallTool(),
      new OpeningTool('door', 'door', 'ドア', 'D', 800),
      new OpeningTool('window', 'window', '窓', 'S', 1700),
      new FurnitureTool(),
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
    };

    const bindings = defaultBindings();
    const toolbar = new Toolbar(root.getElementById('toolbar')!);
    const fileActions = new FileActions(root.getElementById('file-actions')!);
    const commandInput = new CommandInput(
      root.getElementById('numeric') as HTMLFormElement,
      root.getElementById('numeric-input') as HTMLInputElement,
      root.getElementById('numeric-label')!,
    );
    this.statusBar = new StatusBar(root.getElementById('status-hint')!, root.getElementById('status-readout')!);

    this.panels = [
      toolbar,
      fileActions,
      new OptionsBar(root.getElementById('options')!),
      new Inspector(root.getElementById('inspector')!, [
        new SelectionSection(),
        new RoomsSection(),
        new StandardSection(),
        new SheetSection(),
        new LayersSection(),
        new SettingsSection(),
        new StatsSection(),
        new ShortcutsSection(bindings),
      ]),
      this.statusBar,
      commandInput,
    ];

    toolbar.build(this.ctx);
    fileActions.build(this.ctx);
    commandInput.build(this.ctx);
    installKeymap(this.ctx, bindings, commandInput);

    // 座標表示はポインタが動くたびに更新したいので、全体の再描画とは別経路にする
    canvas.addEventListener('pointermove', () => this.statusBar.refreshReadout(this.ctx));

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

  private deleteSelection(): void {
    const store = this.editor.store;
    if (store.selection.length === 0) return;
    const refs = [...store.selection];
    store.commit(() => removeEntities(store.scene, refs));
    store.clearSelection();
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
