import {
  centerFromChord, circleThrough, dist, mid, normalizeAngle, offsetPolyline,
  rectFromDiagonal, splinePoints, type Vec,
} from '../core/geometry.ts';
import { LAYER_IDS, resolveNewLayer, type LayerId } from '../core/layer.ts';
import { arcFromPoints, SHAPE_GEOMETRY, type Shape } from '../core/shapes.ts';
import { resolvePoint, type CoordInput } from '../core/coord-input.ts';
import type { TextAlign } from '../core/primitive.ts';
import { JIS_TEXT_HEIGHTS } from '../core/standard.ts';
import { newId } from '../core/types.ts';
import { drawPrimitives } from '../render/primitive.ts';
import { drawSnapMarker, type Frame } from '../render/renderer.ts';
import { getLayer } from '../core/layer.ts';
import { defaultAttrs } from '../core/attrs.ts';
import type { Editor } from '../ui/editor.ts';
import { pointerAngleFrom } from './wall.ts';
import type { NumericEntry, OptionField, PointerInfo, Tool, ToolId } from './tool.ts';

/** 円・円弧の描き方 */
export type ArcMode = 'circle' | 'arc' | 'three' | 'chord';

const ARC_MODE_LABELS: Record<ArcMode, string> = {
  circle: '円（中心・半径）',
  arc: '円弧（中心・始点・終点）',
  three: '円弧（3 点を通る）',
  chord: '円弧（始点・終点・半径）',
};

export type ShapeToolMode =
  | 'line' | 'doubleLine' | 'rect' | 'roundRect' | 'ngon' | 'ellipse'
  | 'spline' | 'arc' | 'text' | 'leader' | 'point';

/**
 * 「種類」セレクタに出す名前。**`Record<ShapeToolMode, string>` なので、
 * モードを足して書き忘れると型検査が止まる。**
 */
const MODE_LABELS: Record<ShapeToolMode, string> = {
  line: '直線・折れ線',
  doubleLine: 'ダブルライン',
  rect: '四角形',
  roundRect: '角丸四角形',
  ngon: '正多角形',
  ellipse: '楕円',
  spline: '曲線',
  arc: '円・円弧',
  text: '文字',
  leader: '引出線付き注釈',
  point: '基準点',
};

/**
 * 汎用図形の作図ツール。
 * OpeningTool と同じく、1つのクラスをモードでパラメタライズしている。
 * 「何点取るか・どう組むか」はモードごとに下の switch 1箇所に閉じている。
 *
 * **1 つのツールが複数のモードを持てる。** 建具が 11 種別を 2 ツール（ドア・窓）＋
 * 「種類」セレクタで出しているのと同じ形。作図の形はこれから増えるが、
 * **1 種別 1 ツールにするとツールバーが破綻する**（いま 21 ツールで、
 * 空いているショートカットは 4 つしかない）。
 *
 * `modes` が 1 つだけのツールはセレクタを出さない——選ぶものが無いのに
 * 欄があると、使う側は「他に何かあるはず」と探すことになる。
 */
export class ShapeTool implements Tool {
  readonly id: ToolId;
  readonly label: string;
  readonly shortcut: string;
  readonly cursor = 'crosshair';
  readonly group = 'draw' as const;

  /** このツールが出せるモード。先頭が既定 */
  private readonly modes: readonly ShapeToolMode[];
  /** 選択中のモード。`modes` が 2 つ以上なら「種類」セレクタで切り替わる */
  private mode: ShapeToolMode;
  /** 確定済みのクリック点 */
  private points: Vec[] = [];

  /** 線モード: 連続して引いてポリラインにする */
  chain = false;
  /** 線モード: 最後の点と始点を結んで閉じた多角形にする */
  closed = false;
  /** 角丸モード: 角の R (mm) */
  cornerRadius = 200;
  /** 正多角形モード: 辺の数 */
  sides = 6;
  /** ダブルラインモード: 2 本の間隔 (mm) */
  lineWidth = 200;
  /**
   * 円モードの描き方。仕様は「7 通り」と書いているが内訳が無いので、
   * **よく使う 3 通り**から入れる（残り 4 つの内訳は `docs/questions.md` の 16）。
   */
  arcMode: ArcMode = 'circle';
  /** 始点・終点・半径で描くときの半径 (mm) */
  arcRadius = 1000;
  /** 同上。進行方向の左に膨らませるか */
  arcLeft = true;
  /** 文字モード */
  text = '文字';
  textHeight = 3.5;
  textAlign: TextAlign = 'center';

