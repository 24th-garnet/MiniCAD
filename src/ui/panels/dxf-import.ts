import { checkboxField, el, selectField } from '../dom.ts';
import { dialogText, openDialog } from '../dialog.ts';
import type { PanelContext } from '../panel.ts';
import { parseDxfBytes, type DxfDocument } from '../../io/dxfRead.ts';
import { DxfFormatError } from '../../io/dxfTags.ts';
import {
  defaultImportOptions,
  dxfToScene,
  formatReport,
  importDxfInto,
  type ImportOptions,
} from '../../io/dxfImport.ts';

/** 単位セレクタの選択肢。mm への倍率をそのまま値にする */
const UNIT_CHOICES = [
  { value: '1', label: 'ミリメートル (mm)' },
  { value: '10', label: 'センチメートル (cm)' },
  { value: '1000', label: 'メートル (m)' },
  { value: '25.4', label: 'インチ (in)' },
  { value: '304.8', label: 'フィート (ft)' },
];

/** DXF を読み込む。設定を確認してから取り込み、結果を知らせる */
export function openDxfImport(ctx: PanelContext, file: File): void {
  void file.arrayBuffer().then(
    (buffer) => {
      let doc: DxfDocument;
      try {
        doc = parseDxfBytes(new Uint8Array(buffer));
      } catch (err) {
        const message = err instanceof DxfFormatError ? err.message : `読み込めませんでした: ${(err as Error).message}`;
        openDialog('DXF の読み込み', [dialogText(message)], [{ label: '閉じる', primary: true }]);
        return;
      }
      askOptions(ctx, doc, file.name);
    },
    (err: Error) => window.alert(`読み込めませんでした: ${err.message}`),
  );
}

function askOptions(ctx: PanelContext, doc: DxfDocument, filename: string): void {
  const options = defaultImportOptions(doc);
  let asNewDrawing = false;

  const summary = [...doc.counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind} ${count}`)
    .join(' / ');

  const body: (HTMLElement | string)[] = [
    dialogText(
      [
        `${filename}`,
        summary === '' ? '読み取れる図形が見つかりませんでした。' : `読み取れた要素: ${summary}`,
        `画層 ${doc.layers.size} / ブロック ${doc.blocks.size}`,
      ].join('\n'),
    ),
    selectField('単位', String(options.unitScale), UNIT_CHOICES, (v) => {
      options.unitScale = Number(v);
    }),
    selectField(
      '画層',
      options.layerMode,
      [
        { value: 'table', label: 'DXF の画層を取り込む' },
        { value: 'draft', label: 'すべて下図画層 (A-DRAFT) へ' },
      ],
      (v) => {
        options.layerMode = v as ImportOptions['layerMode'];
      },
    ),
    selectField(
      'ブロック',
      options.blockMode,
      [
        { value: 'define', label: 'ブロックとして取り込む' },
        { value: 'explode', label: '図形に分解する' },
      ],
      (v) => {
        options.blockMode = v as ImportOptions['blockMode'];
      },
    ),
    checkboxField('文字も取り込む', options.importText, (v) => {
      options.importText = v;
    }),
    checkboxField('原点に寄せる', options.recenter, (v) => {
      options.recenter = v;
    }),
    checkboxField('取り込んだ画層をロックする', options.lockImported, (v) => {
      options.lockImported = v;
    }),
    checkboxField('現在の図面を破棄して新規図面として開く', asNewDrawing, (v) => {
      asNewDrawing = v;
    }),
    el('p', { class: 'empty-note' }, [
      '取り込んだ線は下図として図形になります。壁として認識させるには、スナップを頼りに壁ツールでなぞり直してください。',
    ]),
  ];

  openDialog('DXF を読み込む', body, [
    { label: 'キャンセル' },
    {
      label: '読み込む',
      primary: true,
      onClick: () => runImport(ctx, doc, options, asNewDrawing),
    },
  ]);
}

function runImport(ctx: PanelContext, doc: DxfDocument, options: ImportOptions, asNewDrawing: boolean): void {
  if (asNewDrawing) {
    const { scene, report } = dxfToScene(doc, options);
    ctx.loadScene(scene);
    showReport(report);
    return;
  }

  // ctx.edit は store.commit なので、取り込み全体が 1 回の undo で取り消せる
  let report: ReturnType<typeof importDxfInto> | null = null;
  ctx.edit(() => {
    report = importDxfInto(ctx.editor.store.scene, doc, options);
  });
  ctx.editor.zoomToFit();
  if (report) showReport(report);
}

function showReport(report: ReturnType<typeof importDxfInto>): void {
  openDialog('DXF を読み込みました', [dialogText(formatReport(report))], [{ label: '閉じる', primary: true }]);
}
