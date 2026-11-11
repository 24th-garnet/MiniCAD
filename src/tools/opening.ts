import { defaultAttrs } from '../core/attrs.ts';
import { closestOnSegment, dist, vec, type Vec } from '../core/geometry.ts';
import { clampOpening, mergeOpeningSpan, wallEnds, wallLength } from '../core/ops.ts';
import { LAYER_IDS, resolveNewLayer, type LayerId } from '../core/layer.ts';
import type { OpeningIdentity } from '../core/opening.ts';
import { openingFrame, openingQuad } from '../core/shape.ts';
import { OPENING_SYMBOLS, openingKindsOf, openingPrimitives } from '../core/opening.ts';
import { newId, type Id, type Opening, type OpeningKind } from '../core/types.ts';
import { theme } from '../render/theme.ts';
import { drawPrimitives } from '../render/primitive.ts';
import { getLayer } from '../core/layer.ts';
import type { Frame } from '../render/renderer.ts';
import { BAY_LABELS, BAY_SHAPES, type Bay, type BayShape } from '../core/bay.ts';
import {
  cornerBayBlocker, defaultCornerBay, nearestCorner, placeCornerBay,
  type CornerBayOptions,
} from '../core/cornerBay.ts';
import type { Editor } from '../ui/editor.ts';
import type { OptionField, PointerInfo, Tool, ToolId } from './tool.ts';

interface Candidate {
  wallId: Id;
  offset: number;
  /** 置く幅。既存と結合するときは、まとめた区間の幅になる */
  width: number;
  /** 結合して消える開口。置くのと同じコミットで消す */
  absorb: Id[];
}

/**
 * ドア・窓を壁に差し込むツール。壁の上にしか置けないので、常に最寄りの壁へ吸着する。
 *
 * 種別はツールではなくオプションのセレクタで選ぶ。JIS A 0150 の建具は 10 種あり、
 * 1 種ごとにツールを立てるとツールバーが破綻するため。
 */
export class OpeningTool implements Tool {
  readonly id: ToolId;
  readonly label: string;
  readonly shortcut: string;
  readonly cursor = 'crosshair';
  readonly group = 'draw' as const;

  private readonly family: 'door' | 'window';
  /** 選択中の種別。オプションのセレクタで切り替える */
  kind: OpeningKind;
  /** 開口幅 (mm)。種別を変えると既定値に追従する */
  width: number;
  /** 枚数。種別を変えると既定値に追従する（片引きは 1、折戸は 4） */
  leaves: number;
  flipX = false;
  flipY = false;

  private candidate: Candidate | null = null;
  /**
   * L 型出窓を置くモード。**壁ではなく角をクリックする。**
   *
   * 種別を増やさずにここで分けるのは、角をまたぐものが `Opening` 1 つでは
   * 表せないから（窓 2 つ ＋ L 字の張り出し 1 つになる）。
   */
  corner = false;
  private cornerAt: Id | null = null;
  private cornerWhy: string | null = null;

  constructor(family: 'door' | 'window', id: ToolId, label: string, shortcut: string) {
    this.family = family;
    this.id = id;
    this.label = label;
    this.shortcut = shortcut;
    this.kind = openingKindsOf(family)[0];
    this.width = OPENING_SYMBOLS[this.kind].defaultWidth;
    this.leaves = OPENING_SYMBOLS[this.kind].defaultLeaves;
  }

  private get symbol() {
    return OPENING_SYMBOLS[this.kind];
  }

  onActivate(editor: Editor): void {
    editor.store.clearSelection();
    this.candidate = null;
  }

  onDeactivate(): void {
    this.candidate = null;
  }

  onPointerMove(editor: Editor, p: PointerInfo): void {
    if (this.corner) {
      this.aimCorner(editor, p.raw);
      return;
    }
    this.candidate = this.findCandidate(editor, p.raw);
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    if (this.corner) {
      this.placeCorner(editor, p.raw);
      return;
    }
    const candidate = this.candidate ?? this.findCandidate(editor, p.raw);
    if (!candidate) return;
    const store = editor.store;
    const id = newId('o');
    const opening = this.makeOpening(
      id,
      candidate,
      resolveNewLayer(store.scene.layers, store.settings.currentLayerId, LAYER_IDS.opening),
    );
    store.commit(() => {
      // 吸収したぶんは同じコミットで消す。undo 1 回で元の 2 つに戻る
      for (const absorbed of candidate.absorb) delete store.scene.openings[absorbed];
      store.scene.openings[id] = opening;
    });
  }

  onKeyDown(editor: Editor, e: KeyboardEvent): boolean {
    // 反転。X で吊元・引き勝手、Y で開く向き。
    // その種別で意味を持たないときは握りつぶさず、他のショートカットへ通す
    if ((e.key === 'x' || e.key === 'X') && this.symbol.usesFlipX) {
      this.flipX = !this.flipX;
      editor.requestRender();
      return true;
    }
    if ((e.key === 'y' || e.key === 'Y') && this.symbol.usesFlipY) {
      this.flipY = !this.flipY;
      editor.requestRender();
      return true;
    }
    return false;
  }

