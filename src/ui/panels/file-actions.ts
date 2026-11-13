import { emptyScene } from "../../core/types.ts";
import { downloadDxf, exportLossReport } from "../../io/dxf.ts";
import { sceneToDxf3d } from "../../io/dxf3d.ts";
import { sectionAlong, sectionToSvg } from "../../io/section.ts";
import { measuresToJson, sceneToMeasures } from "../../io/measures.ts";
import {
  elevationToSvg,
  roomElevationsToSvg,
  sceneToElevations,
  sceneToRoomElevations,
} from "../../io/elevation.ts";
import {
  clearLocal,
  deserialize,
  downloadJson,
  triggerDownload,
} from "../../io/scene.ts";
import { sampleScene } from "../../io/sample.ts";
import { sceneToSvg } from "../../io/svg.ts";
import { buildPrintDocument, printDocument } from "../../io/print.ts";
import { el, selectField } from "../dom.ts";
import { dialogText, openDialog } from "../dialog.ts";
import { openDxfImport } from "./dxf-import.ts";
import type { Panel, PanelContext } from "../panel.ts";

/**
 * 上部バーのファイル操作。
 *
 * **押しボタンを並べず、メニューに畳む。** 13 個を横に並べると、作図領域が
 * 狭いとき（コメント欄を出した埋め込みなど）に 2 段へ折り返して読めなく
 * なる。一般の CAD（Jw_cad・LibreCAD・QCAD）は**メニューバー**を持つので、
 * 畳み方もそれに倣って「ファイル / 書き出し / 表示」の 3 つにする。
 *
 * **閲覧のみのときは中身ごと消える。** 空のメニューは出さない——押しても
 * 何も入っていない口は、壊れていると見える。
 */
export class FileActions implements Panel {
  constructor(private readonly host: HTMLElement) {}

