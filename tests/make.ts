import { defaultAttrs } from '../src/core/attrs.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { newId, type Id, type Opening, type OpeningKind } from '../src/core/types.ts';

/**
 * テスト用の実体の組み立て。
 *
 * **欄が増えたときに直すのが 1 箇所で済むように置いている。** 建具のリテラルは
 * 7 つのテストファイルが手で書いていて、`Opening` に必須の欄を足すたびに
 * 全部が落ちていた。既定を持つ組み立て関数にすれば、足すのはここだけになる。
 *
 * ファイル名を `*.test.ts` にしないのは `node --test tests/` に拾わせないため
 * （`stub-context.ts` と同じ）。
 */

/** 建具 1 つ。渡さなかった欄は既定に落ちる */
export function makeOpening(
  wallId: Id,
  over: Partial<Omit<Opening, 'wallId'>> & { kind: OpeningKind; offset: number; width: number },
): Opening {
  return {
    id: newId('o'),
    wallId,
    flipX: false,
    flipY: false,
    sillHeight: null,
    bay: null,
    designation: '',
    leaves: 2,
    height: null,
    layerId: LAYER_IDS.opening,
    attrs: defaultAttrs(),
    ...over,
  };
}
