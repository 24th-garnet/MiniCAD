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
        'ワイヤーが求めている 3D の道具はひと通りあります（ソリッド・押し出し・'
        + 'プッシュ/プル・ブーリアン・3D の作図・計測・コメント）。'
        + '下の 2 つはワイヤーに記述が無く、倣うかどうかを決めていないものです。',
      ]),
      el('ul', { class: 'missing-list' }, PRO_NOT_YET.map((item) => el('li', {}, [item]))),
    ];
  }
}
