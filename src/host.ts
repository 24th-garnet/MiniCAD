import type { EntityRef, Scene } from './core/types.ts';
import type { CommentAnchor } from './core/annotation.ts';
import type { SceneFile } from './io/scene.ts';
import type { MeasuresFile } from './io/measures.ts';
import type { BlockDef } from './core/block.ts';
import type { Mode } from './ui/mode.ts';
import type { CameraParams } from './render3d/camera.ts';

/**
 * ホストとの境界。[docs/host.md](../docs/host.md) が決めた契約の型。
 *
 * **MiniCAD は組み込みエディタに徹する。** 認証・案件・保存・版管理・
 * コメントの通信・ライブラリのマスタはホストが持つ。ここにあるのは、
 * その分担を型にしたものだけ。
 *
 * **そして MiniCAD は単体でも動く。** `src/main.ts` が最初の利用者で、
 * ホストの役を自分で演じている（前回の続きを渡し、変更を localStorage に保存する）。
 * 契約が飾りにならないように、既定の立ち上げ方そのものを契約の上に載せてある。
 */

/** ホストが MiniCAD に渡すもの */
export interface MountOptions extends HostCallbacks {
  /** 最初に開く図面。省略すると空から始まる */
  scene?: SceneFile | Scene;
}

export interface HostCallbacks {
  /** 通常モードかプロモードか。省略すると通常モード */
  mode?: Mode;

  /** できること。省略すると全部できる */
  capabilities?: Partial<Capabilities>;

  /** 挿せる部品と素材。**マスタはホストが持つ。** 省略すると図面が持つものだけ */
  catalogs?: HostCatalogs;

  /**
   * コメントのアンカー。**本文はホストが持つ。**
   * MiniCAD は点を描き、当たり判定をし、クリックを返すだけ
   */
  comments?: CommentAnchor[];

  /** コメントのバッジを叩いた。ホストが自分のポップアップを開く */
  onCommentOpen?(id: string): void;

  /**
   * 新しいコメントを置いた。**まだ本文は無い。**
   * ホストが本文を聞いて、`setComments` で確定した一覧を返す
   */
  onCommentPlace?(anchor: CommentAnchor): void;

  /**
   * 図面が変わった。**保存するかどうかはホストが決める。**
   *
   * 呼ばれるのは図面が本当に変わったときだけで、選択やホバーでは呼ばれない。
   * 連続したドラッグの途中でも呼ばれるので、まとめたいならホスト側で遅らせる。
   */
  onChange?(scene: SceneFile): void;

  /** 選択が変わった。インスペクタをホスト側に出したいときに使う */
  onSelectionChange?(refs: EntityRef[]): void;

  /**
   * ウォークスルーに入った／出たとき。
   *
   * MiniCAD の中の「解除」でも出られるので、ホストが自分のボタンの見た目を
   * 合わせられるように知らせる。**出入りのときだけ**で、歩いているあいだは
   * 鳴らない（カメラが要るなら `getCamera()` を読む）。
   */
  onWalkthroughChange?(on: boolean): void;
}

/** `mount()` が返すもの。ホストから MiniCAD を触る窓口 */
export interface MiniCad {
  /** いまの図面。保存はホスト */
  getScene(): SceneFile;
  /** 図面を差し替える。履歴は捨てる */
  setScene(file: SceneFile | Scene): void;
  /** 解決済みの幾何。`mdr-measures-1` */
  getMeasures(planId?: string): MeasuresFile;
  readonly mode: Mode;
  setMode(mode: Mode): void;

  /**
   * ウォークスルー（一人称で歩き回る）の出入り。
   *
   * ワイヤーの「ウォークスルー」ボタンは**ホストのメニュー**にあるので、
   * 外から入れられるようにしておく。入ると 3D 単独になり、道具は全部外れ、
   * 床をクリックで移動・ドラッグで見回すようになる。
   *
   * **録画と動画生成はここに含まない。** 分担表どおりホスト側のサービスの
   * 仕事で、MiniCAD が録画の口を持つと実行時依存ゼロと正面衝突する。
   */
  setWalkthrough(on: boolean): void;
  readonly walkthrough: boolean;
  /** コメントのアンカーを差し替える。図面には保存されない */
  setComments(list: CommentAnchor[]): void;
  /**
   * いま見えている絵を PNG にする。**保存はホスト。**
   * `view` を省略すると、出ているビュー（3D が見えていれば 3D）
   */
  capture(view?: '2d' | '3d'): Promise<Blob | null>;
  /**
   * カメラの引数。**ウォークスルーと AI パースへはこの形で渡す。**
   * レンダリングは MiniCAD の仕事ではない（実行時依存ゼロと正面衝突する）
   */
  getCamera(): CameraParams;
  setCamera(params: Partial<CameraParams>): void;
  /** 片付ける。DOM からも window からも自分の痕跡を消す */
  destroy(): void;
}

/**
 * ホストが許すこと。**権限の判断はホストがする。**
 * MiniCAD は真偽値を受け取って出し分けるだけで、「支店長権限」のような
 * 語彙は知らない。
 */
export interface Capabilities {
  /** false なら閲覧のみ。図面を書き換える経路が `Store` で全部止まる */
  edit: boolean;
  /** 書き出しのボタンを出すか */
  download: boolean;
  /** コメントを付けられるか。**まだ何にも効かない**（コメント自体が無い） */
  comment: boolean;
}

export function defaultCapabilities(): Capabilities {
  return { edit: true, download: true, comment: true };
}


/**
 * ホストが渡すカタログ。**検索も公開もいいねも DL 数もホストの仕事**で、
 * MiniCAD は絞り込み済みの一覧を受け取って挿すだけ。
 */
export interface HostCatalogs {
  library?: LibraryItem[];
  materials?: MaterialItem[];
}

/**
 * 挿せる部品 1 つ。
 *
 * **`block` と `scene` は別の仕組み。** `BlockDef` は DXF の `INSERT` に 1:1 で
 * 対応する本物のブロックで、**壁と建具は入れられない**（定義の中にノードグラフを
 * 置くと挿入ごとに複製が要り、部屋検出が壊れる）。壁を含む部品（「2LDK ベース図面」
 * のようなもの）は実体に展開して置くことになる。**まだ出来ていない。**
 */
export interface LibraryItem {
  /** ホストの識別子。MiniCAD は中身を解釈しない */
  id: string;
  label: string;
  /** 絞り込みはホストが済ませてから渡してもよい。見出しに使う */
  category?: string;
  /** 図形だけの部品 */
  block?: BlockDef;
  /** 壁を含む部品。置くとシンボルとして取り込まれ、壁や建具そのものに展開される */
  scene?: SceneFile;
}

/**
 * 素材 1 つ。**MiniCAD が持つのは不透明な `ref` と表示ヒントだけ。**
 * 物件種別・カテゴリ・グレード（松竹梅）の分類はホストの持ち物で、
 * MiniCAD のフィールドにはしない。分類が増えるたびに図面の形式が変わるのは割に合わない。
 */
export interface MaterialItem {
  ref: string;
  label: string;
  /** 3D の着色に使う表示ヒント */
  color?: string;
  /** 同上。URL */
  texture?: string;
}
