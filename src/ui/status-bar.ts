import { activeLevel } from '../core/level.ts';
import type { Viewer3D } from '../render3d/viewer.ts';
import { clear, el } from './dom.ts';
import type { Panel, PanelContext } from './panel.ts';

export class StatusBar implements Panel {
  /**
   * 直交とグリッドの入切。**押せるようにしてある。**
   *
   * 以前はここに「グリッド / 直交」と**文字で出ているだけ**で、入切は
   * `F8` と `G` でしか出来なかった。一般の CAD（AutoCAD の ORTHO・GRID・
   * OSNAP）はステータスバーのボタンで、クリックでも切り替わる。
   *
   * **タブレットには `F8` キーが無い。** 文字のままだと、キーボードの無い
   * 機械では**直交にすることが一生できない**——指で使えるようにする以上、
   * ここを押せるようにしないと片手落ちになる。
   */
  private readonly toggles = {
    grid: this.toggle('グリッド', 'グリッドスナップ (G)'),
    ortho: this.toggle('直交', '直交・角度スナップ (F8)'),
    /**
     * 3D の吸着。**2D の 2 つとは別の入切。**
     *
     * AutoCAD も 3D の吸着を別の変数（`3DOSMODE`）にしています——
     * 2D で端点に吸いたいことと、3D で立体の角に吸いたいことは、
     * **同時に要るとは限らない**ためです。
     */
    snap3d: this.toggle('3D 吸着', '3D の頂点・辺・面への吸着（Tab で候補送り）'),
  };

  /** 座標と尺度。**ボタンと混ぜない**ので、文字だけを入れ替えられる */
  private readonly text = el('span', { class: 'status-text' }, []);

  /**
   * いま描いている画層。**AutoCAD も Jw_cad も、画層は常時表示。**
   *
   * MiniCAD では「画層」の束を開かないと見えなかった——つまり
   * **自分がどの画層に描いているか分からないまま線が引けた**。
   * 画層は DXF の LAYER にそのまま対応し、書き出した先で効くので、
   * 気づかずに違う画層へ引くと、相手の CAD で初めて分かることになる。
   *
   * 見るだけでなく**選べる**。AutoCAD のリボンの画層欄と同じで、
   * 「見えているのに変えるには別の場所へ行く」のは一手多い。
   */
  private readonly layerPick = el('select', {
    class: 'status-layer',
    title: '新規作成の画層（DXF の LAYER）',
  }) as HTMLSelectElement;

  /** いま `layerPick` に入れてある選択肢。**同じなら建て直さない** */
  private layerOptions = '';

  constructor(
    private readonly hint: HTMLElement,
    private readonly readout: HTMLElement,
    private readonly viewer: Viewer3D,
  ) {
    this.readout.append(
      this.text,
      this.layerPick,
      this.toggles.snap3d,
      this.toggles.grid,
      this.toggles.ortho,
    );
  }

  private toggle(label: string, title: string): HTMLButtonElement {
    return el('button', { class: 'status-toggle', type: 'button', title }, [label]) as HTMLButtonElement;
  }

  refresh(ctx: PanelContext): void {
    this.refreshHint(ctx);
    this.refreshReadout(ctx);
  }

  /**
   * ツールの案内。**ポインタが動くたびに出し直す。**
   *
   * 以前はクリックのたびにしか更新しなかったので、「ここには置けません」
   * という断りが**1 手遅れて**出ていた。狙っているあいだに読めないと、
   * 断りを出している意味がない。
   */
  refreshHint(ctx: PanelContext): void {
    // 3D だけを出しているあいだは 2D のツールに手が届かない。掴んでいる最中は
    // 分割でも 3D の説明を優先する（壁の高さの数値はそこにしか出ない）
    const use3d = ctx.view.mode === '3d' || (ctx.view.isSplit && this.viewer.isGrabbing());
    this.hint.textContent = use3d ? this.viewer.status() : ctx.editor.tool.status(ctx.editor);
  }