  build(ctx: PanelContext, signal?: AbortSignal): void {
    const button = (label: string, onClick: () => void, title?: string) =>
      el(
        "button",
        { type: "button", onclick: onClick, title: title ?? label },
        [label],
      );
    // 出さないものは `null` にして最後に落とす。`el` は null を無視する
    const when = (ok: boolean, node: HTMLElement) => (ok ? node : null);
    const canEdit = ctx.can.edit;
    const canDownload = ctx.can.download;

    const fileInput = el("input", {
      type: "file",
      accept: ".json,.dxf,application/json",
    });
    fileInput.style.display = "none";
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (!file) return;
      // DXF は設定を聞いてから取り込むので、JSON とは別経路にする
      if (file.name.toLowerCase().endsWith(".dxf")) {
        openDxfImport(ctx, file);
        return;
      }
      void file.text().then((text) => {
        try {
          ctx.loadScene(deserialize(JSON.parse(text)));
        } catch (err) {
          window.alert(`読み込めませんでした: ${(err as Error).message}`);
        }
      });
    });

    /**
     * 畳んだ口。**中身が 1 つも無ければ出さない。**
     *
     * `<details>` を使うのは、開け閉めの状態を DOM に持たせるため——
     * 自前で持つと、片付け（`destroy`）のときに取り残しが出る。
     */
    const menus: HTMLDetailsElement[] = [];
    const menu = (label: string, items: (HTMLElement | null)[]): HTMLElement | null => {
      const live = items.filter((node): node is HTMLElement => node !== null);
      if (live.length === 0) return null;
      const list = el("div", { class: "menu-list" }, live);
      const box = el("details", { class: "menu" }, [
        el("summary", { title: label }, [label]),
        list,
      ]) as HTMLDetailsElement;
      // 押したら閉じる。開いたままだと、次に何を押すのか分からなくなる
      list.addEventListener("click", () => void (box.open = false));
      menus.push(box);
      return box;
    };

    // **外を押したら閉じる。** `signal` で外すので `destroy()` に残らない
    this.host.ownerDocument.addEventListener(
      "pointerdown",
      (e) => {
        for (const m of menus) {
          if (m.open && !m.contains(e.target as Node)) m.open = false;
        }
      },
      { signal, capture: true },
    );

    this.host.append(
      ...[
        menu("ファイル", [
        when(
          canEdit,
          button("新規", () => {
            if (!window.confirm("現在の間取りを破棄して新規作成しますか？"))
              return;
            clearLocal();
            ctx.loadScene(emptyScene());
          }),
        ),
        when(
          canEdit,
          button("サンプル", () => {
            if (
              !window.confirm(
                "現在の間取りを破棄してサンプルを読み込みますか？",
              )
            )
              return;
            ctx.loadScene(sampleScene());
          }),
        ),
        when(
          canEdit,
          button("開く", () => fileInput.click(), "JSON / DXF を読み込む"),
        ),
        when(
          canDownload,
          button(
            "保存",
            () => downloadJson(ctx.editor.store.scene),
            "JSON で保存 (Cmd/Ctrl+S)",
          ),
        ),
        ]),

        menu("書き出し", [
        when(
          canDownload,
          button(
            "SVG",
            () => {
              const scene = ctx.editor.store.scene;
              const svg = sceneToSvg(
                scene,
                ctx.editor.rooms,
                ctx.editor.store.settings,
              );
              triggerDownload(
                new Blob([svg], { type: "image/svg+xml" }),
                "madori.svg",
              );
              // DXF と同じ報告。落ちるものは同じ
              const notes = exportLossReport(scene);
              if (notes.length > 0) window.alert(notes.join("\n\n"));
            },
            "SVG で書き出す",
          ),
        ),
        when(
          canDownload,
          button(
            "DXF",
            () => {
              const store = ctx.editor.store;
              const dropped = downloadDxf(
                store.scene,
                ctx.editor.rooms,
                store.settings,
                {
                  escapeUnicode: store.settings.dxfEscapeUnicode,
                  trueDimension: store.settings.dxfTrueDimension,
                  shiftJis: store.settings.dxfShiftJis,
                },
              );
              // **黙って落とさない。** 化けた室名や消えた透過が、受け取った側に
              // 理由の分からない違いとして出るのが一番困る
              const notes = exportLossReport(store.scene);
              if (dropped.length > 0) {
                const chars = [...new Set(dropped)].join("");
                notes.unshift(
                  `Shift-JIS に無い文字が ${dropped.length} 字ありました。` +
                    `「?」になっています: ${chars}`,
                );
              }
              if (notes.length > 0) window.alert(notes.join("\n\n"));
            },
            "DXF (R12) で書き出す — 他の CAD で開けます",
          ),
        ),
        when(
          canDownload,
          button(
            "数量",
            () => {
              const store = ctx.editor.store;
              const rooms = ctx.editor.rooms;
              if (rooms.length === 0) {
                window.alert("壁で閉じた部屋がありません。数量を拾えません。");
                return;
              }
              // 図面名は表題欄から取る。無ければ既定の名前
              const title =
                store.scene.sheet.titleBlock.fields.drawingName.trim();
              const planId = title.length > 0 ? title : "madori";
              const file = sceneToMeasures(store.scene, rooms, { planId });
              const blob = new Blob([measuresToJson(file)], {
                type: "application/json",
              });
              triggerDownload(blob, `${planId}.measures.json`);
            },
            "実測 JSON を書き出す — 数量拾いへ渡します",
          ),
        ),
        when(
          canDownload,
          button(
            "3D",
            () => {
              const scene = ctx.editor.store.scene;
              const got = sceneToDxf3d(scene, ctx.editor.rooms);
              if (got.faces === 0) {
                window.alert("3D に出るものがありません。");
                return;
              }
              triggerDownload(
                new Blob([got.text], { type: "application/dxf" }),
                "madori-3d.dxf",
              );
              // **近似したことも落としたことも書く**
              window.alert(
                `3D を ${got.faces} 面の DXF にしました。\n\n${got.notes.join("\n")}`,
              );
            },
            "3D を DXF (3DFACE) で書き出す",
          ),
        ),
        when(
          canDownload,
          button(
            "立面ビュー",
            () => openElevationView(ctx),
            "立面・断面・展開のどれを書き出すか選ぶ",
          ),
        ),
        when(
          canDownload,
          button(
            "印刷",
            () => {
              const scene = ctx.editor.store.scene;
              const svg = sceneToSvg(
                scene,
                ctx.editor.rooms,
                ctx.editor.store.settings,
              );
              if (!printDocument(buildPrintDocument(svg, scene.standard))) {
                window.alert(
                  "印刷用のウィンドウを開けませんでした。ポップアップの許可を確認してください。",
                );
              }
            },
            "実寸で印刷する（ブラウザから PDF として保存もできます）",
          ),
        ),
        when(
          canDownload,
          button(
            "キャプチャ",
            () => {
              void ctx.capture().then((blob) => {
                if (!blob) {
                  window.alert("いま見えている絵がありません。");
                  return;
                }
                triggerDownload(
                  blob,
                  ctx.view.shows3d ? "madori-3d.png" : "madori.png",
                );
              });
            },
            "いま見えている絵を PNG で保存する",
          ),
        ),
        ]),

        menu("表示", [
          button("全体表示", () => ctx.editor.zoomToFit(), "図面全体を表示 (0)"),
          button(
            "用紙に合わせる",
            () => ctx.editor.zoomToSheet(),
            "用紙全体が見えるように表示",
          ),
        ]),
        fileInput,
      ].filter((node) => node !== null),
    );
  }

  refresh(): void {
    // ファイル操作は状態に依存しないので描き直す必要がない
  }
}

