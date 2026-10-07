import { toDeg, toRad } from '../core/geometry.ts';
import { isSelectable, removeEntities } from '../core/entity.ts';
import { wallLength } from '../core/ops.ts';
import { toTatami } from '../core/rooms.ts';
import { FURNITURE_PRESETS } from '../core/shape.ts';
import { emptyScene } from '../core/types.ts';
import { downloadDxf } from '../io/dxf.ts';
import { layerWeight, type Layer } from '../core/layer.ts';
import {
  LINE_GROUPS,
  LINE_TYPE_LABELS,
  PAPER_SIZES,
  PLAN_SCALES,
  JIS_TEXT_HEIGHTS,
  STANDARD_PRESETS,
  lineGroupById,
  type LineType,
  type WeightRole,
} from '../core/standard.ts';
import { clearLocal, deserialize, downloadJson, saveLocal, triggerDownload } from '../io/scene.ts';
import { sampleScene } from '../io/sample.ts';
import { sceneToSvg } from '../io/svg.ts';
import { FurnitureTool } from '../tools/furniture.ts';
import { MeasureTool } from '../tools/measure.ts';
import { OpeningTool } from '../tools/opening.ts';
import { RoomTool } from '../tools/room.ts';
import { SelectTool } from '../tools/select.ts';
import { WallTool } from '../tools/wall.ts';
import type { ToolId } from '../tools/tool.ts';
import { checkboxField, clear, el, numberField, readonlyField, selectField, textField } from './dom.ts';
import { Editor, isTextInput } from './editor.ts';

const TOOL_GLYPH: Record<ToolId, string> = {
  select: '↖',
  wall: '▬',
  door: '⌒',
  window: '▤',
  furniture: '▦',
  room: 'あ',
  measure: '↔',
};

export class App {
  private readonly editor: Editor;
  private readonly toolbar: HTMLElement;
  private readonly options: HTMLElement;
  private readonly inspector: HTMLElement;
  private readonly statusHint: HTMLElement;
  private readonly statusReadout: HTMLElement;
  private readonly numericForm: HTMLFormElement;
  private readonly numericInput: HTMLInputElement;
  private readonly numericLabel: HTMLElement;

  private readonly selectTool = new SelectTool();
  private readonly wallTool = new WallTool();
  private readonly doorTool = new OpeningTool('door', 'door', 'ドア', 'D', 800);
  private readonly windowTool = new OpeningTool('window', 'window', '窓', 'S', 1700);
  private readonly furnitureTool = new FurnitureTool();
  private readonly roomTool = new RoomTool();
  private readonly measureTool = new MeasureTool();

  private autosaveTimer: number | undefined;

  constructor(root: Document = document) {
    const canvas = root.getElementById('canvas') as HTMLCanvasElement;
    this.editor = new Editor(canvas);
    this.toolbar = root.getElementById('toolbar')!;
    this.options = root.getElementById('options')!;
    this.inspector = root.getElementById('inspector')!;
    this.statusHint = root.getElementById('status-hint')!;
    this.statusReadout = root.getElementById('status-readout')!;
    this.numericForm = root.getElementById('numeric') as HTMLFormElement;
    this.numericInput = root.getElementById('numeric-input') as HTMLInputElement;
    this.numericLabel = root.getElementById('numeric-label')!;

    for (const tool of [
      this.selectTool,
      this.wallTool,
      this.doorTool,
      this.windowTool,
      this.furnitureTool,
      this.roomTool,
      this.measureTool,
    ]) {
      this.editor.registerTool(tool);
    }

    this.buildToolbar();
    this.buildFileActions(root);
    this.bindNumeric();
    this.bindKeyboard();
    this.bindPointerReadout();

    this.editor.onChange(() => this.refresh());
    this.refresh();
  }

  loadScene(scene: ReturnType<typeof emptyScene>, { keepHistory = false } = {}): void {
    this.editor.store.replaceScene(scene, { keepHistory });
    this.editor.zoomToFit();
  }

  get editorInstance(): Editor {
    return this.editor;
  }

  // --- ツールバー ---

  private buildToolbar(): void {
    clear(this.toolbar);
    for (const tool of this.editor.allTools()) {
      const button = el(
        'button',
        {
          class: 'tool-button',
          type: 'button',
          title: `${tool.label} (${tool.shortcut})`,
          'data-tool': tool.id,
          onclick: () => {
            this.editor.setTool(tool.id);
            this.editor.canvas.focus();
          },
        },
        [
          el('span', { class: 'glyph' }, [TOOL_GLYPH[tool.id]]),
          el('span', {}, [tool.label]),
          el('span', { class: 'key' }, [tool.shortcut]),
        ],
      );
      this.toolbar.append(button);
    }
  }