  /** 座標表示だけはポインタ移動のたびに更新したいので、単独で呼べるようにしてある */
  refreshReadout(ctx: PanelContext): void {
    // 3D だけのときに平面の座標を出すと、2D を離れた時点の値が残って嘘になる。
    // **持っていないものは、持っていないと書く**
    if (!ctx.view.shows2d) {
      const scene = ctx.editor.store.scene;
      const projection = this.viewer.camera.mode === 'ortho' ? '平行投影' : '透視投影';
      this.text.textContent = `${activeLevel(scene).name}   |   ${projection}   |   平面の座標は出ません`;
      // **平面を出していないあいだは、平面の入切も出さない。**
      // 押しても見えるところが何も変わらないボタンは壊れて見える
      for (const b of [this.toggles.grid, this.toggles.ortho]) b.hidden = true;
      this.layerPick.hidden = true;
      this.refreshSnap3d(ctx);
      return;
    }
    const p = ctx.editor.pointerWorld();
    const s = ctx.editor.store.settings;
    const snap = ctx.editor.lastSnap;
    const snapText = snap && snap.kind !== 'free' && snap.label ? `  [${snap.label}]` : '';
    const zoom = Math.round(1 / ctx.editor.viewport.scale);
    this.text.textContent =
      `X ${Math.round(p.x)}  Y ${Math.round(p.y)} mm   |   1:${zoom}${snapText}`;

    /*
     * **押せる口は毎回作り直さない。** ここはポインタが動くたびに通るので、
     * 建て直すと 1 秒に 60 回ボタンが差し替わり、押している最中に
     * 消えることになる。中身は入切の印だけを塗り替える。
     */
    const show = (b: HTMLButtonElement, on: boolean, run: () => void): void => {
      b.hidden = false;
      b.setAttribute('aria-pressed', String(on));
      b.onclick = run;
    };
    show(this.toggles.grid, s.snapGrid, () => {
      ctx.set(() => void (ctx.editor.store.settings.snapGrid = !ctx.editor.store.settings.snapGrid));
    });
    show(this.toggles.ortho, s.ortho, () => {
      ctx.set(() => void (ctx.editor.store.settings.ortho = !ctx.editor.store.settings.ortho));
    });
    this.refreshLayer(ctx);
    this.refreshSnap3d(ctx);
  }

  /** 3D の吸着の入切。**3D が出ているときだけ**（分割も含む） */
  private refreshSnap3d(ctx: PanelContext): void {
    const b = this.toggles.snap3d;
    // **3D を出していないあいだは出さない。** 押しても見えるところが
    // 何も変わらないボタンは壊れて見える
    if (!ctx.view.shows3d || !ctx.can.edit) {
      b.hidden = true;
      return;
    }
    b.hidden = false;
    b.setAttribute('aria-pressed', String(ctx.editor.store.settings.snap3d));
    b.onclick = () => {
      ctx.set(() => void (ctx.editor.store.settings.snap3d = !ctx.editor.store.settings.snap3d));
    };
  }

  /**
   * 画層の欄。**開いている最中に建て直さない。**
   *
   * ここはポインタが動くたびに通るので、毎回 `option` を作り直すと
   * **開いたリストが指の下で閉じる**。中身が変わったときだけ建て直す。
   */
  private refreshLayer(ctx: PanelContext): void {
    /*
     * **閲覧のみでは出さない。** 道具が消えていて新しい線を引けないので、
     * 「新規作成の画層」は押しても何も起きない口になる
     * （`panel-rail.ts` / `level-switch.ts` と同じ筋）。
     */
    if (!ctx.can.edit) {
      this.layerPick.hidden = true;
      return;
    }
    this.layerPick.hidden = false;

    const store = ctx.editor.store;
    const layers = Object.values(store.scene.layers);
    const signature = layers.map((l) => `${l.id}:${l.name}`).join('|');
    if (signature !== this.layerOptions) {
      this.layerOptions = signature;
      clear(this.layerPick);
      // 既定は「種別ごと」——壁は A-WALL、文字は A-ANNO-TEXT へ自動で乗る
      this.layerPick.append(el('option', { value: '' }, ['画層: 種別ごと']));
      for (const l of layers) {
        this.layerPick.append(el('option', { value: l.id }, [`画層: ${l.name}`]));
      }
    }
    this.layerPick.value = store.settings.currentLayerId ?? '';
    this.layerPick.onchange = () => {
      const v = this.layerPick.value;
      ctx.set(() => void (store.settings.currentLayerId = v || null));
    };
  }
}
