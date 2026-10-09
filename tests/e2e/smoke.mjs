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
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
        instances: Object.keys(s.instances).length,
        blocks: Object.keys(s.blocks).length,
        blockLabels: Object.values(s.blocks).map((b) => b.label),
        shapes: Object.keys(s.shapes).length,
        // 寸法を除いた作図図形。サンプルが寸法を持つので、数を見るときはこちら
        drawings: Object.values(s.shapes).filter((sh) => sh.shape !== 'dimension').length,
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
        layerNames: Object.values(s.layers).map((l) => l.name),
        currentLayerId: ed.store.settings.currentLayerId,
        sheetShown: s.sheet.show,
        sheetTitle: s.sheet.titleBlock.fields.drawingName,
        shapeLayers: Object.values(s.shapes).map((sh) => s.layers[sh.layerId]?.name),
        dimensions: Object.values(s.shapes).filter((sh) => sh.shape === 'dimension').length,
        dimensionValues: Object.values(s.shapes)
          .filter((sh) => sh.shape === 'dimension')
          .map((sh) => {
            const end = (e) => (e.nodeId && s.nodes[e.nodeId] ? s.nodes[e.nodeId] : e);
            const a = end(sh.a);
            const b = end(sh.b);
            return String(Math.round(Math.hypot(b.x - a.x, b.y - a.y)));
          }),
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
    assert.equal(s.dimensions, 10, '壁ぶんの寸法が入っているはず');
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
      // 壁ツールは作図前でも入力欄を出す（絶対座標で始点を打てるようにするため）
      assert.ok(s.numericVisible);
      const room = s.rooms.find((r) => r.name === null);
      assert.ok(room, '無名の部屋が増えているはず');
      // 4000 x 3000 の壁芯面積
      assert.equal(room.area, 12);
    },
  );

  await step(
    '絶対座標で壁の始点を打てる',
    async () => {
      await page.keyboard.press('w');
      assert.ok((await state()).numericVisible, '作図前でも入力欄が出るはず');
      await page.fill('#numeric-input', '1000,-3000');
      await page.keyboard.press('Enter');
      // 相対直交で終点を打つ
      await page.fill('#numeric-input', '@3000,0');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
    },
    (s) => assert.equal(s.walls, 15, '絶対座標と相対直交で壁が引けていない'),
  );

  await step(
    '解釈できない入力は弾かれる',
    async () => {
      await page.keyboard.press('w');
      await page.fill('#numeric-input', '<45');
      await page.keyboard.press('Enter');
    },
    async (s) => {
      assert.equal(s.walls, 15, '不正な入力で何か作られている');
      const invalid = await page.locator('#numeric-input').getAttribute('aria-invalid');
      assert.equal(invalid, 'true', '入力欄が不正と表示されていない');
    },
  );

  await step(
    '選択したものを数値で動かせる',
    async () => {
      await page.keyboard.press('Escape');
      await page.keyboard.press('v');
      await clickWorld(2500, -3000);
      assert.equal((await state()).selection, 1, '引いた壁を選択できていない');
      assert.ok((await state()).numericVisible, '選択中も入力欄が出るはず');
      await page.fill('#numeric-input', '@0,-500');
      await page.keyboard.press('Enter');
    },
    (s) => assert.equal(s.selection, 1),
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
    'ブロックを配置できる',
    async () => {
      await page.keyboard.press('b');
      await page.selectOption('.options-bar select', { index: 3 });
      await moveWorld(11500, 1500);
      await clickWorld(11500, 1500);
    },
    (s) => assert.equal(s.instances, 8),
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
      assert.equal(s.drawings, 1);
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
    (s) => assert.equal(s.drawings, 2),
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
      assert.equal(s.drawings, 3);
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
    (s) => assert.equal(s.drawings, 4),
  );

  await step(
    '文字を置ける',
    async () => {
      await page.keyboard.press('t');
      await page.fill('.options-bar input[type=text]', '駐車スペース');
      await clickWorld(12000, 7000);
    },
    (s) => assert.equal(s.drawings, 5),
  );

  await step(
    '図形を選んで削除できる',
    async () => {
      await page.keyboard.press('v');
      await clickWorld(12000, 4500);
      assert.equal((await state()).selection, 1, '線を選択できていない');
      await page.keyboard.press('Delete');
    },
    (s) => assert.equal(s.drawings, 4),
  );

  await step(
    'undo で図形が戻る',
    () => page.keyboard.press('Meta+z'),
    (s) => assert.equal(s.drawings, 5),
  );

  // --- 寸法 ---

  await step(
    '2点を指定して寸法を置ける',
    async () => {
      await page.keyboard.press('h');
      // 書斎の下辺。端点にスナップさせて壁の角に紐づける
      await clickWorld(10000, 0);
      await clickWorld(14000, 0);
      await clickWorld(12000, -800);
    },
    (s) => {
      assert.equal(s.tool, 'dimension');
      assert.equal(s.dimensions, 11, '寸法が増えていない');
    },
  );

  await step(
    '壁の角を動かすと寸法の値が追従する',
    async () => {
      await page.keyboard.press('v');
      const corner = await at(14000, 0);
      const target = await at(15000, 0);
      await page.mouse.move(corner.x, corner.y);
      await page.mouse.down();
      await page.mouse.move(target.x, target.y, { steps: 10 });
      await page.mouse.up();
    },
    (s) => {
      // ドラッグ先はスナップで丸められるので、厳密な値ではなく追従したことを見る
      // （サンプルの壁に 4600 が2本あるので、それとは重ならない範囲で判定する）
      const grown = s.dimensionValues.map(Number).filter((v) => v > 4700 && v < 5300);
      assert.equal(grown.length, 1, `寸法が追従していない: ${s.dimensionValues}`);
      assert.ok(!s.dimensionValues.includes('4000'), '元の値が残っている');
    },
  );

  await step(
    '寸法を undo で戻す',
    async () => {
      await page.keyboard.press('Meta+z');
      await page.keyboard.press('Meta+z');
    },
    (s) => assert.equal(s.dimensions, 10),
  );

  // --- 複写・回転・鏡像 ---

  let wallsBeforeCopy = 0;
  await step(
    '範囲選択した壁を複写できる',
    async () => {
      wallsBeforeCopy = (await state()).walls;
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
      assert.equal(s.walls, wallsBeforeCopy + 4, '壁が4本増えるはず');
      assert.equal(s.instances, 9, '範囲内のブロックも複製されるはず');
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
      assert.equal(s.walls, wallsBeforeCopy);
      assert.equal(s.rooms.length, 4);
    },
  );

  await step(
    '角度を打ち込んで回転できる',
    async () => {
      await page.keyboard.press('Meta+Shift+z'); // 複写をやり直す
      assert.equal((await state()).walls, wallsBeforeCopy + 4, '前提: 複写が戻っている');
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
      assert.equal(s.walls, wallsBeforeCopy + 4, '回転では本数が変わらないはず');
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
      assert.equal(s.walls, wallsBeforeCopy + 8, '鏡像で4本増えるはず');
    },
  );

  await step(
    '画層パネルが全画層を出している',
    async () => {},
    (s) => assert.equal(s.layerRows, 9, '既定の画層は9つ'),
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

  // --- オフセット・トリム・延長 ---

  const drawingsBeforeModify = (await state()).drawings;
  await step(
    '線をオフセットできる',
    async () => {
      // この手順で使う範囲を画面に入れる
      await page.evaluate(() => {
        const ed = window.minicad.editorInstance;
        ed.viewport.fit({ min: { x: -2000, y: -4000 }, max: { x: 18000, y: 12000 } });
        ed.requestRender();
      });
      // 交差する2本を空いているところに引く
      await page.locator('#canvas').focus();
      await page.keyboard.press('l');
      await clickWorld(2000, 9000);
      await clickWorld(8000, 9000);
      await page.keyboard.press('Enter');
      await clickWorld(5000, 7000);
      await clickWorld(5000, 11000);
      await page.keyboard.press('Enter');

      await page.keyboard.press('o');
      await page.fill('#numeric-input', '800');
      await page.keyboard.press('Enter');
      await clickWorld(3000, 9400);
    },
    (s) => {
      assert.equal(s.tool, 'offset');
      assert.equal(s.drawings, drawingsBeforeModify + 3, 'オフセットで1本増えるはず');
    },
  );

  await step(
    'トリムで交点から先を落とせる',
    async () => {
      await page.keyboard.press('u');
      await clickWorld(3000, 9000);
    },
    (s) => {
      assert.equal(s.tool, 'trim');
      // 元の1本が切られて1本になる（左側が消える）ので総数は変わらない
      assert.equal(s.drawings, drawingsBeforeModify + 3, 'トリムで本数が合わない');
    },
  );

  await step(
    '延長で境界まで伸ばせる',
    async () => {
      await page.keyboard.press('e');
      await clickWorld(7500, 9800);
    },
    (s) => assert.equal(s.tool, 'extend'),
  );

  await step('オフセットを undo で戻せる', () => page.keyboard.press('Meta+z'), () => {});

  // --- ブロック ---

  const instancesBeforeBlock = (await state()).instances;
  const blocksBeforeBlock = (await state()).blocks;
  await step(
    '選んだ図形をブロックにできる',
    async () => {
      await page.keyboard.press('v');
      await clickWorld(5000, 9000);
      assert.ok((await state()).selection >= 1, '図形を選択できていない');
      await page.getByText('ブロックにする').click();
    },
    (s) => {
      assert.equal(s.instances, instancesBeforeBlock + 1, 'ブロックの挿入が増えていない');
      assert.equal(s.blocks, blocksBeforeBlock + 1, 'ブロック定義が増えていない');
    },
  );

  await step(
    'ブロックの名前を変えられる',
    async () => {
      const field = page.locator('.field').filter({ hasText: 'ブロック名' }).first();
      await field.locator('input').fill('方位記号');
      await field.locator('input').press('Enter');
    },
    (s) => assert.ok(s.blockLabels.includes('方位記号'), `改名できていない: ${s.blockLabels}`),
  );

  await step(
    'ブロックを分解すると図形に戻る',
    async () => {
      await page.getByText('分解する').click();
    },
    (s) => assert.equal(s.instances, instancesBeforeBlock, 'インスタンスが残っている'),
  );

  await step('ブロック化を undo で戻せる', () => page.keyboard.press('Meta+z'), () => {});

  // --- 用紙枠と表題欄 ---

  await step(
    '用紙枠を表示できる',
    async () => {
      await page.getByText('用紙枠を表示').click();
    },
    (s) => assert.equal(s.sheetShown, true),
  );

  await step(
    '表題欄の図面名称を変えられる',
    async () => {
      const field = page.locator('.field').filter({ hasText: '図面名称' }).first();
      await field.locator('input').fill('テスト住宅 1階平面図');
      await field.locator('input').press('Enter');
    },
    (s) => assert.equal(s.sheetTitle, 'テスト住宅 1階平面図'),
  );

  await step('用紙に合わせて表示できる', () => page.click('button[title="用紙全体が見えるように表示"]'), () => {});

  // --- 画層の管理 ---

  await step(
    '画層を追加できる',
    () => page.getByText('＋ 画層を追加').click(),
    (s) => {
      assert.equal(s.layerRows, 10);
      assert.ok(s.layerNames.includes('A-USER'), `追加した画層が見当たらない: ${s.layerNames}`);
    },
  );

  await step(
    '画層を改名できる',
    async () => {
      const row = page.locator('.layer-row').last();
      await row.locator('input.layer-name').fill('A-SITE');
      await row.locator('input.layer-name').press('Enter');
    },
    (s) => assert.ok(s.layerNames.includes('A-SITE'), `改名できていない: ${s.layerNames}`),
  );

  await step(
    '既存と同じ名前には改名できない',
    async () => {
      const row = page.locator('.layer-row').last();
      await row.locator('input.layer-name').fill('A-WALL');
      await row.locator('input.layer-name').press('Enter');
    },
    (s) => {
      assert.ok(s.layerNames.includes('A-SITE'), '重複する名前を受け付けてしまった');
      assert.equal(s.layerNames.filter((n) => n === 'A-WALL').length, 1);
    },
  );

  await step(
    '新規作成の画層を指定できる',
    () => selectByLabel('新規作成の画層', 'A-SITE'),
    (s) => assert.ok(s.currentLayerId, '現在の画層が設定されていない'),
  );

  let shapesBefore = 0;
  await step(
    '指定した画層に新しい線が乗る',
    async () => {
      shapesBefore = (await state()).drawings;
      await page.keyboard.press('l');
      await clickWorld(2000, -2000);
      await clickWorld(6000, -2000);
      // 連続モードは前の手順で ON のままなので、Enter で確定する
      await page.keyboard.press('Enter');
    },
    (s) => {
      assert.equal(s.drawings, shapesBefore + 1);
      assert.ok(s.shapeLayers.includes('A-SITE'), `指定した画層に乗っていない: ${s.shapeLayers}`);
    },
  );

  await step(
    '選択したものの画層を変えられる',
    async () => {
      await page.keyboard.press('v');
      await clickWorld(4000, -2000);
      assert.equal((await state()).selection, 1, '線を選択できていない');
      await selectByLabel('画層', 'A-GRID');
    },
    (s) => assert.equal(s.selection, 1),
  );

  await step(
    '画層を削除すると中身は既定の画層へ移る',
    async () => {
      await page.keyboard.press('Escape');
      const row = page.locator('.layer-row').last();
      await row.locator('.layer-delete').click();
    },
    (s) => {
      assert.equal(s.layerRows, 9);
      assert.ok(!s.layerNames.includes('A-SITE'));
      assert.equal(s.drawings, shapesBefore + 1, '画層を消したのに図形まで消えている');
      assert.ok(!s.shapeLayers.includes('A-SITE'), '消した画層が残っている');
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
  assert.ok(svg.includes('width="420mm"'), '用紙枠を出したのに SVG が用紙の実寸でない');
  assert.ok(svg.includes('テスト住宅 1階平面図'), '表題欄が SVG に出ていない');
  console.log('✔ 書き出した SVG が用紙の実寸で、表題欄を含む');

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

  // 書き出した DXF をそのまま読み戻す（書き出しと読み込みが噛み合っているかの通し確認）
  const before = await state();
  // ダウンロードの実体には拡張子が付かないので、.dxf の名前で置き直してから読ませる
  const reimportPath = join(tmpdir(), 'minicad-e2e-reimport.dxf');
  await writeFile(reimportPath, dxf, 'utf8');
  await page.setInputFiles('input[type=file]', reimportPath);
  await page.waitForSelector('.dialog');
  const summary = await page.locator('.dialog-text').first().textContent();
  assert.ok(/LINE \d+/.test(summary), `取り込み前の内訳が出ていない: ${summary}`);
  await page.click('.dialog-actions button.primary');
  await page.waitForSelector('.dialog h2:text("DXF を読み込みました")');
  const report = await page.locator('.dialog-text').first().textContent();
  assert.ok(report.includes('既存の画層を使用'), `画層が再利用されていない: ${report}`);
  assert.ok(!report.includes('画層を追加'), `画層が増えている: ${report}`);
  await page.click('.dialog-actions button.primary');

  const after = await state();
  assert.ok(after.drawings > before.drawings, 'DXF を読み込んでも図形が増えていない');
  assert.equal(after.layerRows, before.layerRows, '読み込みで画層が増えた');
  assert.equal(after.blocks, before.blocks, '読み込みでブロック定義が増殖した');
  assert.ok(after.instances > before.instances, '家具がブロック挿入として戻っていない');
  console.log('✔ 書き出した DXF をそのまま読み戻せる');

  // 取り込み全体が 1 回の undo で取り消せる
  await page.keyboard.press('Control+z');
  await sleep(150);
  const undone = await state();
  assert.equal(undone.drawings, before.drawings, '取り込みが1回の undo で戻らない');
  console.log('✔ 取り込みを undo 1回で取り消せる');
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
