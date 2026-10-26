import type { Binding } from './keymap.ts';
import type { Section } from './panel.ts';
import type { Capabilities } from '../host.ts';
import { BOTH_MODES, PRO_ONLY, type Mode } from './mode.ts';
import { BlocksSection } from './panels/sections/blocks.ts';
import { ConstraintsSection } from './panels/sections/constraints.ts';
import { LayersSection } from './panels/sections/layers.ts';
import { LibrarySection } from './panels/sections/library.ts';
import { MissingSection } from './panels/sections/missing.ts';
import { RoomsSection } from './panels/sections/rooms.ts';
import { SelectionSection } from './panels/sections/selection.ts';
import { SettingsSection } from './panels/sections/settings.ts';
import { SheetSection } from './panels/sections/sheet.ts';
import { ShortcutsSection } from './panels/sections/shortcuts.ts';
import { StandardSection } from './panels/sections/standard.ts';
import { StatsSection } from './panels/sections/stats.ts';

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
  layers: { make: () => new LayersSection(), modes: BOTH_MODES, edits: false },
  blocks: { make: () => new BlocksSection(), modes: BOTH_MODES, edits: true },
  settings: { make: () => new SettingsSection(), modes: BOTH_MODES, edits: false },
  stats: { make: () => new StatsSection(), modes: BOTH_MODES, edits: false },
  missing: { make: () => new MissingSection(), modes: PRO_ONLY, edits: false },
  shortcuts: { make: (deps) => new ShortcutsSection(deps.bindings), modes: BOTH_MODES, edits: false },
};

/** そのモードとできることで出す区画を順に作る。並びは表のキーの順 */
export function buildSections(deps: SectionDeps, mode: Mode, can: Capabilities): Section[] {
  return Object.values(SECTION_REGISTRY)
    .filter((entry) => entry.modes.includes(mode))
    .filter((entry) => can.edit || !entry.edits)
    .map((entry) => entry.make(deps));
}
