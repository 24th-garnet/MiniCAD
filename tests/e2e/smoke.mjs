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
  const mode = (label) =>
    page.locator('.mode-switch button').filter({ hasText: label }).first().click();

  const state = () =>
    page.evaluate(() => {
      const ed = window.minicad.editorInstance;
      const s = ed.store.scene;
      return {
        tool: ed.activeToolId,
        walls: Object.keys(s.walls).length,
        openings: Object.keys(s.openings).length,
        instances: Object.keys(s.instances).length,
        fixtures: Object.keys(s.fixtures).length,
        fixtureKinds: Object.values(s.fixtures).map((f) => f.kind),
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
        view3d: !document.getElementById('canvas3d').hidden,
        viewMode: window.minicad.view.mode,
        mode: window.minicad.mode,
        toolbar: [...document.querySelectorAll('.tool-button')].map((b) => b.dataset.tool),
        inspectorHeads: [...document.querySelectorAll('#inspector h2')].map((h) => h.textContent),
        split: document.querySelector('.canvas-wrap').classList.contains('split'),
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

  // --- 編集モード ---
  // **既定は通常モード。** ワイヤーが 2 度明記している
  const normal = await state();
  assert.equal(normal.mode, 'normal', '既定が通常モードではない');
  for (const hidden of ['offset', 'trim', 'extend', 'point']) {
    assert.ok(!normal.toolbar.includes(hidden), `通常モードに ${hidden} が出ている`);
  }
  for (const shown of ['select', 'wall', 'door', 'window', 'block', 'room']) {
    assert.ok(normal.toolbar.includes(shown), `通常モードに ${shown} が無い`);
  }
  assert.ok(!normal.inspectorHeads.some((h) => h.includes('幾何拘束') || h.includes('製図規格')),
    `通常モードに CAD 寄りの区画が出ている: ${normal.inspectorHeads}`);

  // 隠したツールはショートカットでも選べない。登録から外しているので
  await page.keyboard.press('u');
  await sleep(150);
  assert.equal((await state()).tool, 'select', '隠したツールがショートカットで選べる');

  await mode('プロモード');
  await sleep(250);
  const pro = await state();
  assert.equal(pro.mode, 'pro');
  for (const shown of ['offset', 'trim', 'extend', 'point']) {
    assert.ok(pro.toolbar.includes(shown), `プロモードに ${shown} が無い`);
  }
  for (const id of normal.toolbar) {
    assert.ok(pro.toolbar.includes(id), `${id} が通常にだけある`);
  }
  assert.ok(pro.inspectorHeads.includes('まだ無いもの'),
    'プロモードに「まだ無いもの」が出ていない');
  console.log('✔ 既定は通常モード、プロモードで CAD 寄りの道具が増える');

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
  assert.ok(dxf.includes('DIMSTYLE'), '寸法スタイルがない');
  assert.ok(/\r\nDIMENSION\r\n/.test(dxf), '寸法が DIMENSION エンティティで出ていない');
  console.log('✔ 書き出した DXF の中身が妥当');

  // 書き出した DXF をそのまま読み戻す（書き出しと読み込みが噛み合っているかの通し確認）
  const before = await state();
  // --- 今回足した書き出し -------------------------------------------------

  // 実測 JSON（数量拾いへ渡す）
  const [measuresDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click('button[title="実測 JSON を書き出す — 数量拾いへ渡します"]'),
  ]);
  const measures = JSON.parse(await readFile(await measuresDownload.path(), 'utf8'));
  assert.equal(measures.schema_version, 'mdr-measures-1', '契約の版が違う');
  assert.equal(measures.source, 'minicad');
  assert.ok(measures.rooms.length > 0, '部屋が 1 つも出ていない');
  for (const room of measures.rooms) {
    assert.ok(room.floor_area > 0, `床面積が 0: ${room.id}`);
    assert.ok(room.perimeter > 0, `周長が 0: ${room.id}`);
    assert.ok(room.wall_area > 0, `壁の面積が 0: ${room.id}`);
  }
  // 根拠は固定の語彙だけ
  const allowed = new Set(['実測', '推定', '代用', '既定', '外接', '未検出', '未計測']);
  for (const v of Object.values(measures.basis)) assert.ok(allowed.has(v), `知らない根拠: ${v}`);
  for (const r of measures.rooms) {
    for (const v of Object.values(r.basis)) assert.ok(allowed.has(v), `知らない根拠: ${v}`);
  }
  console.log('✔ 実測 JSON が書き出せて、根拠が固定の語彙で入る');

  // 立面図
  const [elevDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click('button[title="開口のある壁の立面を SVG で書き出す"]'),
  ]);
  const elev = await readFile(await elevDownload.path(), 'utf8');
  const elevError = await page.evaluate((source) => {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    const err = doc.querySelector('parsererror');
    return err ? err.textContent.slice(0, 200) : null;
  }, elev);
  assert.equal(elevError, null, `立面の SVG が XML として壊れている: ${elevError}`);
  assert.ok(elev.includes('class="opening"'), '開口が描かれていない');
  assert.ok(elev.includes('class="dim"'), '高さ方向の寸法が入っていない');
  assert.ok(elev.includes('未計測'), '持っていないものの但し書きが無い');
  console.log('✔ 立面図が書き出せて、高さ寸法と但し書きが入る');

  // Shift-JIS の DXF（Jw_cad 用）
  // 作図設定はインスペクタに常時出ている
  // checkboxField は input と label を兄弟に並べる
  const sjis = page.locator('.field.checkbox:has(label:text-is("DXFをShift-JISで書く (Jw_cad 用)")) input');
  assert.ok(await sjis.count(), 'Shift-JIS の設定が見つからない');
  {
    await sjis.check();
    const [sjisDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      page.click('button[title="DXF (R12) で書き出す — 他の CAD で開けます"]'),
    ]);
    const bytes = await readFile(await sjisDownload.path());
    const text = new TextDecoder('shift_jis').decode(bytes);
    assert.ok(text.includes('ANSI_932'), '文字コードの宣言が ANSI_932 でない');
    assert.ok(text.includes('書斎'), 'Shift-JIS で室名が化けた');
    // UTF-8 として読むと化けること（＝本当に Shift-JIS で書かれている）
    const asUtf8 = new TextDecoder('utf-8').decode(bytes);
    assert.ok(!asUtf8.includes('書斎'), 'UTF-8 のまま書かれている');
    await sjis.uncheck();
    console.log('✔ Shift-JIS の DXF で室名が化けない（Jw_cad の読み方で確認）');
  }

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

  // --- 幾何拘束 ---
  // 傾いた壁を1本足して選び、インスペクタから水平拘束を付ける
  const tilt = async () =>
    page.evaluate(async () => {
      const ed = window.minicad.editorInstance;
      const [ops, geom] = await Promise.all([import('/src/core/ops.ts'), import('/src/core/geometry.ts')]);
      let id = null;
      ed.store.commit(() => {
        const a = ops.findOrCreateNode(ed.store.scene, geom.vec(-6000, -6000));
        const b = ops.findOrCreateNode(ed.store.scene, geom.vec(-2000, -5000));
        id = ops.addWall(ed.store.scene, a, b, 120).id;
      });
      ed.store.setSelection([{ type: 'wall', id }]);
      return id;
    });

  const slope = async (id) =>
    page.evaluate((wallId) => {
      const s = window.minicad.editorInstance.store.scene;
      const w = s.walls[wallId];
      return w ? Math.abs(s.nodes[w.a].y - s.nodes[w.b].y) : null;
    }, id);

  const wallId = await tilt();
  await sleep(150);
  assert.ok((await slope(wallId)) > 500, '傾いた壁になっていない');

  const horizontal = page.locator('.constraint-buttons button', { hasText: '水平' });
  await horizontal.click();
  await sleep(200);
  assert.ok((await slope(wallId)) < 0.1, '水平拘束が効いていない');
  console.log('✔ 拘束を付けると壁が水平になる');

  // 矛盾する拘束は弾かれ、形も変わらない
  const beforeConflict = await slope(wallId);
  await page.locator('.constraint-buttons button', { hasText: '垂直' }).click();
  await sleep(200);
  const warn = await page.locator('.warn-note').first().textContent();
  assert.match(warn ?? '', /矛盾/, `矛盾が知らされていない: ${warn}`);
  assert.equal(await slope(wallId), beforeConflict, '弾かれたのに形が変わった');
  console.log('✔ 矛盾する拘束は弾かれ、形も元のまま');

  // undo 1回で拘束ごと戻る
  await page.keyboard.press('Control+z');
  await sleep(200);
  assert.ok((await slope(wallId)) > 500, '拘束の追加が undo で戻らない');
  console.log('✔ 拘束の追加を undo 1回で取り消せる');

  // --- 構造 ---
  const beforeFixture = await state();
  await page.locator('.part-button[data-fixture="column"]').click();
  await sleep(250);
  assert.equal((await state()).tool, 'fixture', '構造ツールに移っていない');

  await clickWorld(2000, 2000);
  await sleep(250);
  const withColumn = await state();
  assert.equal(withColumn.fixtures, beforeFixture.fixtures + 1, '柱が置けない');
  assert.deepEqual(withColumn.fixtureKinds, ['column']);

  // 既定の高さは階高に落ちている（上書きしていない）
  const col = await page.evaluate(() => {
    const s = window.minicad.editorInstance.store.scene;
    const f = Object.values(s.fixtures)[0];
    return { base: f.base, height: f.height, w: f.size.w, levelId: f.levelId };
  });
  assert.equal(col.base, null, '下端が既定になっていない');
  assert.equal(col.height, null, '高さが既定になっていない');
  assert.equal(col.levelId, 'lv-1');

  // 梁も置ける。天井から下がるので下端が 0 ではない
  await page.locator('.part-button[data-fixture="beam"]').click();
  await sleep(200);
  await clickWorld(2000, 4000);
  await sleep(250);
  assert.equal((await state()).fixtures, beforeFixture.fixtures + 2, '梁が置けない');

  // 3D に立つ。柱と梁は躯体なので壁の層に出る
  const solids = await page.evaluate(() => {
    const app = window.minicad;
    const scene = app.editorInstance.store.scene;
    const mine = app.viewer.meshNow().filter((f) => f.ref && f.ref.type === 'fixture');
    return {
      count: mine.length,
      buckets: [...new Set(mine.map((f) => f.bucket))],
      maxZ: Math.max(...mine.map((f) => Math.max(...f.points.map((p) => p.z)))),
      wallHeight: scene.levels[scene.activeLevelId].wallHeight,
    };
  });
  assert.ok(solids.count > 0, '構造が 3D に出ていない');
  assert.deepEqual(solids.buckets, ['wall'], `層が違う: ${solids.buckets}`);
  assert.ok(Math.abs(solids.maxZ - solids.wallHeight) < 1, '柱が階高まで立っていない');

  // undo 2 回でどちらも消える
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await sleep(250);
  assert.equal((await state()).fixtures, beforeFixture.fixtures, 'undo で戻らない');
  console.log('✔ 柱と梁を置けて、3D にも立つ');

  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  await sleep(150);

  // --- 3D ---
  const before3d = await state();
  await page.keyboard.press('F3');
  await sleep(400);
  const shown = await state();
  assert.equal(shown.view3d, true, '3D に切り替わっていない');
  assert.equal(shown.walls, before3d.walls, '切り替えでシーンが変わった');
  assert.deepEqual(shown.rooms, before3d.rooms, '切り替えで部屋が変わった');
  console.log('✔ 3D に切り替えてもシーンは変わらない');

  // カメラを動かしても副作用が無い。
  // **空から掴む。** 図面の上から掴むと、回転ではなくその実体の移動になり、
  // 「カメラ操作に副作用がない」を見ているつもりで別のことを見てしまう
  const canvas3d = await page.locator('#canvas3d').boundingBox();
  const mid = { x: canvas3d.x + canvas3d.width / 2, y: canvas3d.y + canvas3d.height / 2 };
  const sky = { x: canvas3d.x + 20, y: canvas3d.y + 20 };
  assert.equal(await page.evaluate(
    ([x, y]) => window.minicad.viewer.hitAt(x, y),
    [20, 20],
  ), null, '空のつもりの点に何か写っている');
  await page.mouse.move(sky.x, sky.y);
  await page.mouse.down();
  await page.mouse.move(sky.x + 120, sky.y - 60, { steps: 6 });
  await page.mouse.up();
  await page.mouse.wheel(0, -240);
  await sleep(300);
  await page.click('.view-tabs button[title="平行投影に切り替える"]');
  await sleep(300);
  await page.keyboard.press('F3');
  await sleep(300);

  const back = await state();
  assert.equal(back.view3d, false, '2D に戻っていない');
  assert.equal(back.walls, before3d.walls, 'カメラ操作でシーンが変わった');
  assert.equal(back.selection, before3d.selection, 'カメラ操作で選択が変わった');
  assert.deepEqual(back.rooms, before3d.rooms);
  console.log('✔ 3D のカメラ操作に副作用がない');

  // --- 3D でクリックして選ぶ ---
  await page.keyboard.press('F3');
  await sleep(400);

  // 画面の中央付近を少しずつずらしながら、何かに当たるまで叩く。
  // ドラッグにならないよう、押して動かさずに離す
  let picked = null;
  for (const [dx, dy] of [[0, 40], [60, 40], [-60, 40], [0, 100], [120, 0], [-120, 0]]) {
    await page.mouse.click(mid.x + dx, mid.y + dy);
    await sleep(200);
    const st = await state();
    if (st.selection > 0) { picked = st; break; }
  }
  assert.ok(picked, '3D でクリックしても何も選べない');
  assert.equal(picked.walls, before3d.walls, '3D のクリックでシーンが変わった');
  console.log('✔ 3D でクリックして選べる');

  // 2D に戻しても同じものが選ばれたまま＝同じモデルを指している
  await page.keyboard.press('F3');
  await sleep(300);
  const in2d = await state();
  assert.equal(in2d.view3d, false);
  assert.equal(in2d.selection, picked.selection, '2D に戻ると選択が消える');
  console.log('✔ 3D で選んだものが 2D でも選ばれている');

  // 空（床）を叩くと選択が解ける
  await page.keyboard.press('F3');
  await sleep(300);
  await page.mouse.click(canvas3d.x + 20, canvas3d.y + 20);
  await sleep(250);
  assert.equal((await state()).selection, 0, '空を叩いても選択が残る');
  await page.keyboard.press('F3');
  await sleep(300);
  console.log('✔ 3D で空を叩くと選択が解ける');

  // --- 3D でドラッグして動かす ---
  await page.keyboard.press('F3');
  await sleep(400);

  // 何かを掴めるところを探す
  let grabbed = null;
  for (const [dx, dy] of [[0, 40], [60, 40], [-60, 40], [0, 100], [120, 0], [-120, 0]]) {
    await page.mouse.click(mid.x + dx, mid.y + dy);
    await sleep(180);
    if ((await state()).selection > 0) { grabbed = { x: mid.x + dx, y: mid.y + dy }; break; }
  }
  assert.ok(grabbed, '3D で掴めるものが見つからない');

  const beforeDrag = await page.evaluate(() => {
    const ed = window.minicad.editorInstance;
    const s = ed.store.scene;
    return {
      nodes: Object.values(s.nodes).map((n) => `${n.x.toFixed(1)},${n.y.toFixed(1)}`).join('|'),
      insts: Object.values(s.instances).map((i) => `${i.x.toFixed(1)},${i.y.toFixed(1)}`).join('|'),
      openings: Object.values(s.openings).map((o) => o.offset.toFixed(1)).join('|'),
    };
  });

  await page.mouse.move(grabbed.x, grabbed.y);
  await page.mouse.down();
  await page.mouse.move(grabbed.x + 90, grabbed.y + 50, { steps: 8 });
  await page.mouse.up();
  await sleep(300);

  const afterDrag = await page.evaluate(() => {
    const s = window.minicad.editorInstance.store.scene;
    return {
      nodes: Object.values(s.nodes).map((n) => `${n.x.toFixed(1)},${n.y.toFixed(1)}`).join('|'),
      insts: Object.values(s.instances).map((i) => `${i.x.toFixed(1)},${i.y.toFixed(1)}`).join('|'),
      openings: Object.values(s.openings).map((o) => o.offset.toFixed(1)).join('|'),
    };
  });
  const changed =
    afterDrag.nodes !== beforeDrag.nodes ||
    afterDrag.insts !== beforeDrag.insts ||
    afterDrag.openings !== beforeDrag.openings;
  assert.ok(changed, '3D でドラッグしても何も動かない');
  console.log('✔ 3D のドラッグで動かせる');

  // 2D に戻して、動いた結果が見えていること
  await page.keyboard.press('F3');
  await sleep(300);
  const in2dAfter = await page.evaluate(() => {
    const s = window.minicad.editorInstance.store.scene;
    return Object.values(s.nodes).map((n) => `${n.x.toFixed(1)},${n.y.toFixed(1)}`).join('|')
      + '/' + Object.values(s.instances).map((i) => `${i.x.toFixed(1)},${i.y.toFixed(1)}`).join('|');
  });
  assert.equal(in2dAfter, `${afterDrag.nodes}/${afterDrag.insts}`, '2D と 3D でモデルが食い違う');
  console.log('✔ 3D で動かした結果が 2D に出ている');

  // undo 1 回で戻る＝ commitFrom を 1 回だけ通っている
  await page.keyboard.press('Control+z');
  await sleep(300);
  const afterUndo = await page.evaluate(() => {
    const s = window.minicad.editorInstance.store.scene;
    return {
      nodes: Object.values(s.nodes).map((n) => `${n.x.toFixed(1)},${n.y.toFixed(1)}`).join('|'),
      insts: Object.values(s.instances).map((i) => `${i.x.toFixed(1)},${i.y.toFixed(1)}`).join('|'),
      openings: Object.values(s.openings).map((o) => o.offset.toFixed(1)).join('|'),
    };
  });
  assert.deepEqual(afterUndo, beforeDrag, '3D のドラッグが undo 1 回で戻らない');
  console.log('✔ 3D のドラッグを undo 1回で取り消せる');

  // --- 3D で壁の高さを変える ---
  await page.keyboard.press('F3');
  await sleep(400);

  // 壁の天端を画面上で探す。レイを飛ばして当たるところを見つける
  const topSpot = await page.evaluate(() => {
    const v = window.minicad.viewer;
    const ed = window.minicad.editorInstance;
    const rect = document.querySelector('#canvas3d').getBoundingClientRect();
    for (let y = 20; y < rect.height - 20; y += 6) {
      for (let x = 20; x < rect.width - 20; x += 6) {
        const hit = v.hitAt(x, y);
        if (hit && hit.kind === 'wallTop') {
          return { x: rect.left + x, y: rect.top + y, wallId: hit.id, height: hit.height };
        }
      }
    }
    void ed;
    return null;
  });
  assert.ok(topSpot, '壁の天端が画面に出ていない');

  // 直前に undo を通しているので、平面の基準はここで取り直す
  const planeBefore = await page.evaluate(() =>
    Object.values(window.minicad.editorInstance.store.scene.nodes)
      .map((n) => `${n.x.toFixed(1)},${n.y.toFixed(1)}`).join('|'));

  await page.mouse.move(topSpot.x, topSpot.y);
  await page.mouse.down();
  await page.mouse.move(topSpot.x, topSpot.y - 70, { steps: 8 });
  await page.mouse.up();
  await sleep(300);

  const heightAfter = await page.evaluate(
    (id) => window.minicad.editorInstance.store.scene.walls[id].height,
    topSpot.wallId,
  );
  assert.ok(heightAfter !== null && Math.abs(heightAfter - topSpot.height) > 1,
    `壁の高さが変わっていない (${topSpot.height} → ${heightAfter})`);
  console.log(`✔ 3D で壁の高さを変えられる (${topSpot.height} → ${heightAfter}mm)`);

  // 平面は動いていない＝ノードを触っていない
  const planeSame = await page.evaluate((before) => {
    const s = window.minicad.editorInstance.store.scene;
    return Object.values(s.nodes).map((n) => `${n.x.toFixed(1)},${n.y.toFixed(1)}`).join('|') === before;
  }, planeBefore);
  assert.ok(planeSame, '高さを変えたのに平面が動いた');
  console.log('✔ 高さを変えても平面は動かない');

  // 立面図の書き出しに出る
  await page.keyboard.press('F3');
  await sleep(300);
  const [elevAfter] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click('button[title="開口のある壁の立面を SVG で書き出す"]'),
  ]);
  const elevSvg = await readFile(await elevAfter.path(), 'utf8');
  assert.ok(elevSvg.includes('<svg'), '立面図が書き出せない');
  assert.ok(elevSvg.includes(String(Math.round(heightAfter))),
    `立面図に新しい高さ ${Math.round(heightAfter)} が出ていない`);
  console.log('✔ 高さの変更が立面図に出る');

  // --- 1 フレームの内訳を測って残す ---
  await page.keyboard.press('F3');
  await sleep(400);
  const perf = await page.evaluate(() => window.minicad.viewer.profile(120));
  const total = perf.rooms + perf.mesh + perf.paint;
  console.log(
    `  3D 1 フレーム: 部屋 ${perf.rooms}ms + メッシュ ${perf.mesh}ms + 描画 ${perf.paint}ms`
    + ` = ${total.toFixed(3)}ms  作り直し ${perf.stats}`,
  );
  // 余裕を持った上限。桁が変わるような回帰だけを捕まえる
  assert.ok(total < 16, `3D の 1 フレームが ${total.toFixed(3)}ms と遅い`);
  assert.ok(perf.mesh < perf.paint, 'メッシュの組み立てが描画より重い（キャッシュが効いていない）');
  await page.keyboard.press('F3');
  await sleep(300);
  console.log('✔ 3D の 1 フレームが予算に収まる');

  // --- 分割表示 ---
  const tab = (label) => page.locator('.view-tabs button').filter({ hasText: label }).first();

  await tab('分割').click();
  await sleep(500);
  const split = await state();
  assert.equal(split.viewMode, 'split');
  assert.equal(split.view3d, true, '分割なのに 3D が隠れている');
  assert.equal(split.split, true, '分割のクラスが当たっていない');

  // 2 枚が並んでいる。幅は CSS の 1fr 1fr だけで決まり、
  // どちらの ResizeObserver も自分で測り直している
  const layout = await page.evaluate(() => {
    const wrap = document.querySelector('.canvas-wrap').getBoundingClientRect();
    const c2 = document.getElementById('canvas').getBoundingClientRect();
    const c3 = document.getElementById('canvas3d').getBoundingClientRect();
    return {
      wrap: wrap.width,
      w2: c2.width, w3: c3.width,
      left2: c2.left, left3: c3.left,
      // キャンバスの画素数も付いてきているか（ResizeObserver が測り直した証拠）
      px2: document.getElementById('canvas').width,
      px3: document.getElementById('canvas3d').width,
      dpr: window.devicePixelRatio,
    };
  });
  assert.ok(Math.abs(layout.w2 - layout.wrap / 2) < 4,
    `2D が半分になっていない (${layout.w2} / ${layout.wrap})`);
  assert.ok(Math.abs(layout.w3 - layout.wrap / 2) < 4,
    `3D が半分になっていない (${layout.w3} / ${layout.wrap})`);
  assert.ok(layout.left3 > layout.left2, '3D が 2D の上に重なったまま');
  assert.ok(Math.abs(layout.px2 - layout.w2 * layout.dpr) < 4,
    `2D の画素数が幅に追従していない (${layout.px2} / ${layout.w2 * layout.dpr})`);
  assert.ok(Math.abs(layout.px3 - layout.w3 * layout.dpr) < 4,
    `3D の画素数が幅に追従していない (${layout.px3} / ${layout.w3 * layout.dpr})`);
  console.log('✔ 分割で 2D と 3D が半分ずつ並ぶ');

  // 分割中に 3D で動かすと、2D が同じ画面で追従する
  const movable = await page.evaluate(() => {
    const v = window.minicad.viewer;
    const rect = document.querySelector('#canvas3d').getBoundingClientRect();
    for (let y = 20; y < rect.height - 20; y += 6) {
      for (let x = 20; x < rect.width - 20; x += 6) {
        const hit = v.hitAt(x, y);
        if (hit && hit.kind === 'blockInstance') return { x: rect.left + x, y: rect.top + y, id: hit.id };
      }
    }
    return null;
  });
  assert.ok(movable, '分割の 3D に家具が出ていない');

  // 2D 側を全体表示にしておく。分割にすると幅が半分になって図面が切れ、
  // 動かした家具が画面の外だと「描き直されたか」を画素で見られない
  await page.evaluate(() => window.minicad.editorInstance.zoomToFit());
  await sleep(300);

  const plan = () => page.evaluate(() => document.getElementById('canvas').toDataURL());
  const planBefore = await plan();
  const posBefore = await page.evaluate(
    (id) => { const i = window.minicad.editorInstance.store.scene.instances[id]; return `${i.x},${i.y}`; },
    movable.id,
  );

  await page.mouse.move(movable.x, movable.y);
  await page.mouse.down();
  await page.mouse.move(movable.x + 70, movable.y + 40, { steps: 8 });
  await page.mouse.up();
  await sleep(400);

  const posAfter = await page.evaluate(
    (id) => { const i = window.minicad.editorInstance.store.scene.instances[id]; return `${i.x},${i.y}`; },
    movable.id,
  );
  assert.notEqual(posAfter, posBefore, '分割の 3D で動かせない');
  assert.notEqual(await plan(), planBefore, '3D で動かしたのに 2D が描き直されていない');
  assert.equal((await state()).viewMode, 'split', 'ドラッグでビューが変わった');
  console.log('✔ 分割中に 3D で動かすと 2D が追従する');

  await page.keyboard.press('Control+z');
  await sleep(300);

  // F3 は「3D を見ているか」で折り返す。分割からは 2D に戻る
  await page.keyboard.press('F3');
  await sleep(400);
  const afterF3 = await state();
  assert.equal(afterF3.viewMode, '2d', '分割から F3 で 2D に戻らない');
  assert.equal(afterF3.view3d, false, '2D なのに 3D が残っている');
  assert.equal(afterF3.split, false, '2D に戻ったのに分割のクラスが残っている');
  console.log('✔ 分割から F3 で 2D に戻る');

  // --- ホスト契約 ---
  const hostFile = await page.evaluate(() => window.minicadApi.getScene());
  assert.equal(hostFile.format, 'minicad', '書き出した形式が違う');
  assert.ok(hostFile.version >= 9, `版が古い (${hostFile.version})`);
  assert.ok(Object.keys(hostFile.scene.walls).length > 0, '壁が入っていない');

  const hostMeasures = await page.evaluate(() => window.minicadApi.getMeasures('plan-e2e'));
  assert.equal(hostMeasures.schema_version, 'mdr-measures-1', '実測の契約の版が違う');
  assert.equal(hostMeasures.plan_id, 'plan-e2e');
  assert.ok(hostMeasures.rooms.length > 0, '部屋が出ていない');
  console.log('✔ ホストが図面と実測を取り出せる');

  // 差し替えは deserialize を通る＝参照の整合性検査を通る
  const swapped = await page.evaluate((f) => {
    const copy = JSON.parse(JSON.stringify(f));
    for (const id of Object.keys(copy.scene.walls)) { delete copy.scene.walls[id]; break; }
    window.minicadApi.setScene(copy);
    return Object.keys(window.minicadApi.getScene().scene.walls).length;
  }, hostFile);
  assert.equal(swapped, Object.keys(hostFile.scene.walls).length - 1, '差し替えが効いていない');

  await page.evaluate((f) => window.minicadApi.setScene(f), hostFile);
  assert.equal((await state()).walls, Object.keys(hostFile.scene.walls).length, '戻せていない');
  console.log('✔ ホストが図面を差し替えられる');

  await page.evaluate(() => window.minicadApi.setMode('normal'));
  await sleep(250);
  assert.equal((await state()).mode, 'normal', 'ホストからモードを変えられない');
  assert.ok(!(await state()).toolbar.includes('trim'), 'モードが画面に効いていない');
  console.log('✔ ホストがモードを変えられる');

  // **片付け。** DOM を消すだけでは window の keydown も ResizeObserver も止まらない
  const torn = await page.evaluate(() => {
    const old = window.minicad;
    const before = old.editorInstance.store.sceneVersion;
    window.minicadApi.destroy();
    window.__old = { old, before };
    return {
      left: document.getElementById('app').childElementCount,
      canvases: document.querySelectorAll('canvas').length,
    };
  });
  assert.equal(torn.left, 0, '片付けたのに DOM が残っている');
  assert.equal(torn.canvases, 0, 'キャンバスが残っている');

  // 外したあとでキーを叩いても、もう誰も聞いていない
  await page.keyboard.press('Control+z');
  await page.keyboard.press('w');
  await sleep(200);
  const quiet = await page.evaluate(() => {
    const { old, before } = window.__old;
    return { after: old.editorInstance.store.sceneVersion, tool: old.editorInstance.activeToolId, before };
  });
  assert.equal(quiet.after, quiet.before, '片付けたのにキーマップが生きている');
  console.log('✔ 片付けると DOM も window の listener も残らない');

  // 同じ箱にもう一度組める
  const again = await page.evaluate(() => {
    const el = document.getElementById('app');
    window.minicadApi = window.mountMiniCad(el, {});
    return { roots: document.querySelectorAll('.minicad').length };
  });
  assert.equal(again.roots, 1, '二重に組み上がっている');
  console.log('✔ 同じ箱にもう一度組み直せる');

  // --- 閲覧のみ ---
  await page.evaluate((f) => {
    window.minicadApi.destroy();
    const el = document.getElementById('app');
    window.minicadApi = window.mountMiniCad(el, { scene: f, capabilities: { edit: false } });
  }, hostFile);
  await sleep(500);

  const viewOnly = await state();
  assert.deepEqual(viewOnly.toolbar, ['select', 'measure'], `道具が残っている: ${viewOnly.toolbar}`);
  assert.equal(await page.locator('.read-only-badge').count(), 1, '閲覧のみと書いていない');
  // **書き出しは別の権限。** 閲覧のみでも持ち帰れる場合がある
  assert.equal(await page.locator('.file-actions button:text-is("DXF")').count(), 1,
    '閲覧のみで書き出しまで消えている');
  assert.equal(await page.locator('.file-actions button:text-is("開く")').count(), 0,
    '図面を差し替えるボタンが残っている');
  assert.equal(await page.locator('.layer-row input.layer-name:not([disabled])').count(), 0,
    '画層名を直せてしまう');

  // **保証は Store。** 画面に無い経路からも書けないこと
  const blocked = await page.evaluate(() => {
    const store = window.minicad.editorInstance.store;
    const before = JSON.stringify(store.scene);
    const version = store.sceneVersion;
    store.commit(() => void (store.scene.walls[Object.keys(store.scene.walls)[0]].thickness = 999));
    store.undo();
    return { same: JSON.stringify(store.scene) === before, version, after: store.sceneVersion };
  });
  assert.ok(blocked.same, '閲覧のみなのに図面が変わった');
  assert.equal(blocked.after, blocked.version, '閲覧のみなのに版が上がった');

  // キーボードからも変わらない
  await page.keyboard.press('w');
  await sleep(150);
  assert.equal((await state()).tool, 'select', '隠した壁ツールがキーで選べる');
  console.log('✔ 閲覧のみでは道具が消え、どの経路からも図面が変わらない');

  await page.evaluate((f) => {
    window.minicadApi.destroy();
    window.minicadApi = window.mountMiniCad(document.getElementById('app'), {
      scene: f,
      capabilities: { download: false },
    });
  }, hostFile);
  await sleep(500);
  assert.equal(await page.locator('.file-actions button:text-is("DXF")').count(), 0,
    '書き出しを止めたのにボタンが残っている');
  assert.ok((await state()).toolbar.includes('wall'), '書き出しだけ止めたのに道具が消えた');
  console.log('✔ 書き出しの可否は編集の可否と別に効く');

  // --- ホストが渡すカタログ ---
  await page.evaluate((f) => {
    window.minicadApi.destroy();
    const def = {
      id: 'host-desk', name: 'HOST_DESK', label: 'ホストの机',
      size: { w: 1200, h: 600 }, source: 'user',
      shapes: {
        s1: {
          id: 's1', shape: 'line', layerId: 'furniture', levelId: 'lv-1',
          a: { x: -600, y: -300 }, b: { x: 600, y: -300 },
        },
      },
    };
    window.minicadApi = window.mountMiniCad(document.getElementById('app'), {
      scene: f,
      catalogs: {
        library: [
          { id: 'host-desk', label: 'ホストの机', category: 'オフィス', block: def },
          { id: 'base-2ldk', label: '2LDK ベース図面', category: 'ベース図面', scene: f },
        ],
        materials: [{ ref: 'm-1', label: 'タイルカーペット', color: '#8a8a7a' }],
      },
    });
  }, hostFile);
  await sleep(500);

  // 構造のボタンは組み込みなので、ホストのカタログだけを数える
  const parts = page.locator('.part-button:not([data-fixture])');
  assert.equal(await parts.count(), 2, 'カタログがパレットに出ていない');
  assert.equal(await page.locator('.part-button:disabled').count(), 1,
    '壁を含む部品が挿せるように見えている');

  const beforeInsert = await state();
  await page.locator('.part-button:not([data-fixture]):not(:disabled)').first().click();
  await sleep(250);
  assert.equal((await state()).tool, 'block', 'ブロックツールに移っていない');

  // 置ける。**新しい挿入の経路ではなく、既存のツールがそのまま効いている**
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(250);
  const placed = await state();
  assert.equal(placed.instances, beforeInsert.instances + 1, 'ホストの部品が置けない');
  assert.ok(placed.blockLabels.includes('ホストの机'), '定義が図面に入っていない');

  // undo 1 回で置いたものが戻る。足した定義は残る（使っていない定義は
  // ブロックの区画から消せる）
  await page.keyboard.press('Control+z');
  await sleep(250);
  const afterInsertUndo = await state();
  assert.equal(afterInsertUndo.instances, beforeInsert.instances, 'undo で戻らない');
  assert.ok(afterInsertUndo.blockLabels.includes('ホストの机'), '定義まで消えている');
  console.log('✔ ホストのカタログから部品を置ける');
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
