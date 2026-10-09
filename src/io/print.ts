import { paperDimensions } from '../core/sheet.ts';
import type { DrawingStandard } from '../core/standard.ts';

/**
 * SVG を実寸で印刷するための最小の HTML を組む。
 *
 * PDF 出力は自前で書かない。日本語を PDF に埋めるには CID フォントのサブセット埋め込みが要り、
 * 「実行時の依存ライブラリなし」という方針と正面衝突する。
 * ブラウザの「PDF として保存」ならベクタのまま、フォントも正しく出る。
 */
export function buildPrintDocument(svg: string, std: DrawingStandard): string {
  const { w, h } = paperDimensions(std);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>MiniCAD — 1:${std.scale}</title>
<style>
  @page { size: ${w}mm ${h}mm; margin: 0; }
  html, body { margin: 0; padding: 0; }
  svg { display: block; width: ${w}mm; height: ${h}mm; }
</style>
</head>
<body>${svg}</body>
</html>`;
}

/** 別ウィンドウに開いて印刷ダイアログを出す */
export function printDocument(html: string): boolean {
  const win = window.open('', '_blank');
  if (!win) return false;
  win.document.write(html);
  win.document.close();
  // 画像やフォントの読み込みを待ってから印刷する
  win.addEventListener('load', () => {
    win.focus();
    win.print();
  });
  return true;
}
