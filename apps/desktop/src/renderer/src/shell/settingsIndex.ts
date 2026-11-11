import { DESIGN_RULES } from '../../../shared/contract';
import type { SettingsSection } from '../state/store';
import { SHORTCUTS } from './shortcuts';

/**
 * Every option of the settings with its section, group and the translation keys of its name and
 * help text. The dialog renders its rows from these keys and the search reads the same ones, so
 * each option is findable and can be opened directly (`setSettingsSection(section, id)`).
 */
export interface SettingEntry {
  id: string;
  section: SettingsSection;
  group: string;
  label: string;
  /** Shortcuts have none. */
  hint?: string;
  /** Takes effect after a restart of PartBuddy. */
  restart?: boolean;
  /** Translation key of more words people search with ("colour" for the theme, audit N-04). */
  keywords?: string;
}

export const SETTINGS: readonly SettingEntry[] = [
  { id: 'language', section: 'general', group: 'appearance', label: 'settings.language.title', hint: 'settings.language.hint' },
  { id: 'theme', section: 'general', group: 'appearance', label: 'settings.theme.title', hint: 'settings.theme.hint', keywords: 'settings.keywords.theme' },
  { id: 'zoom', section: 'general', group: 'appearance', label: 'settings.zoom.title', hint: 'settings.zoom.hint', keywords: 'settings.keywords.zoom' },
  { id: 'startPage', section: 'general', group: 'startup', label: 'settings.startPage.title', hint: 'settings.startPage.hint' },
  { id: 'projectsFolder', section: 'general', group: 'files', label: 'settings.projects.title', hint: 'settings.projects.hint', restart: true, keywords: 'settings.keywords.projectsFolder' },
  { id: 'engine', section: 'solidcraft', group: 'program', label: 'engine.program', hint: 'settings.engine.hint', restart: true },
  { id: 'assistant', section: 'assistant', group: 'route', label: 'settings.route.title', hint: 'settings.route.hint' },
  { id: 'research', section: 'assistant', group: 'work', label: 'settings.research.label', hint: 'settings.research.hint' },
  { id: 'ollamaContext', section: 'assistant', group: 'work', label: 'settings.ollamaContext.label', hint: 'settings.ollamaContext.hint' },
  { id: 'toolDebug', section: 'assistant', group: 'work', label: 'settings.toolDebug.label', hint: 'settings.toolDebug.hint' },
  { id: 'localStepLimit', section: 'assistant', group: 'route', label: 'settings.localStepLimit.label', hint: 'settings.localStepLimit.hint' },
  { id: 'supportFree', section: 'assistant', group: 'rules', label: 'print.supportFree', hint: 'print.supportFreeHint' },
  ...DESIGN_RULES.map((rule) => ({ id: `design.${rule}`, section: 'assistant' as const, group: 'rules', label: `print.design.${rule}.label`, hint: `print.design.${rule}.hint` })),
  { id: 'printers', section: 'print', group: 'profiles', label: 'print.printers', hint: 'settings.profiles.printers' },
  { id: 'materials', section: 'print', group: 'profiles', label: 'print.materials', hint: 'settings.profiles.materials' },
  { id: 'updates', section: 'about', group: 'app', label: 'updates.title', hint: 'settings.about.updatesHint' },
  { id: 'checkUpdates', section: 'about', group: 'app', label: 'settings.checkUpdates.title', hint: 'settings.checkUpdates.hint' },
  { id: 'log', section: 'about', group: 'help', label: 'settings.about.revealLog', hint: 'settings.about.revealLogHint' },
  { id: 'resetAll', section: 'about', group: 'help', label: 'settings.reset.allTitle', hint: 'settings.reset.allHint' },
  { id: 'licence', section: 'about', group: 'app', label: 'settings.about.licenceTitle', hint: 'settings.about.licence' },
  ...SHORTCUTS.map(({ id, group, label }) => ({ id: `key.${id}`, section: 'shortcuts' as const, group: `keys.${group}`, label })),
];

export function settingById(id: string): SettingEntry | undefined {
  return SETTINGS.find((entry) => entry.id === id);
}

/** Lower case without accents, so "Uber" finds "Über" and "farbe" finds "Farbe". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

/**
 * The options whose name, help text, section or group contain every word of the query; options
 * whose name matches come first. `text` turns a translation key into the shown text.
 */
export function searchSettings(query: string, text: (key: string) => string): SettingEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored: { entry: SettingEntry; score: number }[] = [];
  for (const entry of SETTINGS) {
    const label = fold(text(entry.label));
    const all = `${label} ${entry.hint ? fold(text(entry.hint)) : ''} ${entry.keywords ? fold(text(entry.keywords)) : ''} ${fold(text(`settings.section.${entry.section}`))} ${fold(text(`settings.group.${entry.group}`))}`;
    if (!words.every((word) => all.includes(word))) continue;
    scored.push({ entry, score: words.filter((word) => label.includes(word)).length });
  }
  return scored.sort((a, b) => b.score - a.score).map(({ entry }) => entry);
}