  constructor(
    modes: ShapeToolMode | readonly ShapeToolMode[],
    id: ToolId,
    label: string,
    shortcut: string,
  ) {
    this.modes = typeof modes === 'string' ? [modes] : modes;
    this.mode = this.modes[0];
    this.id = id;
    this.label = label;
    this.shortcut = shortcut;
  }

  onActivate(editor: Editor): void {
    editor.store.clearSelection();
    this.reset(editor);
  }

  onDeactivate(editor: Editor): void {
    this.reset(editor);
  }

  isActive(): boolean {
    return this.points.length > 0;
  }

  cancel(editor: Editor): void {
    this.reset(editor);
    editor.requestRender();
  }

  private reset(editor: Editor): void {
    this.points = [];
    editor.snapContext = {};
  }

  /**
   * プレビューを出し始めるのに要る点の数。
   *
   * **`requiredPoints` とは別物。** 連続モードの `Infinity` では出せないし、
   * 円弧は 3 点目まで形が決まらない。以前は `previewShape` の中に式が
   * 直書きされていて、**モードを足しても型検査が止めなかった**。
   */
  private get previewPoints(): number {
    switch (this.mode) {
      case 'arc':
        return this.arcMode === 'circle' || this.arcMode === 'chord' ? 2 : 3;
      case 'line':
      case 'doubleLine':
      case 'rect':
      case 'roundRect':
      case 'ngon':
      case 'ellipse':
      case 'spline':
      case 'text':
      case 'leader':
      case 'point':
        return 2;
    }
  }

  /** そのモードが必要とする点の数。線の連続モードだけ可変 */
  private get requiredPoints(): number {
    switch (this.mode) {
      case 'line':
        return this.chain ? Infinity : 2;
      // ダブルラインは常に連続。Enter / ダブルクリックで終える
      case 'doubleLine':
        return Infinity;
      // 四角形・角丸は対角の 2 点、正多角形と楕円は中心と外接円の 1 点。
      // 曲線は Enter / ダブルクリックで終える
      case 'rect':
      case 'roundRect':
      case 'ngon':
      case 'ellipse':
        return 2;
      case 'spline':
        return Infinity;
      case 'arc':
        switch (this.arcMode) {
          case 'circle':
            return 2;
          case 'chord':
            return 2;
          case 'arc':
          case 'three':
            return 3;
        }
      case 'text':
      case 'point':
        return 1;
      // 指す点 → 折れ点 の 2 点
      case 'leader':
        return 2;
    }
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    this.points.push(p.world);
    editor.snapContext = { from: this.points[this.points.length - 1] };
    if (this.points.length >= this.requiredPoints) this.commit(editor);
  }

  onDoubleClick(editor: Editor): void {
    // 連続モードの終了
    if (this.points.length >= 2) this.commit(editor);
    else this.reset(editor);
  }

  onKeyDown(editor: Editor, e: KeyboardEvent): boolean {
    if (e.key === 'Enter' && this.points.length >= 2) {
      this.commit(editor);
      return true;
    }
    if (e.key === 'Escape' && this.points.length > 0) {
      this.cancel(editor);
      return true;
    }
    return false;
  }

  private commit(editor: Editor): void {
    const shapes = this.build(editor);
    this.reset(editor);
    if (shapes.length === 0) return;
    const store = editor.store;
    // **1 コミットにまとめる。** ダブルラインは 2 本の図形になるので、
    // 別々に置くと undo が 2 回要る
    store.commit(() => {
      for (const shape of shapes) store.scene.shapes[shape.id] = shape;
    });
  }

