import { emptyScene } from '../../core/types.ts';
import { downloadDxf } from '../../io/dxf.ts';
import { measuresToJson, sceneToMeasures } from '../../io/measures.ts';
import { elevationToSvg, sceneToElevations } from '../../io/elevation.ts';
import { clearLocal, deserialize, downloadJson, triggerDownload } from '../../io/scene.ts';
import { sampleScene } from '../../io/sample.ts';
import { sceneToSvg } from '../../io/svg.ts';
import { buildPrintDocument, printDocument } from '../../io/print.ts';
import { el } from '../dom.ts';
import { openDxfImport } from './dxf-import.ts';
import type { Panel, PanelContext } from '../panel.ts';

export class FileActions implements Panel {
  constructor(private readonly host: HTMLElement) {}

  build(ctx: PanelContext): void {
    const button = (label: string, onClick: () => void, title?: string) =>
      el('button', { type: 'button', onclick: onClick, title: title ?? label }, [label]);
    // 出さないものは `null` にして最後に落とす。`el` は null を無視する
    const when = (ok: boolean, node: HTMLElement) => (ok ? node : null);
    const canEdit = ctx.can.edit;
    const canDownload = ctx.can.download;

    const fileInput = el('input', { type: 'file', accept: '.json,.dxf,application/json' });
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      // DXF は設定を聞いてから取り込むので、JSON とは別経路にする
      if (file.name.toLowerCase().endsWith('.dxf')) {
        openDxfImport(ctx, file);
        return;
      }
      void file.text().then((text) => {
        try {
          ctx.loadScene(deserialize(JSON.parse(text)));
        } catch (err) {
          window.alert(`読み込めませんでした: ${(err as Error).message}`);
        }
      });
    });

    this.host.append(
      ...[
      when(canEdit, button('新規', () => {
        if (!window.confirm('現在の間取りを破棄して新規作成しますか？')) return;
        clearLocal();
        ctx.loadScene(emptyScene());
      })),
      when(canEdit, button('サンプル', () => {
        if (!window.confirm('現在の間取りを破棄してサンプルを読み込みますか？')) return;
        ctx.loadScene(sampleScene());
      })),
      when(canEdit, button('開く', () => fileInput.click(), 'JSON / DXF を読み込む')),
      when(canDownload, button('保存', () => downloadJson(ctx.editor.store.scene), 'JSON で保存 (Cmd/Ctrl+S)')),
      when(canDownload, button(
        'SVG',
        () => {
          const svg = sceneToSvg(ctx.editor.store.scene, ctx.editor.rooms, ctx.editor.store.settings);
          triggerDownload(new Blob([svg], { type: 'image/svg+xml' }), 'madori.svg');
        },
        'SVG で書き出す',
      )),
      when(canDownload, button(
        'DXF',
        () => {
          const store = ctx.editor.store;
          const dropped = downloadDxf(store.scene, ctx.editor.rooms, store.settings, {
            escapeUnicode: store.settings.dxfEscapeUnicode,
            trueDimension: store.settings.dxfTrueDimension,
            shiftJis: store.settings.dxfShiftJis,
          });
          // **黙って ? に落とさない。** 室名が化けたまま渡るのが一番困る
          if (dropped.length > 0) {
            const chars = [...new Set(dropped)].join('');
            window.alert(`Shift-JIS に無い文字が ${dropped.length} 字ありました。`
              + `「?」になっています: ${chars}`);
          }
        },
        'DXF (R12) で書き出す — 他の CAD で開けます',
      )),
      when(canDownload, button(
        '数量',
        () => {
          const store = ctx.editor.store;
          const rooms = ctx.editor.rooms;
          if (rooms.length === 0) {
            window.alert('壁で閉じた部屋がありません。数量を拾えません。');
            return;
          }
          // 図面名は表題欄から取る。無ければ既定の名前
          const title = store.scene.sheet.titleBlock.fields.drawingName.trim();
          const planId = title.length > 0 ? title : 'madori';
          const file = sceneToMeasures(store.scene, rooms, { planId });
          const blob = new Blob([measuresToJson(file)], { type: 'application/json' });
          triggerDownload(blob, `${planId}.measures.json`);
        },
        '実測 JSON を書き出す — 数量拾いへ渡します',
      )),
      when(canDownload, button(
        '立面',
        () => {
          const scene = ctx.editor.store.scene;
          const got = sceneToElevations(scene);
          if (got.length === 0) {
            window.alert('開口のある壁がありません。立面を起こせません。');
            return;
          }
          const svg = elevationToSvg(got, {
            scale: scene.standard.scale,
            dimensions: true,
          });
          triggerDownload(new Blob([svg], { type: 'image/svg+xml' }), 'rimen.svg');
        },
        '開口のある壁の立面を SVG で書き出す',
      )),
      when(canDownload, button(
        '印刷',
        () => {
          const scene = ctx.editor.store.scene;
          const svg = sceneToSvg(scene, ctx.editor.rooms, ctx.editor.store.settings);
          if (!printDocument(buildPrintDocument(svg, scene.standard))) {
            window.alert('印刷用のウィンドウを開けませんでした。ポップアップの許可を確認してください。');
          }
        },
        '実寸で印刷する（ブラウザから PDF として保存もできます）',
      )),
      button('全体表示', () => ctx.editor.zoomToFit(), '図面全体を表示 (0)'),
      button('用紙に合わせる', () => ctx.editor.zoomToSheet(), '用紙全体が見えるように表示'),
      fileInput,
      ].filter((node) => node !== null),
    );
  }

  refresh(): void {
    // ファイル操作は状態に依存しないので描き直す必要がない
  }
}
