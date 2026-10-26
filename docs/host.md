# ホストとの境界 — 作図エディタを組み込む

3D/2D の図面を扱う業務アプリ（以下**ホスト**）に、MiniCAD を作図エディタとして
組み込むときの契約。何をホストが渡し、何が返るかを決める。

> **この文書はまだ実装されていない連携の設計。** 今の MiniCAD は
> `src/main.ts` が `document` に直接ぶら下がる単体アプリで、`mount()` は無い。
> 契約を先に書くのは、**何を持ち何を持たないか**が以降の設計の判断基準になるため。
> 実装は「ビューシェルとモード」の段で入る。

## 誰が何を持つか

| | 持つ側 |
|---|---|
| 作図・編集・3D 表示・スナップ・拘束 | **MiniCAD** |
| 図面の中身（シーン）の形式と往復 | **MiniCAD** |
| 解決済みの幾何（面積・周長・正味長・員数） | **MiniCAD** |
| 認証・アカウント・権限・案件・プラン | **ホスト** |
| ライブラリ／素材の**マスタ**（検索・公開・いいね・DL 数） | **ホスト** |
| コメントの本文・スレッド・メンション・通知・既読 | **ホスト** |
| 保存・版管理・排他制御・共同編集の調停 | **ホスト** |
| 写実レンダリング・AI・usdz/IGES/STEP の変換 | **ホスト側のサービス** |
| 単価・歩掛り・諸経費・消費税 | [QuantityTakeoff][qt] / [InteriorEstimation][ie] |

**MiniCAD は数量を拾わない。金額も出さない。** 幾何を知っているのはこちらだけなので
数にして渡すが、開口を差し引くかどうかも、どの仕上げを当てるかも積算の規約で、
現場ごとに動く。この線は [`src/io/measures.ts`](../src/io/measures.ts) の冒頭が
既に宣言していて、動かさない。

**MiniCAD は単体でも動く。** 組み込み可能にすることと、ホスト無しでは動かないことは
別。`npm run dev` はこれまで通り、ホスト無しで立ち上がり続ける。

## ホストが渡すもの

### 1. シーン

MiniCAD 自身の JSON（`format: 'minicad'`、現在 `version: 8`）。
形式は [`src/io/scene.ts`](../src/io/scene.ts) が持つ。

```ts
import { deserialize, serialize } from 'minicad/io/scene';
```

**`deserialize` は常に `emptyScene()` を土台にフィールド単位で埋める**ので、
古い版も新しい版も読める。未知のキーは黙って捨てる。

ホストが図面を持っていないとき（新規作成）は、渡さなくてよい。空から始まる。

### 2. ライブラリカタログ（任意）

挿入できる部品の一覧。**マスタはホストが持ち、MiniCAD は受け取って挿入するだけ。**

```ts
interface LibraryItem {
  id: string;            // ホストの識別子。MiniCAD は中身を解釈しない
  label: string;
  category: string;      // 絞り込みはホストが済ませてから渡してもよい
  scene?: SceneFile;     // 壁を含む部品（「2LDK ベース図面」など）
  block?: BlockDef;      // 図形だけの部品
}
```

**`scene` と `block` は別の仕組み。** `BlockDef` は DXF の `INSERT` に 1:1 で
対応する本物のブロックで、**壁と建具は入れられない**（定義の中にノードグラフを
置くと挿入ごとに複製が要り、部屋検出が壊れる）。壁を含む部品は
**実体に展開して置く**（スタンプ）。

### 3. 素材カタログ（任意）

```ts
interface MaterialItem {
  ref: string;           // ホストの識別子。MiniCAD は中身を解釈しない
  label: string;
  color?: string;        // 3D の着色に使う表示ヒント
  texture?: string;      // 同上。URL
}
```

**MiniCAD が持つのは不透明な `ref` と表示ヒントだけ。**
物件種別・カテゴリ・グレード（松竹梅）といった分類はホストの持ち物で、
MiniCAD のフィールドにはしない。分類が増えるたびに図面の形式が変わるのは割に合わない。

### 4. コメント（任意）

MiniCAD が持つのは**アンカーだけ** — どの座標に、どの実体に紐づいているか。

```ts
interface CommentAnchor {
  id: string;
  at: { x: number; y: number; z: number };   // mm
  ref?: EntityRef;                            // 紐づく実体（任意）
  badge: unknown;                             // ホストが描きたいものを不透明に渡す
}
```

本文・作成者・日時・リプライ・メンション・解決状態・メール通知は**すべてホスト**。
MiniCAD は点を置き、当たり判定をし、`badge` を表示し、クリックをホストに返す。

### 5. できることの指定

```ts
interface Capabilities {
  edit: boolean;        // false なら閲覧のみ
  download: boolean;    // 書き出しボタンを出すか
  comment: boolean;
}
```

**権限の判断はホストがする。** MiniCAD は真偽値を受け取って UI を出し分けるだけで、
「支店長権限」のような語彙は知らない。

## MiniCAD が返すもの

| | |
|---|---|
| シーン JSON | `serialize(scene)`。保存はホスト |
| 実測 JSON | `sceneToMeasures(scene, rooms, { planId })` → `mdr-measures-1`。[QuantityTakeoff][qt] が読む |
| DXF | `sceneToDxf(...)`。R12、mm 1:1。Jw_cad 用の Shift-JIS も |
| SVG | `sceneToSvg(...)`。用紙枠を出していれば実寸 |
| 立面図 | `sceneToElevations(scene)` → SVG |
| 印刷 | `buildPrintDocument(svg, standard)`。PDF はブラウザの「PDF として保存」 |
| キャプチャ | canvas → PNG |
| 変更の通知 | 編集のたびに発火。保存するかどうかはホストが決める |

**PDF は書かない。** 日本語を PDF に埋めるには CID フォントのサブセット埋め込みが
要り、「実行時の依存ライブラリなし」と正面衝突する。SVG と実寸印刷を出すので、
変換が要るならホスト側で。README が JWW と DWG に当てているのと同じ理屈。

## 守ってほしいこと

| | |
|---|---|
| **単位は mm、y 軸は上向き** | 建築図面の流儀。画面への y 反転は `Viewport` だけが担当する |
| **id は書き換えない** | 選択・仕上げ・コメントは id に付く。振り直すと**選んだ壁紙が黙って別の壁に移る** |
| **シーンを部分的に書き換えない** | 往復は `deserialize` / `serialize` を通す。手で組んだ JSON は参照の整合性検査に落ちる |
| **`ref` と `materialRef` の中身は MiniCAD が決めない** | ホストの識別子をそのまま運ぶ。意味を持たせない |

## まだ無いもの

実装されていないものを、実装されていないと書く。

- **`mount()` そのもの。** 今の `App` は `document` と `index.html` の id に直結している
- **モードの切替**（通常／プロ）。今はツールが全部出る
- **3D での編集。** 今の 3D は見るだけ
- **素材。** 3D の色は [`src/render/theme.ts`](../src/render/theme.ts) の定数 5 色
- **積算対象の指定。** 実測 JSON は室ごとの集計までで、面ごと・物ごとには出していない
- **コメントと計測の保存。** 計測は今その場限りで、保存されない
- **画層ごとの縮尺と透過。** 縮尺は図面に 1 つ、透過は持っていない
- **複数階。** `Level` は 1 つだけ

[qt]: https://github.com/24th-garnet/QuantityTakeoff
[ie]: https://github.com/24th-garnet/InteriorEstimation
