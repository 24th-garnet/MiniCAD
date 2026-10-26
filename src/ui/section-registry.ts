import type { Binding } from './keymap.ts';
import type { Section } from './panel.ts';
import { BlocksSection } from './panels/sections/blocks.ts';
import { ConstraintsSection } from './panels/sections/constraints.ts';
import { LayersSection } from './panels/sections/layers.ts';
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
  | 'constraints'
  | 'rooms'
  | 'standard'
  | 'sheet'
  | 'layers'
  | 'blocks'
  | 'settings'
  | 'stats'
  | 'shortcuts';

/** 区画を作るのに要るもの。`App` が持っていて区画からは見えないもの */
export interface SectionDeps {
  bindings: Binding[];
}

export interface SectionEntry {
  make(deps: SectionDeps): Section;
}

export const SECTION_REGISTRY: Record<SectionId, SectionEntry> = {
  selection: { make: () => new SelectionSection() },
  constraints: { make: () => new ConstraintsSection() },
  rooms: { make: () => new RoomsSection() },
  standard: { make: () => new StandardSection() },
  sheet: { make: () => new SheetSection() },
  layers: { make: () => new LayersSection() },
  blocks: { make: () => new BlocksSection() },
  settings: { make: () => new SettingsSection() },
  stats: { make: () => new StatsSection() },
  shortcuts: { make: (deps) => new ShortcutsSection(deps.bindings) },
};

/** 出す区画を順に作る。並びは表のキーの順 */
export function buildSections(deps: SectionDeps): Section[] {
  return Object.values(SECTION_REGISTRY).map((entry) => entry.make(deps));
}
