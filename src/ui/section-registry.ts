import type { Binding } from './keymap.ts';
import type { Section } from './panel.ts';
import type { Capabilities } from '../host.ts';
import type { IconName } from './icon.ts';
import { BOTH_MODES, PRO_ONLY, type Mode } from './mode.ts';
import { BlocksSection } from './panels/sections/blocks.ts';
import { ConstraintsSection } from './panels/sections/constraints.ts';
import { LayersSection } from './panels/sections/layers.ts';
import { LevelsSection } from './panels/sections/levels.ts';
import { LibrarySection } from './panels/sections/library.ts';
import { MissingSection } from './panels/sections/missing.ts';
import { RoomsSection } from './panels/sections/rooms.ts';
import { SelectionSection } from './panels/sections/selection.ts';
import { SettingsSection } from './panels/sections/settings.ts';
import { SheetSection } from './panels/sections/sheet.ts';
import { ShortcutsSection } from './panels/sections/shortcuts.ts';
import { StandardSection } from './panels/sections/standard.ts';
import { StatsSection } from './panels/sections/stats.ts';
import { ViewsSection } from './panels/sections/views.ts';

/**
 * インスペクタに何の区画を出すかの表。考え方は `tool-registry.ts` と同じで、
 * **閉じた union を `Record` のキーにして書き忘れを型検査で止める**。
 */
/** インスペクタの区画。`ToolId` と同じく閉じた union にして書き忘れを止める */
export type SectionId =
  | 'selection'
  | 'library'
  | 'constraints'
  | 'rooms'
  | 'standard'
  | 'sheet'
  | 'views'
  | 'levels'
  | 'layers'
  | 'blocks'
  | 'settings'
  | 'stats'
  | 'missing'
  | 'shortcuts';

/** 区画を作るのに要るもの。`App` が持っていて区画からは見えないもの */
export interface SectionDeps {
  bindings: Binding[];
}

export interface SectionEntry {
  make(deps: SectionDeps): Section;
  /** どのモードで出すか */
  modes: readonly Mode[];
  /** 図面を書き換えるための区画か。閲覧のみのときは出さない */
  edits: boolean;
}

export const SECTION_REGISTRY: Record<SectionId, SectionEntry> = {
  selection: { make: () => new SelectionSection(), modes: BOTH_MODES, edits: true },
  // 通常モードの中心。パーツを選んで置く
  library: { make: () => new LibrarySection(), modes: BOTH_MODES, edits: true },
  // 幾何拘束・製図規格・用紙枠は CAD 寄りの道具立て。通常モードでは出さない
  constraints: { make: () => new ConstraintsSection(), modes: PRO_ONLY, edits: true },
  rooms: { make: () => new RoomsSection(), modes: BOTH_MODES, edits: false },
  standard: { make: () => new StandardSection(), modes: PRO_ONLY, edits: true },
  sheet: { make: () => new SheetSection(), modes: PRO_ONLY, edits: true },
  // 図面ビューは画層の上に乗るので、画層より先に出す
  views: { make: () => new ViewsSection(), modes: BOTH_MODES, edits: true },
  // 階は 2D が何を描くかを決めるので、画層より先に出す。
  // **閲覧のみでも出す**——切り替えだけはできないと、2 階を見てもらえない
  levels: { make: () => new LevelsSection(), modes: BOTH_MODES, edits: false },
  layers: { make: () => new LayersSection(), modes: BOTH_MODES, edits: false },
  blocks: { make: () => new BlocksSection(), modes: BOTH_MODES, edits: true },
  settings: { make: () => new SettingsSection(), modes: BOTH_MODES, edits: false },
  stats: { make: () => new StatsSection(), modes: BOTH_MODES, edits: false },
  missing: { make: () => new MissingSection(), modes: PRO_ONLY, edits: false },
  shortcuts: { make: (deps) => new ShortcutsSection(deps.bindings), modes: BOTH_MODES, edits: false },
};

/**
 * 右の欄をどの束に入れるか。
 *
 * **14 区画を 1 本のスクロールに積むのをやめる。** 壁を 1 枚選ぶと
 * 「プロパティ」だけで 15 欄あり、パーツも画層も製図規格も、その下へ
 * 流れていって見えなかった。レールで束を選び、選んだ束だけを出す。
 *
 * 倣い先は `ワイヤー/クライアント/ベース図面.html` の左レール（`.rail-icon`）。
 * **ワイヤーは左、こちらは右**——MiniCAD の左列は道具帯で、両方を左に積むと
 * キャンバスが 1076 → 844px まで痩せる。左＝作るもの、右＝調べるものという
 * いまの読み方もそのまま保てる。
 *
 * `Record` にしてあるので、**区画を足して束を書き忘れるとコンパイルエラー**になる。
 * `TOOL_REGISTRY` と同じ作法。
 */
export type PaneId = 'properties' | 'parts' | 'layers' | 'sheet' | 'info';

export const SECTION_PANE: Record<SectionId, PaneId> = {
  // 選んでいるものと、いま見ている階。ワイヤーの右パネルがこの 2 つ
  selection: 'properties',
  levels: 'properties',
  // 図面に足すもの
  library: 'parts',
  // 何がどの画層に乗っていて、何が固定されているか
  layers: 'layers',
  constraints: 'layers',
  // 書き出すもの・規格・用紙・作図の決まり
  views: 'sheet',
  standard: 'sheet',
  sheet: 'sheet',
  settings: 'sheet',
  // 図面に何があるかと、手引き
  rooms: 'info',
  blocks: 'info',
  stats: 'info',
  missing: 'info',
  shortcuts: 'info',
};

export interface PaneSpec {
  label: string;
  /** レールのアイコン。`icon.ts` の名前 */
  icon: IconName;
}

/** レールの並びはこの表のキー順。**先頭が既定** */
export const PANE_SPECS: Record<PaneId, PaneSpec> = {
  properties: { label: 'プロパティ', icon: 'properties' },
  parts: { label: 'パーツ', icon: 'parts' },
  layers: { label: '画層', icon: 'layers' },
  sheet: { label: '図面', icon: 'sheet' },
  info: { label: '情報', icon: 'info' },
};

export const PANE_IDS = Object.keys(PANE_SPECS) as PaneId[];

/** その束にいま出せる区画があるか。**空の束はレールに出さない** */
export function paneHasSections(pane: PaneId, mode: Mode, can: Capabilities): boolean {
  return entriesFor(mode, can).some(([id]) => SECTION_PANE[id] === pane);
}

/**
 * そのモードとできることで出す区画を順に作る。並びは表のキーの順。
 *
 * `pane` を渡すとその束だけ。渡さなければ全部——**試験が全区画を
 * 一度に見たいときのため**に残してある。
 */
export function buildSections(
  deps: SectionDeps,
  mode: Mode,
  can: Capabilities,
  pane?: PaneId,
): Section[] {
  return entriesFor(mode, can)
    .filter(([id]) => pane === undefined || SECTION_PANE[id] === pane)
    .map(([, entry]) => entry.make(deps));
}

function entriesFor(mode: Mode, can: Capabilities): [SectionId, SectionEntry][] {
  return (Object.entries(SECTION_REGISTRY) as [SectionId, SectionEntry][])
    .filter(([, entry]) => entry.modes.includes(mode))
    .filter(([, entry]) => can.edit || !entry.edits);
}
