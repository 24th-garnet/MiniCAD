# ホストとの境界 — 作図エディタを組み込む

3D/2D の図面を扱う業務アプリ（以下**ホスト**）に、MiniCAD を作図エディタとして
組み込むときの契約。何をホストが渡し、何が返るかを決める。

> **入口は実装されている。** [`src/mount.ts`](../src/mount.ts) の `mount()` と
> [`src/host.ts`](../src/host.ts) の型がこの文書の契約そのもの。
> カタログとできることの指定（`Capabilities`）はまだ受け取れない。下の「まだ無いもの」を参照。

## 入口

```ts
import { mount } from 'minicad/mount';

const cad = mount(document.getElementById('editor')!, {
  scene: await loadFromServer(),        // SceneFile か Scene。省略すると空から
  mode: 'normal',                        // 省略すると通常モード
  capabilities: { edit: false },         // 省略すると全部できる
  catalogs: { library, materials },      // 省略すると図面が持つものだけ
  onChange: (file) => void save(file),   // 図面が本当に変わったときだけ
  onSelectionChange: (refs) => show(refs),
});

cad.getScene();          // SceneFile。保存はホスト
cad.setScene(file);      // 差し替え。deserialize を通るので整合性検査が走る
cad.getMeasures('p-1');  // mdr-measures-1
cad.setMode('pro');
cad.destroy();           // DOM からも window からも痕跡を消す
```

**渡した要素の中に骨組みが組まれる。** 高さはホストが決める（MiniCAD は
貰った箱いっぱいに広がる）。

**`onChange` は図面が変わったときだけ呼ばれる。** 選択やホバーでは呼ばれない。
連続したドラッグの途中では呼ばれるので、まとめたいならホスト側で遅らせる
（単体の `src/main.ts` は 600ms 遅らせて localStorage に書いている）。

**`destroy()` を必ず呼ぶ。** DOM を消すだけでは `window` の keydown
（キーマップと 3D の Esc）も `ResizeObserver` も止まらず、外したはずの
エディタがキーを食べ続ける。

**単体の立ち上げ（`src/main.ts`）がこの契約の最初の利用者。**
図面を渡し、変わったら保存する——ホストに頼んでいることと同じことを自分でやっている。
契約が飾りにならないように、既定の立ち上げ方そのものを契約の上に載せてある。

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

**`edit: false` の保証は画面ではなく `Store` が持つ。** 道具やボタンを消すのは
行き止まりを減らすためで、保証にはならない——インスペクタの入力欄も、ドラッグも、
ショートカットも、それぞれ別の経路で書きに来る。`commit` / `commitFrom` /
`undo` / `redo` は図面を書き換える経路の全部なので、そこで 1 回止めれば漏れない。
表示の設定（スナップ・グリッド）は図面の中身ではないので止めない。

**`edit` と `download` は別。** ワイヤーでもダウンロードは有料アカウントの権利で、
閲覧しかできない人が持ち帰れることも、編集できる人が持ち帰れないこともある。

`comment` は**まだ何にも効かない**。コメント自体がないため。

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

- **スタイルの隔離。** `style.css` には `html, body` と `*` への指定が残っていて、
  ホストのページにも効いてしまう
- **汎用ソリッドの作図**（直方体・円筒・押し出し・プッシュ/プル・ブーリアン）。
  ワイヤーのプロモードの中身にあたる。プロモードの画面に「まだ無いもの」として出している
- **3D での作図。** 既にあるものを選んで動かすところまでは出来ていますが、新しく描くことはできません
- **素材の表示。** カタログは受け取りますが、**まだ誰も読んでいません**。実体は
  `materialRef` を持てますが、3D の色は [`src/render/theme.ts`](../src/render/theme.ts) の定数 5 色のまま
- **壁を含む部品の挿入。** カタログの `scene` 欄は受け取って画面には出しますが、
  挿せません（押せないボタンとして、挿せないと書いて出します）
- **3D の床の穴。** 吹抜は平面に出て床面積からも引かれますが、3D の床は抜けていません
- **積算対象の指定。** 実体は `takeoff` を持てますが、実測 JSON はまだ室ごとの集計までで、面ごと・物ごとには出していない
- **コメントと計測の保存。** 計測は今その場限りで、保存されない
- **画層ごとの縮尺と透過。** 縮尺は図面に 1 つ、透過は持っていない
- **階を切り替える画面。** データは複数階を持てますが、作業中の階を変える UI がまだありません

[qt]: https://github.com/24th-garnet/QuantityTakeoff
[ie]: https://github.com/24th-garnet/InteriorEstimation
