# 本番アプリへの移植

**MiniCAD は組み込みエディタです。** 本番のアプリケーションは別途作成されて
おり、確認が取れ次第そこへ移します。この文書は**移す人のための手引き**です。

契約そのものは [host.md](host.md)。ここは「何を持っていき、何を置いていき、
どこでつまずくか」だけを書きます。

---

## 1. 何を持っていくか

| | 持っていく | 理由 |
|---|---|---|
| `src/` | **○** | CAD そのもの。155 ファイル・36,571 行 |
| `docs/host.md` | **○** | 組み込みの契約。**これが仕様書** |
| `docs/coverage.md` / `questions.md` | **○** | 何がワイヤーの要求で、何を決めたか。移植先で問い直さないために要る |
| `docs/status.md` | **○** | いまどこまで出来ているか |
| `tests/` | **○** | 単体 1,087 件。**移植で壊れたら、ここが先に落ちる** |
| `tests/e2e/` | △ | Playwright。移植先の枠組みに合わせて書き直す前提 |
| `index.html` / `src/main.ts` / `src/standalone.css` | × | 単体で立ち上げるためだけのもの |
| **MiniCAD-host の `src/`** | **×** | React の画面。移植先が自前で持つ |
| **MiniCAD-host の `supabase/`** | **×** | 保存の設計。同上 |

**MiniCAD-host は捨ててよいのですが、読む値打ちはあります。**
「契約だけで保存・共有・コメント・衝突検出・更新ログが組めること」を実地で
示したものなので、**同じものを自前の基盤で作る**ときの見本になります。

---

## 2. 取り込み方

```ts
import { mount } from 'minicad/mount.ts';

const cad = mount(container, {
  scene: await loadFromServer(),      // SceneFile（保存した JSON）
  capabilities: { edit: true, download: true, comment: true },
  chrome: 'embedded',                 // 製品の名前を出さない
  onChange: (file) => void save(file),
});
// 画面から外すときは必ず
cad.destroy();
```

**依存は 0 個です。** `package.json` の `dependencies` が空で、three.js も
WebGL も使っていません（3D も Canvas 2D で描いています）。
ビルド後は **JS 390KB（gzip 133KB）＋ CSS 19KB（gzip 3.8KB）**。

**要るのは TypeScript と、ES2022 を吐けるバンドラだけ**です。
Vite でなくても構いません。

---

## 3. ホスト側が実装すること

契約の窓口と、それぞれで**向こうが受け持つこと**です。
括弧内は MiniCAD-host の実装（見本）。

| 窓口 | ホストの責務 | 見本 |
|---|---|---|
| `scene` / `onChange` | 保存。**まとめるのはホストの仕事**（MiniCAD はドラッグの途中でも鳴らす） | `components/Editor.tsx` |
| `setScene` | 版を戻す・図面を切り替える | `pages/ProjectEditor.tsx` |
| `capabilities` | 権限。`edit` / `download` / `comment` を**別々に**効かせる | `lib/share.ts` |
| `catalogs` | 部品と素材のマスタ。`ref` は**ホストの識別子をそのまま運ぶ** | `lib/api.ts` |
| `comments` / `onCommentPlace` / `onCommentOpen` | **本文・作成者・返信・解決はホストが持つ。** MiniCAD はアンカーだけ | `components/CommentPanel.tsx` |
| `getMeasures` | 積算へ渡す数量。MiniCAD は**単価も係数も持たない** | — |
| `setMode` | 通常 / プロの切り替え | `pages/ShareEditor.tsx` |
| `getCamera` / `setCamera` | AI パースへ渡すカメラ引数 | — |

---

## 4. つまずくところ

**ここが本題です。** どれも実際に踏んで直したものです。

### 4-1. `onChange` は読み込みでも鳴る

`mount` が `loadScene` を呼ぶので、**ただ開いただけの人が図面を書き換えた
ことになります。** 版を残す仕掛けがあるなら、開くたびに 1 つ食います。

**基準は「向こうに入っている形」ではなく「MiniCAD が読み終えた直後の形」**に
してください。`deserialize` → `serialize` を往復すると、同じ図面でも並びや
既定値の埋まり方が変わります。読み終えた直後の形は `mount` が返った直後に
取れます。