/**
 * 立面ビュー。**1 ボタンから、どの図を書き出すかを選ばせる。**
 *
 * ワイヤーにこう書いてある。
 *
 * > 立面ビュー … 押下時、断面図、展開図どちらの機能を利用するか、
 * > ポップアップ等で選択が可能
 *
 * 立面（開口のある壁）も同じ仲間なので、3 つまとめてここから出す。
 *
 * **`window.confirm` は使わない**（`dialog.ts` が理由を書いている）。
 * 書き出せないときは**閉じずに**理由をダイアログの中に出す——
 * 閉じてから `alert` を出すと、選び直すのに押し直しになる。
 */
function openElevationView(ctx: PanelContext): void {
  let kind: ElevationKind = "elevation";
  const note = el("p", { class: "empty-note" }, [VIEWS[kind].hint]);
  const message = el("p", { class: "empty-note" }, [""]);

  const body: (HTMLElement | string)[] = [
    dialogText("どの図を SVG で書き出すか選んでください。"),
    selectField(
      "種類",
      kind,
      ELEVATION_KINDS.map((k) => ({ value: k, label: VIEWS[k].label })),
      (v) => {
        kind = v as ElevationKind;
        note.textContent = VIEWS[kind].hint;
        message.textContent = "";
      },
    ),
    note,
    message,
  ];

  openDialog("立面ビュー", body, [
    { label: "閉じる" },
    {
      label: "書き出す",
      primary: true,
      onClick: () => {
        const why = VIEWS[kind].run(ctx);
        if (why === null) return;
        message.textContent = why;
        return false;
      },
    },
  ]);
}

const ELEVATION_KINDS = ["elevation", "section", "development"] as const;
type ElevationKind = (typeof ELEVATION_KINDS)[number];

/**
 * 書き出せる図。**`run` は書き出せたら null、駄目なら理由を返す。**
 * `io/elevation.ts` と `io/section.ts` には触っていない——畳んだのは出口だけ。
 */
const VIEWS: Record<
  ElevationKind,
  { label: string; hint: string; run: (ctx: PanelContext) => string | null }
> = {
  elevation: {
    label: "立面図（開口のある壁）",
    hint: "開口のある壁を 1 面ずつ起こします。",
    run: (ctx) => {
      const scene = ctx.editor.store.scene;
      const got = sceneToElevations(scene);
      if (got.length === 0)
        return "開口のある壁がありません。立面を起こせません。";
      const svg = elevationToSvg(got, {
        scale: scene.standard.scale,
        dimensions: true,
      });
      triggerDownload(new Blob([svg], { type: "image/svg+xml" }), "rimen.svg");
      return null;
    },
  },
  section: {
    label: "断面図（選んだ線で切る）",
    // **切断線のツールは増やさない。** 選んだ線 1 本をそのまま使う作法を変えない
    hint: "線ツール（L）で切断線を 1 本引き、選んでから書き出します。",
    run: (ctx) => {
      const scene = ctx.editor.store.scene;
      const sel = ctx.editor.store.selection.filter((r) => r.type === "shape");
      const line = sel.length === 1 ? scene.shapes[sel[0].id] : null;
      if (!line || line.shape !== "line") {
        return "切断線にする線が選ばれていません。線ツール（L）で引いて、1 本だけ選んでください。";
      }
      const got = sectionAlong(scene, line.a, line.b);
      if (!got) return "その線は壁を横切っていません。";
      triggerDownload(
        new Blob([sectionToSvg(got, scene.standard.scale)], {
          type: "image/svg+xml",
        }),
        "danmen.svg",
      );
      return null;
    },
  },
  development: {
    label: "展開図（部屋ごと）",
    hint: "壁で閉じた部屋の内側を、面ごとに起こします。",
    run: (ctx) => {
      const scene = ctx.editor.store.scene;
      const got = sceneToRoomElevations(scene, ctx.editor.rooms);
      if (got.length === 0)
        return "壁で閉じた部屋がありません。展開図を起こせません。";
      const svg = roomElevationsToSvg(got, {
        scale: scene.standard.scale,
        dimensions: true,
      });
      triggerDownload(new Blob([svg], { type: "image/svg+xml" }), "tenkai.svg");
      return null;
    },
  },
};