  /** いちばん近い角と、そこに置けるかどうか */
  private aimCorner(editor: Editor, at: Vec): void {
    this.candidate = null;
    const scene = editor.store.scene;
    const node = nearestCorner(scene, at, editor.pickRadius() * 4);
    this.cornerAt = node;
    this.cornerWhy = node ? cornerBayBlocker(scene, node, this.cornerOptions()) : null;
  }

  /** L 型出窓を置く。**置けないときは何も変えない**（理由は状況表示に出ている） */
  private placeCorner(editor: Editor, at: Vec): void {
    this.aimCorner(editor, at);
    const node = this.cornerAt;
    if (!node || this.cornerWhy) return;
    const store = editor.store;
    const opts = {
      ...this.cornerOptions(),
      layerId: resolveNewLayer(store.scene.layers, store.settings.currentLayerId, LAYER_IDS.opening),
    };
    store.commit(() => void placeCornerBay(store.scene, node, opts));
  }

  private cornerOptions(): CornerBayOptions {
    return {
      width: this.width,
      depth: this.bay?.depth ?? defaultCornerBay().depth,
      sillHeight: this.sillHeight,
      height: this.height,
    };
  }

  /** カーソルに最も近い壁の、開口が収まる位置を探す */
  /**
   * いま置こうとしている建具を組み立てる。**置くときとプレビューで共有する。**
   *
   * 以前は `onPointerDown` と `drawOverlay` に同じリテラルが 2 つあった。
   * 欄を足すたびに両方直す必要があり、片方を忘れると
   * **ゴーストと実際に置かれるものが違う**という質の悪い壊れ方をする。
   *
   * 結合するときの幅は `candidate.width`（まとめた後の形）。
   * 押す前に結果が見えるのは、ここを共有しているから。
   */
  private makeOpening(id: Id, candidate: Candidate, layerId: LayerId): Opening {
    return {
      id,
      wallId: candidate.wallId,
      offset: candidate.offset,
      width: candidate.width,
      ...this.identity(layerId),
    };
  }

  /**
   * いまの設定で置くものの、**位置と幅以外のすべて**。
   *
   * 結合の判定（`mergeOpeningSpan`）が「融かしてよい相手か」を決めるのに使う。
   * 置くものと同じ出どころにしてあるので、**設定を足したときに判定が
   * 置き去りにならない**。
   */
  private identity(layerId: LayerId): OpeningIdentity {
    return {
      kind: this.kind,
      flipX: this.flipX,
      flipY: this.flipY,
      sillHeight: this.sillHeight,
      bay: this.bay ? { ...this.bay } : null,
      designation: this.designation,
      leaves: this.leaves,
      height: this.height,
      layerId,
      attrs: defaultAttrs(),
    };
  }