  /**
   * いまの点で置くもの。**0 個・1 個・2 個のいずれか。**
   * ダブルラインだけが 2 本の図形になる（1 つの実体としては持たない）。
   */
  private build(editor: Editor): Shape[] {
    if (this.mode !== 'doubleLine') {
      const one = this.buildOne(editor);
      return one ? [one] : [];
    }
    const unique = dedupePoints(this.points);
    if (unique.length < 2) return [];
    const half = this.lineWidth / 2;
    const out: Shape[] = [];
    for (const side of [half, -half]) {
      const points = offsetPolyline(unique, side, this.closed);
      // **退化したら置かない。** `offsetPolyline` は自己交差を除去せず
      // null を返して諦める造りなので、片側だけ出すと figure が壊れる
      if (!points) return [];
      out.push({
        id: newId('s'),
        shape: 'polyline',
        layerId: this.newLayer(editor),
        levelId: editor.store.scene.activeLevelId,
        attrs: defaultAttrs(),
        points,
        closed: this.closed,
      });
    }
    return out;
  }

  /** 新しく置く図形の画層 */
  private newLayer(editor: Editor): LayerId {
    return resolveNewLayer(
      editor.store.scene.layers,
      editor.store.settings.currentLayerId,
      SHAPE_GEOMETRY[shapeKindOf(this.mode, this.arcMode)].defaultLayer,
    );
  }

