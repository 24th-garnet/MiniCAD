import { el } from '../../dom.ts';
import { PRO_NOT_YET } from '../../mode.ts';
import type { PanelContext, Section } from '../../panel.ts';

/**
 * プロモードがワイヤーの通りには出来ていないことを、画面に出す。
 *
 * **持っていないものは、持っていないと書く。** 立面図の但し書き、実測 JSON の
 * `basis` 語彙、DXF の欠字報告と同じ扱い。黙って無いより、無いと書いてある方が
 * 使う側の判断が早い。
 *
 * 中身が埋まったらこの区画は消える。消えることが進捗の印になる。
 */
export class MissingSection implements Section {
  render(_ctx: PanelContext): (HTMLElement | null)[] {
    return [
      el('h2', {}, ['まだ無いもの']),
      el('p', { class: 'warn-note' }, [
        'ワイヤーのプロモードは汎用ソリッドの作図を求めていますが、まだありません。'
        + '壁・建具・家具の編集は通常モードと同じように使えます。',
      ]),
      el('ul', { class: 'missing-list' }, PRO_NOT_YET.map((item) => el('li', {}, [item]))),
    ];
  }
}