  private findCandidate(editor: Editor, p: Vec): Candidate | null {
    const scene = editor.store.scene;
    const limit = editor.viewport.toWorldLength(40);
    const layerId = resolveNewLayer(scene.layers, editor.store.settings.currentLayerId, LAYER_IDS.opening);
    let best: (Candidate & { d: number }) | null = null;

    for (const wall of Object.values(scene.walls)) {
      const [a, b] = wallEnds(scene, wall);
      const c = closestOnSegment(p, a, b);
      const reach = Math.max(limit, wall.thickness);
      if (c.dist > reach) continue;
      const raw = c.t * dist(a, b);

      // **同じものと重なるならまとめる。** 壁が既に持っている 1 次元の
      // パラメータ空間での区間マージで、CSG ではない。
      // 画層は置くときに決まるので、判定もそのときの画層で行う
      const merged = mergeOpeningSpan(scene, wall.id, this.identity(layerId), raw, this.width);
      const here: Candidate | null = merged
        ? { wallId: wall.id, offset: merged.offset, width: merged.width, absorb: merged.absorb }
        : (() => {
            const offset = clampOpening(scene, wall.id, raw, this.width);
            return offset === null ? null : { wallId: wall.id, offset, width: this.width, absorb: [] };
          })();
      if (!here) continue;
      if (!best || c.dist < best.d) best = { ...here, d: c.dist };
    }
    if (!best) return null;
    const { d: _d, ...candidate } = best;
    return candidate;
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    if (this.corner) {
      this.drawCornerAim(editor, frame);
      return;
    }
    const candidate = this.candidate;
    if (!candidate) return;
    const scene = editor.store.scene;
    // **置くものと同じ関数で作る。** ここを別に書くと、欄を足したときに
    // 片方だけ直してゴーストと実体がずれる
    const preview = this.makeOpening('__preview', candidate, LAYER_IDS.opening);
    const f = openingFrame(scene, preview);
    if (!f) return;
    const { ctx, vp } = frame;
    ctx.save();
    ctx.beginPath();
    openingQuad(f).forEach((q, i) => {
      const s = vp.toScreen(q);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(37, 99, 235, 0.35)';
    ctx.fill();
    ctx.strokeStyle = theme.preview;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // 置く前に記号そのものを見せる。開き勝手や引き勝手は置いてから直すより選ぶほうが速い
    const layer = getLayer(scene.layers, LAYER_IDS.opening, LAYER_IDS.opening);
    drawPrimitives(frame, openingPrimitives(scene, preview), layer, theme.preview);
  }

  /** 出窓・ニッチを付けて置く。パレットの「出窓」が立てる */
  bay: Bay | null = null;

  /**
   * パレットの品名が決める既定値。**種別を増やさずに品を分ける札。**
   *
   * 掃き出し窓と腰窓、勝手口ドアと玄関ドアは、種別も記号も同じで
   * これらの値だけが違う。欄として持っておけば、パレットは
   * 「`kind` ＋ この 3 つ」を流し込むだけで 1 品になる。
   */
  sillHeight: number | null = null;
  height: number | null = null;
  designation = '';

  options(): OptionField[] {
    const flips = [
      this.symbol.usesFlipX ? 'X で吊元・引き勝手' : null,
      this.symbol.usesFlipY ? 'Y で開く向き' : null,
    ].filter(Boolean);
    const fields: OptionField[] = [
      {
        kind: 'select',
        label: '種類',
        value: this.kind,
        options: openingKindsOf(this.family).map((k) => ({ value: k, label: OPENING_SYMBOLS[k].label })),
        onChange: (v: string) => {
          this.kind = v as OpeningKind;
          this.width = this.symbol.defaultWidth;
          this.leaves = this.symbol.defaultLeaves;
        },
      },
      {
        kind: 'number',
        label: '幅 (mm)',
        value: this.width,
        step: 50,
        min: 100,
        onChange: (v: number) => void (this.width = Math.max(100, v)),
      },
    ];
    // 枚数で記号が変わる種別にだけ出す。出さない種別で出すと、
    // 直しても図面が変わらない欄が残る
    if (this.symbol.usesLeaves) {
      fields.push({
        kind: 'number',
        label: '枚数',
        value: this.leaves,
        step: 1,
        min: 1,
        max: 6,
        onChange: (v: number) => void (this.leaves = Math.max(1, Math.min(6, Math.round(v)))),
      });
    }
    if (this.bay) {
      fields.push(
        {
          kind: 'select',
          label: '張り出し',
          value: this.bay.shape,
          options: BAY_SHAPES.map((k) => ({ value: k, label: BAY_LABELS[k] })),
          onChange: (v: string) => void (this.bay = { ...this.bay!, shape: v as BayShape }),
        },
        {
          kind: 'number',
          label: '出 (mm)',
          value: this.bay.depth,
          step: 50,
          onChange: (v: number) => void (this.bay = { ...this.bay!, depth: v }),
        },
      );
    }
    if (flips.length > 0) fields.push({ kind: 'note', text: `${flips.join(' / ')}を反転` });
    return fields;
  }

  /** 狙っている角に印を出す。置けないときは赤くして理由を状況表示に出す */
  private drawCornerAim(editor: Editor, frame: Frame): void {
    const node = this.cornerAt ? editor.store.scene.nodes[this.cornerAt] : null;
    if (!node) return;
    const { ctx, vp } = frame;
    const s = vp.toScreen(vec(node.x, node.y));
    ctx.save();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
    ctx.strokeStyle = this.cornerWhy ? theme.constraintConflict : theme.preview;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  status(editor: Editor): string {
    if (Object.keys(editor.store.scene.walls).length === 0) return 'まず壁を描いてください';
    if (this.corner) {
      if (this.cornerWhy) return this.cornerWhy;
      return this.cornerAt
        ? `L 型出窓  幅 ${this.width}mm / 出 ${this.cornerOptions().depth}mm  —  クリックで置きます`
        : '壁 2 本が折れている角にカーソルを合わせてクリック';
    }
    if (!this.candidate) return '壁の上にカーソルを合わせてクリック';
    const wall = editor.store.scene.walls[this.candidate.wallId];
    const total = wall ? Math.round(wallLength(editor.store.scene, wall)) : 0;
    const hint = this.symbol.usesFlipX || this.symbol.usesFlipY ? '  —  X / Y で反転' : '';
    const merge = this.candidate.absorb.length > 0
      ? `  —  既存の ${this.candidate.absorb.length} つと結合して幅 ${Math.round(this.candidate.width)}mm になります`
      : '';
    return `${this.symbol.label} 幅 ${this.width}mm / 壁長 ${total}mm の ${Math.round(this.candidate.offset)}mm の位置${hint}${merge}`;
  }
}