  private buildOne(editor: Editor): Shape | null {
    const pts = this.points;
    const layerId = resolveNewLayer(
      editor.store.scene.layers,
      editor.store.settings.currentLayerId,
      SHAPE_GEOMETRY[shapeKindOf(this.mode, this.arcMode)].defaultLayer,
    );
    const id = newId('s');
    const levelId = editor.store.scene.activeLevelId;
    const attrs = defaultAttrs();

    switch (this.mode) {
      case 'line': {
        const unique = dedupePoints(pts);
        if (unique.length < 2) return null;
        // 閉じるには 3 点要る。2 点で「閉じる」は線が往復するだけ
        const shut = this.closed && this.chain && unique.length > 2;
        if (unique.length === 2) return { id, shape: 'line', layerId, levelId, attrs, a: unique[0], b: unique[1] };
        return { id, shape: 'polyline', layerId, levelId, attrs, points: unique, closed: shut };
      }
      // 対角 2 点から 4 隅。**専用の型は作らない**——`polyline.closed` が
      // 「矩形や多角形は closed: true で表す」と宣言済み（core/shapes.ts）
      // 2 本の図形になるので `build` が受け持つ。ここでは作らない
      case 'doubleLine':
        return null;
      case 'rect': {
        const points = rectFromDiagonal(pts[0], pts[1]);
        return points === null
          ? null
          : { id, shape: 'polyline', layerId, levelId, attrs, points, closed: true };
      }
      case 'roundRect': {
        const corners = rectFromDiagonal(pts[0], pts[1]);
        if (corners === null) return null;
        const w = Math.abs(pts[1].x - pts[0].x);
        const h = Math.abs(pts[1].y - pts[0].y);
        return {
          id, shape: 'roundRect', layerId, levelId, attrs,
          center: mid(pts[0], pts[1]),
          w,
          h,
          radius: Math.min(this.cornerRadius, Math.min(w, h) / 2),
          angle: 0,
        };
      }
      case 'ngon': {
        const radius = dist(pts[0], pts[1]);
        if (radius < 1) return null;
        return {
          id, shape: 'regularPolygon', layerId, levelId, attrs,
          center: pts[0],
          radius,
          sides: this.sides,
          // 2 点目の向きを最初の頂点にする。打った方向に頂点が来る
          angle: Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x),
        };
      }
      case 'ellipse': {
        const dx = Math.abs(pts[1].x - pts[0].x);
        const dy = Math.abs(pts[1].y - pts[0].y);
        if (dx < 1 || dy < 1) return null;
        // 対角 2 点に内接する楕円。長いほうを長半径にする
        const major = Math.max(dx, dy) / 2;
        const minor = Math.min(dx, dy) / 2;
        return {
          id, shape: 'ellipse', layerId, levelId, attrs,
          center: mid(pts[0], pts[1]),
          major,
          ratio: minor / major,
          angle: dx >= dy ? 0 : Math.PI / 2,
        };
      }
      case 'spline': {
        const unique = dedupePoints(pts);
        if (unique.length < 2) return null;
        // 2 点では曲がりようがないので直線になる
        return {
          id, shape: 'polyline', layerId, levelId, attrs,
          points: splinePoints(unique), closed: false,
        };
      }
      case 'arc': {
        switch (this.arcMode) {
          case 'circle': {
            const radius = dist(pts[0], pts[1]);
            return radius < 1 ? null : { id, shape: 'circle', layerId, levelId, attrs, center: pts[0], radius };
          }
          case 'arc': {
            if (dist(pts[0], pts[1]) < 1) return null;
            return { id, shape: 'arc', layerId, levelId, attrs, ...arcFromPoints(pts[0], pts[1], pts[2]) };
          }
          // 3 点を通る円弧。真ん中の点を通る向きに回す
          case 'three': {
            const got = circleThrough(pts[0], pts[1], pts[2]);
            if (!got || got.radius < 1) return null;
            const arc = arcFromPoints(got.center, pts[0], pts[2]);
            // 始点→終点の反時計回りが真ん中の点を含まないなら、向きを入れ替える
            const through = arcFromPoints(got.center, pts[0], pts[1]);
            const sweep = normalizeAngle(arc.endAngle - arc.startAngle);
            const mid = normalizeAngle(through.endAngle - through.startAngle);
            return {
              id, shape: 'arc', layerId, levelId, attrs,
              ...(mid <= sweep ? arc : { ...arc, startAngle: arc.endAngle, endAngle: arc.startAngle }),
            };
          }
          // 始点・終点と半径。中心は弦の垂直二等分線の上にある
          case 'chord': {
            const center = centerFromChord(pts[0], pts[1], this.arcRadius, this.arcLeft);
            if (!center) return null;
            return { id, shape: 'arc', layerId, levelId, attrs, ...arcFromPoints(center, pts[0], pts[1]) };
          }
        }
      }
      case 'text': {
        const value = this.text.trim();
        if (!value) return null;
        return {
          id,
          shape: 'text',
          layerId,
          levelId,
          attrs,
          at: pts[0],
          text: value,
          height: this.textHeight,
          angle: 0,
          align: this.textAlign,
        };
      }
      case 'leader': {
        const value = this.text.trim();
        if (!value) return null;
        return {
          id, shape: 'leader', layerId, levelId, attrs,
          at: pts[0],
          elbow: pts[1],
          text: value,
          height: this.textHeight,
        };
      }
      case 'point':
        return { id, shape: 'point', layerId, levelId, attrs, at: pts[0] };
    }
  }

  numericEntry(_editor: Editor): NumericEntry | null {
    if (this.mode !== 'line') return null;
    const from = this.points[this.points.length - 1] ?? null;
    return {
      mode: 'point',
      base: from,
      fallbackAngleDeg: (ed) => pointerAngleFrom(ed, from),
      submit: (ed, input) => this.submitNumeric(ed, input),
    };
  }

  private submitNumeric(editor: Editor, input: CoordInput): void {
    const from = this.points[this.points.length - 1] ?? null;
    const point = resolvePoint(input, from, pointerAngleFrom(editor, from));
    if (!point) return;
    this.points.push(point);
    editor.snapContext = { from: point };
    if (this.points.length >= this.requiredPoints) this.commit(editor);
    editor.requestRender();
  }

  options(): OptionField[] {
    return [...this.modeField(), ...this.modeOptions()];
  }

  /** 出せるモードが 2 つ以上あるときだけ「種類」を出す */
  private modeField(): OptionField[] {
    if (this.modes.length < 2) return [];
    return [{
      kind: 'select',
      label: '種類',
      value: this.mode,
      options: this.modes.map((m) => ({ value: m, label: MODE_LABELS[m] })),
      onChange: (v: string) => {
        this.mode = this.modes.find((m) => m === v) ?? this.mode;
        this.points = [];
      },
    }];
  }

  private modeOptions(): OptionField[] {
    switch (this.mode) {
      case 'line':
        return [
          { kind: 'toggle', label: '連続して引く（ポリライン）', value: this.chain, onChange: (v) => void (this.chain = v) },
          // 閉じた多角形。**専用の型は作らない**——`polyline.closed` で表す
          ...(this.chain
            ? [{
                kind: 'toggle' as const,
                label: '閉じる（多角形）',
                value: this.closed,
                onChange: (v: boolean) => void (this.closed = v),
              }]
            : []),
          { kind: 'note', text: 'Enter / ダブルクリックで終了' },
        ];
      case 'doubleLine':
        return [
          {
            kind: 'number',
            label: '間隔',
            value: this.lineWidth,
            step: 50,
            min: 1,
            suffix: 'mm',
            onChange: (v: number) => void (this.lineWidth = Math.max(1, v)),
          },
          { kind: 'toggle', label: '閉じる', value: this.closed, onChange: (v) => void (this.closed = v) },
          { kind: 'note', text: '中心線を順にクリック / Enter・ダブルクリックで終了' },
        ];
      case 'rect':
        return [{ kind: 'note', text: '対角の 2 点をクリック' }];
      case 'roundRect':
        return [
          {
            kind: 'number',
            label: '角の R',
            value: this.cornerRadius,
            step: 50,
            min: 0,
            suffix: 'mm',
            onChange: (v: number) => void (this.cornerRadius = Math.max(0, v)),
          },
          { kind: 'note', text: '対角の 2 点をクリック' },
        ];
      case 'ngon':
        return [
          {
            kind: 'number',
            label: '辺の数',
            value: this.sides,
            step: 1,
            min: 3,
            max: 64,
            onChange: (v: number) => void (this.sides = Math.max(3, Math.min(64, Math.round(v)))),
          },
          { kind: 'note', text: '中心 → 最初の頂点の順にクリック' },
        ];
      case 'ellipse':
        return [
          { kind: 'note', text: '対角の 2 点をクリック（その四角に内接します）' },
          { kind: 'note', text: 'DXF には折れ線で出ます（R12 に楕円がありません）' },
        ];
      case 'spline':
        return [{ kind: 'note', text: '通る点を順にクリック / Enter・ダブルクリックで終了' }];
      case 'arc':
        return [
          {
            kind: 'select',
            label: '描き方',
            value: this.arcMode,
            options: (Object.keys(ARC_MODE_LABELS) as ArcMode[]).map((k) => ({
              value: k,
              label: ARC_MODE_LABELS[k],
            })),
            onChange: (v) => {
              this.arcMode = (v in ARC_MODE_LABELS ? v : 'circle') as ArcMode;
              this.points = [];
            },
          },
          // 半径で描くときだけ、半径と膨らむ側を出す
          ...(this.arcMode === 'chord'
            ? [
                {
                  kind: 'number' as const,
                  label: '半径',
                  value: this.arcRadius,
                  step: 100,
                  min: 1,
                  suffix: 'mm',
                  onChange: (v: number) => void (this.arcRadius = Math.max(1, v)),
                },
                {
                  kind: 'toggle' as const,
                  label: '左へ膨らませる',
                  value: this.arcLeft,
                  onChange: (v: boolean) => void (this.arcLeft = v),
                },
              ]
            : []),
        ];
      case 'leader':
        return [
          { kind: 'text', label: '注釈', value: this.text, placeholder: '注釈', onChange: (v) => void (this.text = v) },
          {
            kind: 'select',
            label: '高さ',
            value: String(this.textHeight),
            options: JIS_TEXT_HEIGHTS.map((h) => ({ value: String(h), label: `${h} mm` })),
            onChange: (v) => void (this.textHeight = Number(v)),
          },
          { kind: 'note', text: '指す点 → 折れ点 の順にクリック' },
        ];
      case 'text':
        return [
          { kind: 'text', label: '文字', value: this.text, placeholder: '文字', onChange: (v) => void (this.text = v) },
          {
            kind: 'select',
            label: '高さ',
            value: String(this.textHeight),
            options: JIS_TEXT_HEIGHTS.map((h) => ({ value: String(h), label: `${h} mm` })),
            onChange: (v) => void (this.textHeight = Number(v)),
          },
          {
            kind: 'select',
            label: '揃え',
            value: this.textAlign,
            options: [
              { value: 'left', label: '左' },
              { value: 'center', label: '中央' },
              { value: 'right', label: '右' },
            ],
            onChange: (v) => void (this.textAlign = v as TextAlign),
          },
        ];
      case 'point':
        return [{ kind: 'note', text: 'クリックで基準点を置く' }];
    }
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    const snap = editor.lastSnap;
    if (snap && snap.kind !== 'free') drawSnapMarker(frame, snap.point, snap.label);
    if (this.points.length === 0) return;

    // 確定済みの点 + 現在のカーソル位置で仮の図形を組み、同じ描画経路で出す
    for (const preview of this.previewShapes(editor)) {
      const layer = getLayer(editor.store.scene.layers, preview.layerId, LAYER_IDS.shape);
      drawPrimitives(
        frame,
        SHAPE_GEOMETRY[preview.shape].primitives(editor.store.scene, preview as never, editor.store.scene.standard),
        layer,
        'rgba(37, 99, 235, 0.9)',
      );
    }
  }

  private previewShapes(editor: Editor): Shape[] {
    const cursor = editor.lastSnap?.point ?? editor.pointerWorld();
    const saved = this.points;
    this.points = [...saved, cursor];
    try {
      // 点が足りないモードはプレビューを出さない
      if (this.points.length < Math.min(this.requiredPoints, this.previewPoints)) return [];
      return this.build(editor);
    } finally {
      this.points = saved;
    }
  }

  status(): string {
    switch (this.mode) {
      case 'line':
        if (this.points.length === 0) return 'クリックで始点を指定';
        return this.chain
          ? 'クリックで次の点 / 数値を打ち込んで Enter / ダブルクリックで終了'
          : 'クリックで終点を指定 / 数値を打ち込んで Enter';
      case 'arc':
        switch (this.arcMode) {
          case 'circle':
            return this.points.length === 0 ? 'クリックで円の中心を指定' : 'クリックで半径を指定';
          case 'arc':
            return ['クリックで円弧の中心を指定', 'クリックで始点を指定', 'クリックで終点を指定（反時計回り）'][
              this.points.length
            ]!;
          case 'three':
            return ['クリックで始点を指定', 'クリックで通る点を指定', 'クリックで終点を指定'][
              this.points.length
            ]!;
          case 'chord':
            return this.points.length === 0
              ? `クリックで始点を指定（半径 ${this.arcRadius}mm）`
              : 'クリックで終点を指定';
        }
      case 'doubleLine':
        return this.points.length === 0
          ? `クリックで中心線の始点を指定（間隔 ${this.lineWidth}mm）`
          : 'クリックで次の点 / Enter・ダブルクリックで終了';
      case 'rect':
      case 'roundRect':
      case 'ellipse':
        return this.points.length === 0 ? 'クリックで一隅を指定' : 'クリックで対角を指定';
      case 'ngon':
        return this.points.length === 0
          ? `クリックで正 ${this.sides} 角形の中心を指定`
          : 'クリックで最初の頂点を指定';
      case 'spline':
        return this.points.length === 0
          ? 'クリックで曲線の始点を指定'
          : 'クリックで通る点を足す / Enter・ダブルクリックで終了';
      case 'leader':
        return this.points.length === 0
          ? `「${this.text || '(空)'}」が指す点をクリック`
          : 'クリックで引出線の折れ点を指定';
      case 'text':
        return `「${this.text || '(空)'}」を置く位置をクリック`;
      case 'point':
        return 'クリックで基準点を置く';
    }
  }
}

/**
 * そのモードが作る図形の種別。**既定の画層を引くためだけに使う。**
 * 四角形も曲線も折れ線なので、新しい種別は増えない。
 */
function shapeKindOf(mode: ShapeToolMode, arcMode: ArcMode): Shape['shape'] {
  switch (mode) {
    case 'line':
      return 'line';
    case 'rect':
    case 'spline':
    case 'doubleLine':
      return 'polyline';
    case 'roundRect':
      return 'roundRect';
    case 'ngon':
      return 'regularPolygon';
    case 'ellipse':
      return 'ellipse';
    // 円だけが `circle`。残りの描き方はどれも円弧になる
    case 'arc':
      return arcMode === 'circle' ? 'circle' : 'arc';
    case 'leader':
      return 'leader';
    case 'text':
    case 'point':
      return mode;
  }
}

/** 同じ場所を2回クリックしたときに退化した図形を作らないようにする */
function dedupePoints(points: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of points) {
    if (out.length === 0 || dist(out[out.length - 1], p) > 1e-6) out.push(p);
  }
  return out;
}
