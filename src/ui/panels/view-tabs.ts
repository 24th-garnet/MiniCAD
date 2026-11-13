import type { Viewer3D } from "../../render3d/viewer.ts";
import { clear, el } from "../dom.ts";
import type { Panel, PanelContext } from "../panel.ts";
import { VIEW_LABELS, VIEW_MODES } from "../view-state.ts";
import {
  ORBIT_CENTER_LABELS,
  type OrbitCenter,
} from "../../render3d/camera.ts";
import {
  FIXTURE_SPECS,
  fixtureKindsOf,
  type FixtureKind,
} from "../../core/fixture.ts";

/**
 * 2D / 3D / 分割の切り替え。
 *
 * **どのビューかは `ctx.view` が権威。** `Viewer3D.isVisible()` は
 * 「3D が見えているか」しか答えられず、分割では 2D も同時に見えている。
 *
 * `Viewer3D` 自身は `Panel` にしない。`App.refresh()` が全パネルを毎回呼ぶので、
 * 隠れているときも描画要求が立ってしまう。ここはボタンだけを持つ。
 */
export class ViewTabs implements Panel {
  constructor(
    private readonly host: HTMLElement,
    private readonly viewer: Viewer3D,
  ) {}

  refresh(ctx: PanelContext): void {
    clear(this.host);

    for (const mode of VIEW_MODES) {
      this.host.append(
        el(
          "button",
          {
            type: "button",
            "aria-pressed": String(ctx.view.mode === mode),
            onclick: () => {
              ctx.view.set(mode);
            },
          },
          [VIEW_LABELS[mode]],
        ),
      );
    }

    // カメラの操作は 3D が見えているときだけ意味がある
    if (!ctx.view.shows3d) return;
    this.host.append(
      el(
        "button",
        {
          type: "button",
          title: "図面全体が入るように合わせる",
          onclick: () => this.viewer.fit(),
        },
        ["全体"],
      ),
      el(
        "button",
        {
          type: "button",
          "aria-pressed": String(this.viewer.showEdges),
          title: "面の稜線を重ねる",
          onclick: () => {
            this.viewer.showEdges = !this.viewer.showEdges;
            this.viewer.requestRender();
            ctx.refresh();
          },
        },
        ["稜線"],
      ),
      el(
        "button",
        {
          type: "button",
          "aria-pressed": String(this.viewer.camera.mode === "ortho"),
          title: "平行投影に切り替える",
          onclick: () => {
            this.viewer.camera.mode =
              this.viewer.camera.mode === "ortho" ? "perspective" : "ortho";
            this.viewer.requestRender();
            ctx.refresh();
          },
        },
        ["平行"],
      ),
      // **回す中心。** カメラだけの話で、メッシュにもピックにも触らない
      el(
        "select",
        {
          class: "orbit-center",
          title: "ドラッグで回すときの中心",
          onchange: (e: Event) => {
            // **選んだその場で 1 回効かせる。** 押すたびに効かせると、
            // 人が動かしたカメラを毎回取り消すことになる
            this.viewer.setOrbitCenter(
              (e.target as HTMLSelectElement).value as OrbitCenter,
            );
          },
        },
        (Object.keys(ORBIT_CENTER_LABELS) as OrbitCenter[]).map((k) =>
          el(
            "option",
            {
              value: k,
              selected: this.viewer.orbitCenter === k ? "" : undefined,
            },
            [ORBIT_CENTER_LABELS[k]],
          ),
        ),
      ),
      el(
        "button",
        {
          type: "button",
          title: "目線の高さに下りて歩き回る視点にする",
          onclick: () => {
            this.viewer.flyOverHere();
            ctx.refresh();
          },
        },
        ["歩く"],
      ),
    );

    // **3D の中で 2 点間を測る。** 仕様は 3D の節に「距離計測ボタン押下／
    // 始点 / 終点をタップ」と書いている。測った結果は 2D の計測と同じ実体になる
    if (!ctx.can.edit) return;
    const measuring = this.viewer.tool3d === this.viewer.measure;
    this.host.append(
      el(
        "button",
        {
          type: "button",
          "aria-pressed": String(measuring),
          title: "3D の中で 2 点間の距離を測る（面の上の 2 点をクリック）",
          onclick: () => {
            ctx.setTool3D(measuring ? null : this.viewer.measure);
            ctx.refresh();
          },
        },
        ["計測"],
      ),
    );

    // **3D の中でコメントを置く。** シーンには入らない（ホストの持ち物）
    const commenting = this.viewer.tool3d === this.viewer.comment;
    this.host.append(
      el(
        "button",
        {
          type: "button",
          "aria-pressed": String(commenting),
          title: "3D の中でコメントを置く（面にカーソルを合わせてクリック）",
          onclick: () => {
            ctx.setTool3D(commenting ? null : this.viewer.comment);
            ctx.refresh();
          },
        },
        ["コメント"],
      ),
    );

    // **3D の中にソリッドを置く。** 2D のツールバーには出さない——
    // 3D でしか意味を持たない道具なので、3D のビュータブに置く
    if (ctx.mode !== "pro") return;
    const placing = this.viewer.tool3d === this.viewer.place;
    this.host.append(
      el(
        "button",
        {
          type: "button",
          "aria-pressed": String(placing),
          title: "3D の中に基本形状を置く（面にカーソルを合わせてクリック）",
          onclick: () => {
            ctx.setTool3D(placing ? null : this.viewer.place);
            ctx.refresh();
          },
        },
        ["置く"],
      ),
    );
    // **作図面の上に多角形を描く。** 描いた瞬間に押し出した立体になる
    const drawing = this.viewer.tool3d === this.viewer.draw;
    this.host.append(
      el(
        "button",
        {
          type: "button",
          "aria-pressed": String(drawing),
          title:
            "作図面の上に多角形を描いて立体にする（1 点目か右クリックで閉じる）",
          onclick: () => {
            ctx.setTool3D(drawing ? null : this.viewer.draw);
            ctx.refresh();
          },
        },
        ["描く"],
      ),
    );
    if (drawing) {
      this.host.append(
        el("input", {
          type: "number",
          class: "draw-height",
          title: "立ち上げる高さ (mm)",
          value: String(this.viewer.draw.height),
          min: "1",
          step: "100",
          onchange: (e: Event) => {
            const v = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(v)) this.viewer.draw.height = Math.max(1, v);
          },
        }),
      );
    }

    if (!placing) return;
    this.host.append(
      el(
        "select",
        {
          class: "solid-kind",
          title: "置くソリッドの種類",
          onchange: (e: Event) => {
            this.viewer.place.kind = (e.target as HTMLSelectElement)
              .value as FixtureKind;
            this.viewer.requestRender();
          },
        },
        fixtureKindsOf("solid").map((k) =>
          el(
            "option",
            {
              value: k,
              selected: this.viewer.place.kind === k ? "" : undefined,
            },
            [FIXTURE_SPECS[k].label],
          ),
        ),
      ),
    );
  }
}
