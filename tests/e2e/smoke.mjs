/**
 * 実ブラウザでの通し確認。
 * dev サーバを自分で起動し、サンプル間取りの上で一通りの作図操作を再現する。
 *
 *   npm run test:e2e              # 検証のみ
 *   npm run test:e2e -- --shots out/   # 各ステップのスクリーンショットも保存
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 5181;
const BASE = `http://localhost:${PORT}/`;
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg >= 0 ? process.argv[shotsArg + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stopServer = () => server.kill('SIGTERM');
process.on('exit', stopServer);

await waitForServer();

const problems = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`[console.${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

let failed = false;
try {
  await run();
} catch (err) {
  failed = true;
  console.error('✖', err.message);
} finally {
  await browser.close();
  stopServer();
}

if (problems.length > 0) {
  failed = true;
  console.error('✖ ブラウザのコンソールに問題が出ています:');
  for (const p of problems) console.error('   ', p);
}
console.log(failed ? '\n✖ e2e 失敗' : '\n✔ e2e 成功');
process.exit(failed ? 1 : 0);

// ---------------------------------------------------------------

async function run() {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.minicad !== undefined, { timeout: 10_000 });
  const box = await page.locator('#canvas').boundingBox();

  const at = async (wx, wy) => {
    const [x, y] = await page.evaluate(
      ([a, b]) => {
        const p = window.minicad.editorInstance.viewport.toScreen({ x: a, y: b });
        return [p.x, p.y];
      },
      [wx, wy],
    );
    const p = { x: box.x + x, y: box.y + y };
    assert.ok(
      p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height,
      `ワールド (${wx}, ${wy}) がキャンバスの外です`,
    );
    return p;
  };
  const clickWorld = async (wx, wy) => {
    const p = await at(wx, wy);
    await page.mouse.click(p.x, p.y);
  };
  const moveWorld = async (wx, wy) => {
    const p = await at(wx, wy);
    await page.mouse.move(p.x, p.y);
  };
  const state = () =>
    page.evaluate(() => {
      const ed = window.minicad.editorInstance;
      const s = ed.store.scene;
      return {
        tool: ed.activeToolId,
        walls: Object.keys(s.walls).length,
        openings: Object.keys(s.openings).length,
        furniture: Object.keys(s.furniture).length,
        shapes: Object.keys(s.shapes).length,
        rooms: ed.rooms.map((r) => ({ name: r.name, area: Number(r.area.toFixed(2)) })),
        selection: ed.store.selection.length,
        status: document.getElementById('status-hint').textContent,
        numericVisible: !document.getElementById('numeric').hidden,
        standard: {
          lineGroupId: s.standard.lineGroupId,
          scale: s.standard.scale,
          wallFill: s.standard.wallFill,
        },
        layerRows: document.querySelectorAll('.layer-row').length,
        wallLayerVisible: s.layers['wall'].visible,
        wallLayerLocked: s.layers['wall'].locked,
      };
    });

  let n = 0;
  const step = async (name, fn, check) => {
    await fn();
    await sleep(150);
    const st = await state();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${String(++n).padStart(2, '0')}-${name}.png` });
    try {
      check?.(st);
      console.log(`✔ ${name}`);
    } catch (err) {
      console.error(`✖ ${name}\n  ${err.message}\n  state: ${JSON.stringify(st)}`);
      throw err;
    }
  };

  await step('サンプル間取りが読み込まれる', async () => {}, (s) => {
    assert.equal(s.walls, 10);
    assert.deepEqual(
      s.rooms.map((r) => r.name).sort(),
      ['LDK', '水まわり', '洋室'].sort(),
    );
  });

  await step(
    '壁ツールに切り替わる',
    async () => {
      await page.evaluate(() => {
        const ed = window.minicad.editorInstance;
        ed.viewport.fit({ min: { x: -1200, y: -1200 }, max: { x: 15200, y: 7200 } });
        ed.requestRender();
      });
      await page.keyboard.press('w');
    },
    (s) => assert.equal(s.tool, 'wall'),
  );

  await step(
    '壁を連続作図すると数値入力欄が出る',
    async () => {
      await clickWorld(10000, 0);
      await clickWorld(14000, 0);
      await clickWorld(14000, 3000);
      await moveWorld(10000, 3000);
    },
    (s) => {
      assert.equal(s.walls, 12, '壁が2本増えているはず');
      assert.ok(s.numericVisible, '作図中は数値入力欄が出るはず');
    },
  );

  await step(
    '長さと角度の数値入力で壁が引ける',
    async () => {
      await page.fill('#numeric-input', '4000<180');
      await page.keyboard.press('Enter');
    },
    (s) => assert.equal(s.walls, 13),
  );

  await step(
    '閉じた領域が部屋として自動検出される',
    async () => {
      await clickWorld(10000, 0);
      await page.keyboard.press('Escape');
    },
    (s) => {
      assert.equal(s.walls, 14);
      assert.ok(!s.numericVisible, 'Esc で数値入力欄は閉じるはず');
      const room = s.rooms.find((r) => r.name === null);
      assert.ok(room, '無名の部屋が増えているはず');
      // 4000 x 3000 の壁芯面積
      assert.equal(room.area, 12);
    },
  );

  await step(
    '部屋に名前を付けられる',
    async () => {
      await page.keyboard.press('n');
      await page.fill('.options-bar input[type=text]', '書斎');
      await clickWorld(12000, 1500);
    },
    (s) => assert.ok(s.rooms.some((r) => r.name === '書斎' && r.area === 12)),
  );

  await step(
    'ドアを壁に差し込める',
    async () => {
      await page.keyboard.press('d');
      await moveWorld(12000, 0);
      await clickWorld(12000, 0);
    },
    (s) => assert.equal(s.openings, 8),
  );

  await step(
    '窓を壁に差し込める',
    async () => {
      await page.keyboard.press('s');
      await moveWorld(12000, 3000);
      await clickWorld(12000, 3000);
    },
    (s) => assert.equal(s.openings, 9),
  );

  await step(
    '家具を配置できる',
    async () => {
      await page.keyboard.press('f');
      await page.selectOption('.options-bar select', { index: 3 });
      await moveWorld(11500, 1500);
      await clickWorld(11500, 1500);
    },
    (s) => assert.equal(s.furniture, 8),
  );

  await step(
    '壁の角をドラッグすると接続した壁が追従する',
    async () => {
      await page.keyboard.press('v');
      const from = await at(14000, 3000);
      const to = await at(15500, 4000);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 12 });
      await page.mouse.up();
    },
    (s) => {
      assert.equal(s.selection, 1);
      const room = s.rooms.find((r) => r.name === '書斎');
      assert.ok(room.area > 12, `面積が広がるはず: ${room.area}`);
    },
  );

  await step(
    'undo で元に戻る',
    () => page.keyboard.press('Meta+z'),
    (s) => assert.equal(s.rooms.find((r) => r.name === '書斎').area, 12),
  );

  await step(
    '計測ツールの状態表示が追従する',
    async () => {
      await page.keyboard.press('m');
      await clickWorld(10000, 0);
      await moveWorld(14000, 3000);
    },
    (s) => {
      assert.equal(s.tool, 'measure');
      assert.match(s.status, /終点/);
    },
  );

  // --- 汎用図形 ---

  await step(
    '線を引ける',
    async () => {
      await page.keyboard.press('l');
      await clickWorld(10000, 4500);
      await clickWorld(14000, 4500);
    },
    (s) => {
      assert.equal(s.tool, 'line');
      assert.equal(s.shapes, 1);
    },
  );

  await step(
    '連続モードでポリラインになる',
    async () => {
      await page.getByText('連続して引く').click();
      await clickWorld(10000, 5500);
      await clickWorld(12000, 5500);
      await clickWorld(12000, 6500);
      await page.keyboard.press('Enter');
    },
    (s) => assert.equal(s.shapes, 2),
  );

  await step(
    '円を描ける',
    async () => {
      await page.keyboard.press('c');
      await clickWorld(13000, 6000);
      await clickWorld(13600, 6000);
    },
    (s) => {
      assert.equal(s.tool, 'arc');
      assert.equal(s.shapes, 3);
    },
  );

  await step(
    '円弧を描ける',
    async () => {
      await page.selectOption('.options-bar select', 'arc');
      await clickWorld(9000, 6000);
      await clickWorld(9600, 6000);
      await clickWorld(9000, 6600);
    },
    (s) => assert.equal(s.shapes, 4),
  );

  await step(
    '文字を置ける',
    async () => {
      await page.keyboard.press('t');
      await page.fill('.options-bar input[type=text]', '駐車スペース');
      await clickWorld(12000, 7000);
    },
    (s) => assert.equal(s.shapes, 5),
  );

  await step(
    '図形を選んで削除できる',
    async () => {
      await page.keyboard.press('v');
      await clickWorld(12000, 4500);
      assert.equal((await state()).selection, 1, '線を選択できていない');
      await page.keyboard.press('Delete');
    },
    (s) => assert.equal(s.shapes, 4),
  );

  await step(
    'undo で図形が戻る',
    () => page.keyboard.press('Meta+z'),
    (s) => assert.equal(s.shapes, 5),
  );

  // --- 複写・回転・鏡像 ---

  await step(
    '範囲選択した壁を複写できる',
    async () => {
      await page.keyboard.press('v');
      // 書斎を窓選択（左→右なので完全に含むものだけ）
      const from = await at(9400, -600);
      const to = await at(14600, 3400);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 10 });
      await page.mouse.up();
      assert.ok((await state()).selection >= 4, '書斎の壁を選択できていない');

      await page.keyboard.press('y');
      await clickWorld(10000, 0);
      await clickWorld(10000, 3500);
    },
    (s) => {
      assert.equal(s.walls, 18, '壁が4本増えるはず');
      assert.equal(s.furniture, 9, '範囲内の家具も複製されるはず');
      assert.equal(s.rooms.length, 5, '閉じた部屋が1つ増えるはず');
      // 壁4 + 家具1 + 室名1。建具は壁に乗って複製されるので選択には入らない
      assert.equal(s.selection, 6, '複製側が選択されているはず');
      assert.equal(s.rooms.filter((r) => r.name === '書斎').length, 2, '室名も複製されるはず');
    },
  );

  await step(
    '複写を undo で戻せる',
    () => page.keyboard.press('Meta+z'),
    (s) => {
      assert.equal(s.walls, 14);
      assert.equal(s.rooms.length, 4);
    },
  );

  await step(
    '角度を打ち込んで回転できる',
    async () => {
      await page.keyboard.press('Meta+Shift+z'); // 複写をやり直す
      assert.equal((await state()).walls, 18, '前提: 複写が戻っている');
      await page.keyboard.press('v');
      const from = await at(9400, 3400);
      const to = await at(14600, 6900);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 10 });
      await page.mouse.up();

      await page.keyboard.press('r');
      await clickWorld(12000, 5000);
      await clickWorld(14000, 5000);
      assert.ok((await state()).numericVisible, '角度の入力欄が出ていない');
      await page.fill('#numeric-input', '90');
      await page.keyboard.press('Enter');
    },
    (s) => {
      assert.equal(s.tool, 'rotate');
      assert.equal(s.walls, 18, '回転では本数が変わらないはず');
      assert.equal(s.rooms.length, 5, '回転しても部屋は保たれるはず');
    },
  );

  await step(
    '元を残して鏡像できる',
    async () => {
      await page.keyboard.press('x');
      await page.getByText('元を残す').click();
      await clickWorld(2000, 7000);
      await clickWorld(6000, 7000);
    },
    (s) => {
      assert.equal(s.tool, 'mirror');
      assert.equal(s.walls, 22, '鏡像で4本増えるはず');
    },
  );

  await step(
    '画層パネルが全画層を出している',
    async () => {},
    (s) => assert.equal(s.layerRows, 8, '既定の画層は8つ'),
  );

  await step(
    '線群を替えると画層の線幅表示が変わる',
    async () => {
      const before = await page.locator('.layer-row .layer-mm').first().textContent();
      await selectByLabel('線群 (JIS Z 8312)', '線群 1.4 (0.35 / 0.7 / 1.4)');
      const after = await page.locator('.layer-row .layer-mm').first().textContent();
      assert.notEqual(before, after, `線幅表示が変わらない (${before} -> ${after})`);
      assert.equal(after.trim(), '0.70mm', '線群1.4の太線は0.70mm');
    },
    (s) => assert.equal(s.standard.lineGroupId, '1.4'),
  );

  await step(
    '尺度を替えられる',
    () => selectByLabel('尺度 (JIS Z 8314)', '1:50'),
    (s) => assert.equal(s.standard.scale, 50),
  );

  await step(
    '壁を輪郭線表示に切り替えても描画が落ちない',
    () => page.getByText('壁を塗りつぶす').click(),
    (s) => assert.equal(s.standard.wallFill, false),
  );

  await step(
    '画層を非表示にできる',
    async () => {
      await page.locator('.layer-row').first().locator('.layer-visible').uncheck();
    },
    (s) => assert.equal(s.wallLayerVisible, false),
  );

  await step(
    '画層の表示を戻す',
    async () => {
      await page.locator('.layer-row').first().locator('.layer-visible').check();
    },
    (s) => assert.equal(s.wallLayerVisible, true),
  );

  await step(
    '画層をロックすると壁を選択できなくなる',
    async () => {
      await page.keyboard.press('v');
      await clickWorld(500, 0);
      assert.ok((await state()).selection > 0, '前提: ロック前は壁を選択できる');
      await page.keyboard.press('Escape');
      await page.locator('.layer-row').first().locator('.layer-locked').check();
      await clickWorld(500, 0);
    },
    (s) => {
      assert.equal(s.wallLayerLocked, true);
      assert.equal(s.selection, 0, 'ロック中の壁が選択できてしまう');
    },
  );

  await step(
    'ロックを解除すると選択できる',
    async () => {
      await page.locator('.layer-row').first().locator('.layer-locked').uncheck();
      await clickWorld(500, 0);
    },
    (s) => {
      assert.equal(s.wallLayerLocked, false);
      assert.equal(s.selection, 1);
    },
  );

  for (const [label, filename] of [
    ['SVG で書き出す', 'madori.svg'],
    ['DXF (R12) で書き出す — 他の CAD で開けます', 'madori.dxf'],
  ]) {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      page.click(`button[title="${label}"]`),
    ]);
    assert.equal(download.suggestedFilename(), filename);
    console.log(`✔ ${filename} が書き出せる`);
  }

  // 書き出した SVG を本物の XML パーサに通す
  const [svgDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click('button[title="SVG で書き出す"]'),
  ]);
  const svg = await readFile(await svgDownload.path(), 'utf8');
  const svgError = await page.evaluate((source) => {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    const err = doc.querySelector('parsererror');
    return err ? err.textContent.slice(0, 200) : null;
  }, svg);
  assert.equal(svgError, null, `SVG が XML として壊れている: ${svgError}`);
  console.log('✔ 書き出した SVG が XML として妥当');

  // 書き出した DXF の中身まで確認する
  const [dxfDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click('button[title="DXF (R12) で書き出す — 他の CAD で開けます"]'),
  ]);
  const dxfPath = await dxfDownload.path();
  const dxf = await readFile(dxfPath, 'utf8');
  assert.ok(dxf.startsWith('0\r\nSECTION'), 'DXF の先頭が SECTION でない');
  assert.ok(dxf.trimEnd().endsWith('EOF'), 'DXF が EOF で終わっていない');
  assert.ok(dxf.includes('AC1009'), 'バージョン指定がない');
  assert.ok(dxf.includes('A-WALL'), '壁の画層がない');
  assert.ok(dxf.includes('書斎'), '画面で付けた室名が DXF に入っていない');
  console.log('✔ 書き出した DXF の中身が妥当');
}

/** インスペクタのラベルからその行の select を引いて選ぶ */
async function selectByLabel(labelText, optionLabel) {
  const field = page.locator('.field').filter({ hasText: labelText }).first();
  await field.locator('select').selectOption({ label: optionLabel });
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {
      // まだ起動していない
    }
    await sleep(250);
  }
  throw new Error('dev サーバが起動しませんでした');
}