  private buildFileActions(root: Document): void {
    const host = root.getElementById('file-actions')!;
    const button = (label: string, onClick: () => void, title?: string) =>
      el('button', { type: 'button', onclick: onClick, title: title ?? label }, [label]);

    const fileInput = el('input', { type: 'file', accept: '.json,application/json' });
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      void file.text().then((text) => {
        try {
          this.loadScene(deserialize(JSON.parse(text)));
        } catch (err) {
          window.alert(`読み込めませんでした: ${(err as Error).message}`);
        }
      });
      fileInput.value = '';
    });

    host.append(
      button('新規', () => {
        if (!window.confirm('現在の間取りを破棄して新規作成しますか？')) return;
        clearLocal();
        this.loadScene(emptyScene());
      }),
      button('サンプル', () => {
        if (!window.confirm('現在の間取りを破棄してサンプルを読み込みますか？')) return;
        this.loadScene(sampleScene());
      }),
      button('開く', () => fileInput.click(), 'JSON を読み込む'),
      button('保存', () => downloadJson(this.editor.store.scene), 'JSON で保存 (Cmd/Ctrl+S)'),
      button('SVG', () => this.exportSvg(), 'SVG で書き出す'),
      button('DXF', () => this.exportDxf(), 'DXF (R12) で書き出す — 他の CAD で開けます'),
      button('全体表示', () => this.editor.zoomToFit(), '図面全体を表示 (0)'),
      fileInput,
    );
  }

  private exportSvg(): void {
    const svg = sceneToSvg(this.editor.store.scene, this.editor.rooms, this.editor.store.settings);
    triggerDownload(new Blob([svg], { type: 'image/svg+xml' }), 'madori.svg');
  }

  private exportDxf(): void {
    const store = this.editor.store;
    downloadDxf(store.scene, this.editor.rooms, store.settings, {
      escapeUnicode: store.settings.dxfEscapeUnicode,
    });
  }

  // --- 数値入力 ---

  private bindNumeric(): void {
    this.numericForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const entry = this.editor.tool.numericEntry?.(this.editor);
      if (!entry) return;
      entry.submit(this.editor, this.numericInput.value);
      this.numericInput.value = '';
      this.editor.canvas.focus();
      this.refresh();
    });
    this.numericInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.numericInput.value = '';
        this.editor.canvas.focus();
      }
      e.stopPropagation();
    });
  }

  private refreshNumeric(): void {
    const entry = this.editor.tool.numericEntry?.(this.editor);
    if (!entry) {
      this.numericForm.hidden = true;
      this.numericInput.value = '';
      return;
    }
    this.numericForm.hidden = false;
    this.numericInput.placeholder = entry.placeholder;
    this.numericLabel.textContent = entry.hint;
  }

  // --- キーボード ---

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      if (isTextInput(e.target)) return;

      // 作図中の数値入力: 数字を打ったらそのまま入力欄へ流し込む
      if (!e.metaKey && !e.ctrlKey && /^[0-9.]$/.test(e.key) && !this.numericForm.hidden) {
        this.numericInput.value = e.key;
        this.numericInput.focus();
        e.preventDefault();
        return;
      }

      if (this.editor.tool.onKeyDown?.(this.editor, e)) {
        e.preventDefault();
        this.refresh();
        return;
      }

      const store = this.editor.store;
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        store.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        downloadJson(store.scene);
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const all = [
          ...Object.keys(store.scene.walls).map((id) => ({ type: 'wall' as const, id })),
          ...Object.keys(store.scene.furniture).map((id) => ({ type: 'furniture' as const, id })),
          ...Object.keys(store.scene.openings).map((id) => ({ type: 'opening' as const, id })),
        ];
        store.setSelection(all.filter((ref) => isSelectable(store.scene, ref)));
        return;
      }
      if (mod) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        if (this.editor.tool.isActive?.(this.editor)) this.editor.tool.cancel?.(this.editor);
        else if (store.selection.length > 0) store.clearSelection();
        else this.editor.setTool('select');
        this.refresh();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.deleteSelection();
        return;
      }
      if (e.key === '0') {
        e.preventDefault();
        this.editor.zoomToFit();
        return;
      }
      if (e.key === 'g' || e.key === 'G') {
        store.update(() => {
          store.settings.snapGrid = !store.settings.snapGrid;
        });
        return;
      }
      if (e.key === 'o' || e.key === 'O') {
        store.update(() => {
          store.settings.ortho = !store.settings.ortho;
        });
        return;
      }

      const tool = this.editor.allTools().find((t) => t.shortcut.toLowerCase() === e.key.toLowerCase());
      if (tool) {
        e.preventDefault();
        this.editor.setTool(tool.id);
      }
    });
  }

  private deleteSelection(): void {
    const store = this.editor.store;
    if (store.selection.length === 0) return;
    const refs = [...store.selection];
    store.commit(() => removeEntities(store.scene, refs));
    store.clearSelection();
  }

  private bindPointerReadout(): void {
    this.editor.canvas.addEventListener('pointermove', () => this.refreshReadout());
  }

  private refreshReadout(): void {
    const p = this.editor.pointerWorld();
    const s = this.editor.store.settings;
    const flags = [s.snapGrid ? 'グリッド' : null, s.ortho ? '直交' : null].filter(Boolean).join(' / ');
    const snap = this.editor.lastSnap;
    const snapText = snap && snap.kind !== 'free' && snap.label ? `  [${snap.label}]` : '';
    this.statusReadout.textContent =
      `X ${Math.round(p.x)}  Y ${Math.round(p.y)} mm   |   1:${Math.round(1 / this.editor.viewport.scale)}   |   ${flags || 'スナップなし'}${snapText}`;
  }

  // --- 再描画 ---

  private refresh(): void {
    for (const button of this.toolbar.querySelectorAll<HTMLButtonElement>('.tool-button')) {
      button.setAttribute('aria-pressed', String(button.dataset.tool === this.editor.activeToolId));
    }
    this.renderOptions();
    this.renderInspector();
    this.statusHint.textContent = this.editor.tool.status(this.editor);
    this.refreshNumeric();
    this.refreshReadout();
    this.scheduleAutosave();
  }

  private scheduleAutosave(): void {
    window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => saveLocal(this.editor.store.scene), 600);
  }

  private renderOptions(): void {
    clear(this.options);
    const store = this.editor.store;
    const refresh = () => {
      this.editor.requestRender();
      this.refresh();
    };

    switch (this.editor.activeToolId) {
      case 'wall': {
        this.options.append(
          inlineNumber('壁厚 (mm)', store.settings.wallThickness, 10, (v) => {
            store.settings.wallThickness = Math.max(10, v);
            refresh();
          }),
        );
        break;
      }
      case 'door':
      case 'window': {
        const tool = this.editor.activeToolId === 'door' ? this.doorTool : this.windowTool;
        this.options.append(
          inlineNumber('幅 (mm)', tool.width, 50, (v) => {
            tool.width = Math.max(100, v);
            refresh();
          }),
        );
        break;
      }
      case 'furniture': {
        const select = el('select', {});
        FURNITURE_PRESETS.forEach((p, i) => {
          const opt = el('option', { value: String(i) }, [`${p.name}  ${p.w}×${p.h}`]);
          if (p === this.furnitureTool.preset) opt.selected = true;
          select.append(opt);
        });
        select.addEventListener('change', () => {
          this.furnitureTool.preset = FURNITURE_PRESETS[Number(select.value)];
          refresh();
        });
        this.options.append(el('label', {}, ['家具', select]), el('span', {}, ['R で90°回転 / Alt で壁沿わせ解除']));
        break;
      }
      case 'room': {
        const input = el('input', { type: 'text', value: this.roomTool.name, placeholder: '部屋名' });
        input.addEventListener('input', () => {
          this.roomTool.name = input.value;
          this.editor.requestRender();
        });
        const quick = el('div', {}, []);
        for (const name of ['LDK', '洋室', '和室', '寝室', '浴室', '洗面', 'トイレ', '玄関', '廊下', 'クローゼット']) {
          quick.append(
            el(
              'button',
              {
                type: 'button',
                onclick: () => {
                  this.roomTool.name = name;
                  input.value = name;
                  this.editor.requestRender();
                },
              },
              [name],
            ),
          );
        }
        quick.style.display = 'flex';
        quick.style.gap = '3px';
        quick.style.flexWrap = 'wrap';
        for (const b of quick.querySelectorAll('button')) {
          b.style.cssText = 'font:inherit;font-size:11px;padding:2px 6px;border:1px solid #d8d5cc;border-radius:4px;background:#fff;cursor:pointer';
        }
        this.options.append(el('label', {}, ['部屋名', input]), quick);
        break;
      }
      default:
        break;
    }
  }

  private renderInspector(): void {
    clear(this.inspector);
    const store = this.editor.store;
    const scene = store.scene;
    const sel = store.selection;

    this.inspector.append(el('h2', {}, ['プロパティ']));

    if (sel.length === 0) {
      this.inspector.append(el('p', { class: 'empty-note' }, ['何も選択されていません。']));
    } else if (sel.length > 1) {
      this.inspector.append(
        readonlyField('選択数', `${sel.length} 個`),
        el('button', { class: 'wide danger', type: 'button', onclick: () => this.deleteSelection() }, ['削除']),
      );
    } else {
      this.renderSingleSelection(sel[0]);
    }

    // --- 部屋一覧 ---
    const rooms = this.editor.rooms;
    this.inspector.append(el('h2', {}, ['部屋']));
    if (rooms.length === 0) {
      this.inspector.append(el('p', { class: 'empty-note' }, ['壁で囲まれた領域が部屋として自動認識されます。']));
    } else {
      const list = el('ul', { class: 'room-list' }, []);
      let total = 0;
      for (const room of rooms) {
        const area = store.settings.innerArea ? room.innerArea : room.area;
        total += area;
        list.append(
          el('li', {}, [
            el('span', {}, [room.name ?? '(無名)']),
            el('span', {}, [`${area.toFixed(2)} m² / ${toTatami(area).toFixed(1)}帖`]),
          ]),
        );
      }
      list.append(
        el('li', {}, [el('span', {}, ['合計']), el('span', {}, [`${total.toFixed(2)} m² / ${toTatami(total).toFixed(1)}帖`])]),
      );
      this.inspector.append(list);
    }

    this.renderStandardSection();
    this.renderLayerSection();

    // --- 設定 ---
    this.inspector.append(el('h2', {}, ['作図設定']));
    const setting = (fn: () => void) =>
      store.update(() => {
        fn();
      });
    this.inspector.append(
      numberField('グリッド間隔', store.settings.gridSize, (v) => setting(() => (store.settings.gridSize = Math.max(1, v))), {
        step: 50,
        min: 1,
        suffix: 'mm',
      }),
      numberField(
        '新規の壁厚',
        store.settings.wallThickness,
        (v) => setting(() => (store.settings.wallThickness = Math.max(10, v))),
        { step: 10, min: 10, suffix: 'mm' },
      ),
      checkboxField('グリッドにスナップ (G)', store.settings.snapGrid, (v) => setting(() => (store.settings.snapGrid = v))),
      checkboxField('端点・交点にスナップ', store.settings.snapNode, (v) => setting(() => (store.settings.snapNode = v))),
      checkboxField('壁上にスナップ', store.settings.snapWall, (v) => setting(() => (store.settings.snapWall = v))),
      checkboxField('直交・角度スナップ (O)', store.settings.ortho, (v) => setting(() => (store.settings.ortho = v))),
      checkboxField('グリッドを表示', store.settings.showGrid, (v) => setting(() => (store.settings.showGrid = v))),
      checkboxField('寸法を表示', store.settings.showDimensions, (v) => setting(() => (store.settings.showDimensions = v))),
      checkboxField('面積を内法で表示', store.settings.innerArea, (v) => setting(() => (store.settings.innerArea = v))),
      checkboxField('DXFの日本語を \\U+ でエスケープ', store.settings.dxfEscapeUnicode, (v) =>
        setting(() => (store.settings.dxfEscapeUnicode = v)),
      ),
    );

    // --- 図面の統計 ---
    this.inspector.append(
      el('h2', {}, ['図面']),
      readonlyField('壁', `${Object.keys(scene.walls).length} 本`),
      readonlyField('開口部', `${Object.keys(scene.openings).length} 箇所`),
      readonlyField('家具', `${Object.keys(scene.furniture).length} 点`),
    );

    this.inspector.append(
      el('h2', {}, ['ショートカット']),
      el('div', { class: 'shortcut-list' }, [
        el('kbd', {}, ['V/W/D/S/F/N/M']),
        el('span', {}, ['ツール切替']),
        el('kbd', {}, ['ドラッグ']),
        el('span', {}, ['移動・範囲選択']),
        el('kbd', {}, ['中ドラッグ / Space']),
        el('span', {}, ['画面移動']),
        el('kbd', {}, ['ホイール']),
        el('span', {}, ['拡大縮小']),
        el('kbd', {}, ['0']),
        el('span', {}, ['全体表示']),
        el('kbd', {}, ['Esc']),
        el('span', {}, ['取り消し・選択解除']),
        el('kbd', {}, ['[ ]']),
        el('span', {}, ['家具を回転']),
      ]),
    );
  }

  /** 製図規格。シーンの属性なので変更は履歴に残す */
  private renderStandardSection(): void {
    const store = this.editor.store;
    const std = store.scene.standard;
    const edit = (fn: () => void) => store.commit(fn);
    const group = lineGroupById(std.lineGroupId);

    this.inspector.append(
      el('h2', {}, ['製図規格']),
      selectField(
        'プリセット',
        '',
        [{ value: '', label: std.preset }, ...STANDARD_PRESETS.map((p) => ({ value: p.id, label: p.label }))],
        (v) => {
          const preset = STANDARD_PRESETS.find((p) => p.id === v);
          if (preset) edit(() => void (store.scene.standard = preset.make()));
        },
      ),
      selectField(
        '線群 (JIS Z 8312)',
        std.lineGroupId,
        LINE_GROUPS.map((g) => ({ value: g.id, label: g.label })),
        (v) => edit(() => void (std.lineGroupId = v)),
      ),
      selectField(
        '尺度 (JIS Z 8314)',
        String(std.scale),
        PLAN_SCALES.map((n) => ({ value: String(n), label: `1:${n}` })),
        (v) => edit(() => void (std.scale = Number(v))),
      ),
      selectField(
        '室名の文字高',
        String(std.textHeight.room),
        JIS_TEXT_HEIGHTS.map((h) => ({ value: String(h), label: `${h} mm` })),
        (v) => edit(() => void (std.textHeight.room = Number(v))),
      ),
      selectField(
        '寸法の文字高',
        String(std.textHeight.dimension),
        JIS_TEXT_HEIGHTS.map((h) => ({ value: String(h), label: `${h} mm` })),
        (v) => edit(() => void (std.textHeight.dimension = Number(v))),
      ),
      selectField(
        '用紙 (JIS Z 8311)',
        std.paperId,
        PAPER_SIZES.map((p) => ({ value: p.id, label: p.label })),
        (v) => edit(() => void (std.paperId = v)),
      ),
      checkboxField('壁を塗りつぶす', std.wallFill, (v) => edit(() => void (std.wallFill = v))),
      readonlyField('細 / 太 / 極太', `${group.thin} / ${group.thick} / ${group.extraThick} mm`),
    );
  }

  /** 画層。DXF の LAYER テーブルにそのまま対応する */
  private renderLayerSection(): void {
    const store = this.editor.store;
    const std = store.scene.standard;
    const edit = (fn: () => void) => store.commit(fn);

    this.inspector.append(el('h2', {}, ['画層 (DXF レイヤ)']));

    const roles: { value: WeightRole; label: string }[] = [
      { value: 'thin', label: '細線' },
      { value: 'thick', label: '太線' },
      { value: 'extraThick', label: '極太線' },
    ];
    const lineTypes = Object.entries(LINE_TYPE_LABELS) as [LineType, string][];

    for (const layer of Object.values(store.scene.layers)) {
      this.inspector.append(this.layerRow(layer, roles, lineTypes, std.lineGroupId, edit));
    }
  }

  private layerRow(
    layer: Layer,
    roles: { value: WeightRole; label: string }[],
    lineTypes: [LineType, string][],
    _lineGroupId: string,
    edit: (fn: () => void) => void,
  ): HTMLElement {
    const std = this.editor.store.scene.standard;
    const visible = el('input', { type: 'checkbox', checked: layer.visible, title: '表示' });
    visible.addEventListener('change', () => edit(() => void (layer.visible = visible.checked)));

    const swatch = el('span', { class: 'swatch', title: `ACI ${layer.aci}` });
    swatch.style.background = layer.color;

    const roleSelect = el('select', { title: '線の太さ' });
    for (const r of roles) {
      const opt = el('option', { value: r.value }, [r.label]);
      if (r.value === layer.weightRole) opt.selected = true;
      roleSelect.append(opt);
    }
    roleSelect.addEventListener('change', () =>
      edit(() => void (layer.weightRole = roleSelect.value as WeightRole)),
    );

    const typeSelect = el('select', { title: '線種' });
    for (const [value, label] of lineTypes) {
      const opt = el('option', { value }, [label]);
      if (value === layer.lineType) opt.selected = true;
      typeSelect.append(opt);
    }
    typeSelect.addEventListener('change', () => edit(() => void (layer.lineType = typeSelect.value as LineType)));

    return el('div', { class: 'layer-row' }, [
      el('div', { class: 'layer-head' }, [
        visible,
        swatch,
        el('span', { class: 'layer-name', title: layer.name }, [layer.name]),
        el('span', { class: 'layer-mm' }, [`${layerWeight(layer, std).toFixed(2)}mm`]),
      ]),
      el('div', { class: 'layer-controls' }, [roleSelect, typeSelect]),
    ]);
  }

  private renderSingleSelection(ref: (typeof this.editor.store.selection)[number]): void {
    const store = this.editor.store;
    const scene = store.scene;
    const edit = (fn: () => void) => store.commit(fn);

    switch (ref.type) {
      case 'wall': {
        const wall = scene.walls[ref.id];
        if (!wall) return;
        this.inspector.append(
          readonlyField('種類', '壁'),
          readonlyField('長さ', `${Math.round(wallLength(scene, wall))} mm`),
          numberField('壁厚', wall.thickness, (v) => edit(() => void (wall.thickness = Math.max(10, v))), {
            step: 10,
            min: 10,
            suffix: 'mm',
          }),
        );
        break;
      }
      case 'node': {
        const node = scene.nodes[ref.id];
        if (!node) return;
        this.inspector.append(
          readonlyField('種類', '壁の端点'),
          numberField('X', node.x, (v) => edit(() => void (node.x = v)), { step: 100, suffix: 'mm' }),
          numberField('Y', node.y, (v) => edit(() => void (node.y = v)), { step: 100, suffix: 'mm' }),
        );
        break;
      }
      case 'opening': {
        const op = scene.openings[ref.id];
        if (!op) return;
        const wall = scene.walls[op.wallId];
        this.inspector.append(
          selectField(
            '種類',
            op.kind,
            [
              { value: 'door', label: 'ドア' },
              { value: 'window', label: '窓' },
              { value: 'opening', label: '開口のみ' },
            ],
            (v) => edit(() => void (op.kind = v as typeof op.kind)),
          ),
          numberField('幅', op.width, (v) => edit(() => void (op.width = Math.max(100, v))), { step: 50, suffix: 'mm' }),
          numberField('始点からの位置', op.offset, (v) => edit(() => void (op.offset = v)), { step: 50, suffix: 'mm' }),
          readonlyField('壁の長さ', wall ? `${Math.round(wallLength(scene, wall))} mm` : '-'),
          checkboxField('吊元を反転', op.flipX, (v) => edit(() => void (op.flipX = v))),
          checkboxField('開く向きを反転', op.flipY, (v) => edit(() => void (op.flipY = v))),
        );
        break;
      }
      case 'furniture': {
        const f = scene.furniture[ref.id];
        if (!f) return;
        this.inspector.append(
          textField('名前', f.name, (v) => edit(() => void (f.name = v))),
          numberField('幅', f.w, (v) => edit(() => void (f.w = Math.max(50, v))), { step: 50, suffix: 'mm' }),
          numberField('奥行', f.h, (v) => edit(() => void (f.h = Math.max(50, v))), { step: 50, suffix: 'mm' }),
          numberField('角度', toDeg(f.angle), (v) => edit(() => void (f.angle = toRad(v))), { step: 15, suffix: '°' }),
          numberField('X', f.x, (v) => edit(() => void (f.x = v)), { step: 50, suffix: 'mm' }),
          numberField('Y', f.y, (v) => edit(() => void (f.y = v)), { step: 50, suffix: 'mm' }),
        );
        break;
      }
      case 'roomLabel': {
        const label = scene.roomLabels[ref.id];
        if (!label) return;
        this.inspector.append(textField('部屋名', label.name, (v) => edit(() => void (label.name = v))));
        break;
      }
    }

    this.inspector.append(
      el('button', { class: 'wide danger', type: 'button', onclick: () => this.deleteSelection() }, ['削除 (Delete)']),
    );
  }
}

function inlineNumber(label: string, value: number, step: number, onChange: (v: number) => void): HTMLElement {
  const input = el('input', { type: 'number', value: String(value), step });
  const commit = () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onChange(v);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      commit();
      input.blur();
    }
    e.stopPropagation();
  });
  return el('label', {}, [label, input]);
}
