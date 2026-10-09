import { emptyScene } from '../../core/types.ts';
import { downloadDxf } from '../../io/dxf.ts';
import { clearLocal, deserialize, downloadJson, triggerDownload } from '../../io/scene.ts';
import { sampleScene } from '../../io/sample.ts';
import { sceneToSvg } from '../../io/svg.ts';
import { buildPrintDocument, printDocument } from '../../io/print.ts';
import { el } from '../dom.ts';
import type { Panel, PanelContext } from '../panel.ts';

export class FileActions implements Panel {
  constructor(private readonly host: HTMLElement) {}

  build(ctx: PanelContext): void {
    const button = (label: string, onClick: () => void, title?: string) =>
      el('button', { type: 'button', onclick: onClick, title: title ?? label }, [label]);

    const fileInput = el('input', { type: 'file', accept: '.json,application/json' });
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      void file.text().then((text) => {
        try {
          ctx.loadScene(deserialize(JSON.parse(text)));
        } catch (err) {
          window.alert(`読み込めませんでした: ${(err as Error).message}`);
        }
      });
      fileInput.value = '';
    });

    this.host.append(
      button('新規', () => {
        if (!window.confirm('現在の間取りを破棄して新規作成しますか？')) return;
        clearLocal();
        ctx.loadScene(emptyScene());
      }),
      button('サンプル', () => {
        if (!window.confirm('現在の間取りを破棄してサンプルを読み込みますか？')) return;
        ctx.loadScene(sampleScene());
      }),
      button('開く', () => fileInput.click(), 'JSON を読み込む'),
      button('保存', () => downloadJson(ctx.editor.store.scene), 'JSON で保存 (Cmd/Ctrl+S)'),
      button(
        'SVG',
        () => {
          const svg = sceneToSvg(ctx.editor.store.scene, ctx.editor.rooms, ctx.editor.store.settings);
          triggerDownload(new Blob([svg], { type: 'image/svg+xml' }), 'madori.svg');
        },
        'SVG で書き出す',
      ),
      button(
        'DXF',
        () => {
          const store = ctx.editor.store;
          downloadDxf(store.scene, ctx.editor.rooms, store.settings, {
            escapeUnicode: store.settings.dxfEscapeUnicode,
          });
        },
        'DXF (R12) で書き出す — 他の CAD で開けます',
      ),
      button(
        '印刷',
        () => {
          const scene = ctx.editor.store.scene;
          const svg = sceneToSvg(scene, ctx.editor.rooms, ctx.editor.store.settings);
          if (!printDocument(buildPrintDocument(svg, scene.standard))) {
            window.alert('印刷用のウィンドウを開けませんでした。ポップアップの許可を確認してください。');
          }
        },
        '実寸で印刷する（ブラウザから PDF として保存もできます）',
      ),
      button('全体表示', () => ctx.editor.zoomToFit(), '図面全体を表示 (0)'),
      button('用紙に合わせる', () => ctx.editor.zoomToSheet(), '用紙全体が見えるように表示'),
      fileInput,
    );
  }

  refresh(): void {
    // ファイル操作は状態に依存しないので描き直す必要がない
  }
}
