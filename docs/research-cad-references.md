# MiniCAD 参考CADソフト調査

調査日: 2026-10-07 / 目的: ブラウザで動く小さなCAD風Webアプリを作るにあたっての参考実装の洗い出し

---

## 1. 結論（先に）

- **UX・機能セットの手本** → **LibreCAD**（2D専用・素直な構成）と **QCAD**（スクリプト層が参考になる）
- **「拘束(constraint)」のお手本** → **Solvespace** / **FreeCAD Sketcher**
- **ブラウザ実装の手本** → **CADmium**（WASM+Svelte+three.js）、**Excalidraw**（MIT・データモデルが秀逸）
- **間取り用途** → **Sweet Home 3D** / **blueprint3d**
- **そのまま部品として使える** → **Maker.js**(Apache-2.0)、**planegcs**(LGPL)、**dxf-parser / dxf-writer**(MIT)

ライセンス的に**コードを引き写せる**のは MIT / Apache-2.0 のもののみ。GPL系（LibreCAD, QCAD, Solvespace, Sweet Home 3D）は
**挙動・UIの参考**に留め、実装は自前で起こすのが安全。

---

## 2. デスクトップ2D CAD（機能・UXの参考）

| ソフト | ライセンス | 言語 | Star | 参考ポイント |
|---|---|---|---|---|
| [LibreCAD](https://github.com/LibreCAD/LibreCAD) | GPL-2.0 | C++ | 6.4k | **第一の手本**。純2D。line/circle/arc/ellipse/spline、レイヤ、DXF読み書き、SVG/PDF出力。ツール階層とコマンドラインの作法がミニマルCADの正解形 |
| [QCAD](https://github.com/qcad/qcad) | GPL-3.0 (Community) | C++ | 1.9k | LibreCADの元祖。ECMAScriptでツールを書く設計（`scripts/`）が「ツールをプラグインとして足す」構造の参考になる。DWGは有償プラグイン |
| [Solvespace](https://github.com/solvespace/solvespace) | GPL-3.0 | C++ | 4.2k | **パラメトリック拘束**の最良の教材。コードが小さく、拘束ソルバの読み解きがしやすい |
| [FreeCAD](https://github.com/FreeCAD/FreeCAD) | LGPL-2.1 | C++ | 34k | 3Dだが **Sketcher ワークベンチ**の拘束UI（自動拘束・過拘束の検出表示）はそのまま参考になる |

### ここから盗むべき「CADらしさ」
1. **スナップ**: 端点 / 中点 / 交点 / 垂線の足 / グリッド / 近接点（オブジェクトスナップ = OSNAP）
2. **数値入力**: マウスで方向を決め、距離をキーボードで打つ（相対座標 `@100,0`、極座標 `@100<45`）
3. **レイヤ**: 色・線種・表示/非表示・ロック
4. **寸法線**: 線分長・角度・半径の自動追従
5. **選択モード**: 左→右ドラッグ=完全包含、右→左ドラッグ=交差選択
6. **モディファイ**: trim / extend / offset / fillet / mirror / array

---

## 3. ブラウザで動くCAD・描画エンジン（実装の参考）

| プロジェクト | ライセンス | 参考ポイント |
|---|---|---|
| [CADmium](https://github.com/CADmium-Co/CADmium) | 要確認 (NOASSERTION) | ブラウザ完結型CAD。Rust製カーネル `truck` を WASM 化 + SvelteKit + three.js + Threlte。`.step/.obj/.svg/.dxf` 出力。**アーキテクチャの最前線**（最終更新 2025-09） |
| [Excalidraw](https://github.com/excalidraw/excalidraw) | MIT | **データモデルとレンダリングの教科書**。`@excalidraw/element`(シーンモデル) / `@excalidraw/math`(幾何) の分離、fractional indexing による順序管理、無限キャンバス、undo/redo |
| [tldraw](https://github.com/tldraw/tldraw) | 独自ライセンス（商用は要配慮） | Editor API / カスタムシェイプ / バインディングの拡張設計。**読む価値は高いが依存は慎重に** |
| [JSCAD](https://github.com/jscad/OpenJSCAD.org) | MIT | コードで2D/3Dをパラメトリックに作る方向。CSG演算の実装が読める |
| [replicad](https://github.com/sgenoud/replicad) | MIT | OpenCascade(WASM)をJSから叩く。本格B-repをブラウザで、の最小例 |
| [Sweet Home 3D JS](https://www.sweethome3d.com/) | GPL-2.0 | 間取り作図→家具配置→3Dプレビュー。**madoribaの用途に直撃**。ブラウザ版あり |
| [blueprint3d](https://github.com/furnishup/blueprint3d) | MIT | three.js製の間取りエディタ。壁を引く→部屋が自動認識される実装が参考になる（更新停止: 2021） |

---

## 4. そのまま使える部品ライブラリ

| ライブラリ | ライセンス | 用途 |
|---|---|---|
| [Maker.js](https://github.com/microsoft/maker.js) | Apache-2.0 | **2D CAD幾何の決定版**。パス結合・交点・チェーン化・オフセット・DXF/SVG出力。MiniCADの幾何エンジンの第一候補 |
| [planegcs](https://github.com/Salusoft89/planegcs) (`@salusoft89/planegcs`) | LGPL-2.1 | FreeCADの2D拘束ソルバを WASM 移植。TS型定義付き。拘束機能を入れるならこれ一択 |
| [dxf-parser](https://www.npmjs.com/package/dxf-parser) | MIT | DXF読み込み |
| [dxf-writer](https://www.npmjs.com/package/dxf-writer) | MIT | DXF書き出し（line/polyline/arc/circle/text） |
| [three-dxf](https://github.com/gdsestimating/three-dxf) | MIT | dxf-parser の結果を three.js で描画 |
| [Konva](https://github.com/konvajs/konva) | MIT | Canvas 2Dのシーングラフ。ヒットテスト・レイヤ・変形ハンドルが標準装備 |
| [paper.js](https://github.com/paperjs/paper.js) | MIT | ベクタ幾何（ブーリアン演算・曲線交点）が強い。更新は鈍い(2024) |
| [three.js](https://github.com/mrdoob/three.js) | MIT | 3Dプレビューを足す場合 |

---

## 5. MiniCAD への推奨スコープ

**最小構成（CADらしさが出る最小単位）**

- 無限キャンバス（パン/ズーム、グリッド、mm単位のワールド座標）
- 描画ツール: 線 / ポリライン / 矩形 / 円 / 円弧
- **スナップ**: グリッド + 端点 + 中点 + 交点（これが有無でCAD感が決まる）
- **数値入力**: 長さ・角度の直接打ち込み、直交(Ortho)モード
- 選択 / 移動 / 複製 / 削除、undo/redo
- レイヤ（色・表示切替）
- 寸法線 1種（線分長）
- 保存: JSONシーン + SVG書き出し（余力があれば DXF 書き出し）

**技術選定の推奨**

- 描画: Canvas 2D 直書き or Konva。three.js は 2D CADにはオーバースペック
- 幾何: Maker.js を土台に、自前の交点/スナップ計算を薄く乗せる
- 状態: Excalidraw流の「フラットなentity配列 + 不変更新 + バージョン番号」
- 拘束は**最初は入れない**。入れるなら第2段階で planegcs

**明示的に捨てるもの**: DWG、3Dソリッド、B-rep、印刷レイアウト、ブロック/外部参照

---

## 6. ライセンス上の注意

- **GPL/LGPL（LibreCAD, QCAD, Solvespace, FreeCAD, Sweet Home 3D, planegcs）**
  → UI・機能・アルゴリズムの**考え方**を参考にするのは問題なし。コードのコピーは配布形態に制約がかかる。
  planegcs は LGPL なので「ライブラリとしてリンクして使う」分には比較的扱いやすい。
- **MIT / Apache-2.0（Excalidraw, Maker.js, blueprint3d, dxf-*, Konva, JSCAD, replicad）**
  → 著作権表示を残せばコード流用可。**まずここから探す**。
- **tldraw** は独自ライセンス。ウォーターマーク除去・商用利用に条件あり。参考閲覧に留めるのが無難。