```ts
const cad = mount(el, { scene, onChange });
let saved = fingerprint(cad.getScene());   // ← ここが基準
```

### 4-2. `getScene()` は深い複製をしない

返ったものを持ち回すと、**次の編集で中身が変わります。** その場で文字列に
してから渡してください。

### 4-3. `destroy()` を必ず呼ぶ

DOM を消すだけでは `window` の keydown も `ResizeObserver` も止まりません。
**外したはずのエディタがキーを食べ続けます。**

### 4-4. 高さはホストが決める

MiniCAD は**貰った箱いっぱいに広がります。** `height` を指定しないと潰れます。
**箱の幅で組み替わります**（1024px を切ると右の欄が図面の上に浮く）。
これは `@container` で見ているので、**ホストの窓の幅ではなく箱の幅**です。

### 4-5. 保存の衝突

**契約には衝突検出の窓口がありません。** ホストが `onChange` と `setScene`
だけで組みます。MiniCAD-host の実装（`supabase/migrations/0007` 〜 `0008`）：

1. 図面に**版番号**を持たせる。**`updated_at` では使えません**——改名でも
   進むので、持ち主が名前を直しただけで編集者の保存が断られます
2. 保存時に、読み込んだ時点の版番号を添えて突き合わせる
3. 違っていたら**断って、人に選ばせる**（読み直す／自分のぶんで上書きする）

**PostgREST を使うなら、断りの SQLSTATE に `40001` を使わないでください。**
あれは「もう一度試せば通るかもしれない」の意味で、**自動で再試行されます**。
実測で断る側だけが **125 秒**かかってゲートウェイのタイムアウトになりました。
`PT409`（→ HTTP 409）なら再試行されません。

### 4-6. スタイル

`style.css` の規則は**全部 `.minicad` の下**にあり、ホストのページには
漏れません。トークンも `:root` ではなく `.minicad` にあるので、
**ホストが外から配色を差し替えられます**：

```css
.minicad { --accent: #c2410c; }
```

以前は漏れていて、`mount()` しただけでホストのページが巻けなくなり、
ボタンが全部 MiniCAD の見た目になっていました。
`tests/e2e/embed.html` が再発を見ています——**移植先でも同じ形の確認を
1 つ置いてください。**

### 4-7. 箱の寸法が変わるとき

倍率は保ち、**画面の中心にあったものを中心に残します**。ホストの欄が開いたり
窓が狭まったりすると箱が変わるので、ここが効きます。
2D・3D のキャンバスは自分で `ResizeObserver` を持っているので、
**知らせる窓口は要りません。**

---

## 5. 動く環境

| | |
|---|---|
| 描画 | **Canvas 2D のみ。** WebGL も three.js も使わない |
| `OffscreenCanvas` | **使っていません**（Safari に無いため） |
| `@container` | 使っています。**Safari 16 以降**が要ります |
| 保存形式 | `SceneFile`（JSON）。`deserialize` が参照の整合性を検査する |
| 文字コード | DXF は **Shift-JIS で書けます**（Jw_cad が読めるように） |

---

## 6. 移植後に最初に確かめること

1. **`npm test`（単体 1,087 件）が通るか。** 通らなければ、移植で何かが
   落ちています
2. **ホストのページが化けないか。** `tests/e2e/embed.html` と同じ形
   ——自前の見出し・ボタン・入力欄を持つページに `mount()` して、
   **それらが変わらないこと**
3. **開いただけで保存が走らないか**（4-1）
4. **`destroy()` のあと、キーボードが効かなくなっていないか**（4-3）

---

## 7. 残っているもの

[questions.md](questions.md) の A（お返事待ち）と C（これから作る）は
**どちらも 0 件**です。残るのは B（決めて作った 23 件）と D（やらない 8 件）
の記録だけ。

画面に出している「まだ無いもの」は **3D の中で線を描くこと**だけです
（多角形は描けます）。ホスト側で作らないと決めたものは
`coverage.md` の A-4 にあります。
