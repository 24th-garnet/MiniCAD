/**
 * `docs/*.md` を PDF にする。**仕様側へ渡すときだけ使う。**
 *
 * **PDF は成果物として持たない。** markdown が唯一の出どころで、
 * 置いておくと必ず古くなる（`.gitignore` に入れてある）。渡すときに作り直す。
 *
 * 組み立ては Chromium（通しテストで既に使っている）に任せる。
 * 和文の PDF をライブラリで組むと、フォントの埋め込みを自前で持つことになる。
 *
 *   npm run pdf -- docs/questions.md "表題" [--landscape]
 *
 * 表が主体の文書は `--landscape`。縦だと列が潰れる。
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2).filter((a) => a !== '--landscape');
const landscape = process.argv.includes('--landscape');
const [mdPath, title] = args;
if (!mdPath) {
  console.error('使い方: npm run pdf -- docs/questions.md "表題"');
  process.exit(1);
}
const outPath = resolve(mdPath.replace(/\.md$/, '.pdf'));
const body = execFileSync('python3', ['-I', new URL('md2html.py', import.meta.url).pathname, mdPath],
  { encoding: 'utf-8', maxBuffer: 1 << 24 });

const css = `
  @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 14mm 12mm 16mm; }
  :root { --ink: #26262b; --soft: #6b6b73; --line: #d8d5cc; --accent: #2563eb; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: var(--ink);
    font-family: "Hiragino Kaku Gothic ProN", "Noto Sans JP", system-ui, sans-serif;
    font-size: ${landscape ? '8.2pt' : '9.6pt'}; line-height: 1.7; font-feature-settings: "palt";
  }
  h1 {
    font-size: 19pt; margin: 0 0 4mm; padding-bottom: 3mm;
    border-bottom: 2px solid var(--ink); letter-spacing: .02em;
  }
  h2 {
    font-size: 12.5pt; margin: 9mm 0 3mm; padding-left: 3mm;
    border-left: 3px solid var(--accent); line-height: 1.4;
    break-after: avoid; page-break-after: avoid;
  }
  h3 { font-size: 10.5pt; margin: 6mm 0 2mm; break-after: avoid; }
  /* 和文で両端揃えにすると、行によって字間が大きく伸びる */
  p { margin: 0 0 2.4mm; }
  strong { font-weight: 700; }
  code {
    font-family: "SF Mono", Menlo, monospace; font-size: .86em;
    background: #f1f0ec; border: 1px solid var(--line);
    border-radius: 2px; padding: 0 .3em;
  }
  a { color: var(--accent); text-decoration: none; }
  ul, ol { margin: 0 0 2.4mm; padding-left: 5.5mm; }
  li { margin-bottom: 1mm; }
  table {
    width: 100%; border-collapse: collapse; margin: 2mm 0 3.5mm;
    font-size: ${landscape ? '7.6pt' : '9pt'}; line-height: 1.55;
  }
  /* 表は行単位で割る。1 行が丸ごと次ページへ移る */
  tr { break-inside: avoid; page-break-inside: avoid; }
  thead { display: table-header-group; }
  th, td { border: 1px solid var(--line); padding: 1.6mm 2.2mm; text-align: left; vertical-align: top; }
  th { background: #f4f3ef; font-weight: 700; white-space: nowrap; }
  /* 番号と印の列は詰める。残りの幅を本文に回す（項目の一覧だけ） */
  .items th:nth-child(1), .items td:nth-child(1) { width: 6mm; text-align: right; white-space: nowrap; }
  .items th:nth-child(2), .items td:nth-child(2) { width: 30mm; }
  .items th:nth-child(3), .items td:nth-child(3) { width: 7mm; text-align: center; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 6mm 0; }
  /* 文章の塊はページをまたがない。**表を含む塊は行単位で割る**ので、
     まとめて次ページへ送ると紙が無駄になる */
  section.keep { break-inside: avoid; page-break-inside: avoid; }
  section > h2:first-child { margin-top: 0; }
`;

// `<hr>` で区切られた塊を 1 項目として包む。ページ割りの単位になる
const sectioned = body
  .split('<hr>')
  .map((chunk) => chunk.trim())
  .filter(Boolean)
  .map((chunk) => `<section class="${chunk.includes('<table') ? '' : 'keep'}">${chunk}</section>`)
  .join('');

const page = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>${title ?? mdPath}</title><style>${css}</style></head><body>${sectioned}</body></html>`;

const htmlFile = `${outPath}.html`;
writeFileSync(htmlFile, page, 'utf-8');

const browser = await chromium.launch();
const tab = await browser.newPage();
await tab.goto(`file://${htmlFile}`, { waitUntil: 'networkidle' });
await tab.pdf({
  path: outPath,
  format: 'A4',
  printBackground: true,
  landscape,
  margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
  displayHeaderFooter: true,
  headerTemplate: `<div style="font-size:7pt;color:#6b6b73;width:100%;padding:0 12mm;
    font-family:'Hiragino Kaku Gothic ProN',sans-serif;">${title ?? ''}</div>`,
  footerTemplate: `<div style="font-size:7pt;color:#6b6b73;width:100%;padding:0 12mm;text-align:right;
    font-family:'Hiragino Kaku Gothic ProN',sans-serif;">
    <span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
});
await browser.close();
unlinkSync(htmlFile);
console.log('書き出し:', outPath);
