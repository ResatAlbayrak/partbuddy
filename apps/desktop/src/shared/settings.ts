import { z } from 'zod';

import { agentKindSchema, languageSchema, localStepLimitSchema, modelChoiceSchema, startPageSchema, themeSchema, zoomSchema, type SettingsReset } from './contract';

/**
 * Every stored setting of the installation with its type, default and validation, in one place.
 * A value that does not fit reads as its default, but stays in the file until the user changes
 * that setting, so nothing a newer or older PartBuddy wrote is thrown away.
 */
export const settingsSchema = z.object({
  language: languageSchema.catch('system'),
  theme: themeSchema.catch('system'),
  /** An absolute folder the user chose; null is Documents\PartBuddy. */
  projectsFolder: z.string().max(1000).nullable().catch(null),
  /** The size of the whole interface (Electron zoom factor). */
  zoom: zoomSchema.catch(1),
  /** The start page or the last project when PartBuddy starts. */
  startPage: startPageSchema.catch('home'),
  /** The installed app looks for a new version once after the start. */
  checkUpdates: z.boolean().catch(true),
  /** The first-start setup (B9) was finished or skipped. */
  setupDone: z.boolean().catch(false),
  /** The assistant may search the web and read pages (B7). */
  webResearch: z.boolean().catch(true),
  /** Show detailed SolidCraft tool errors in the assistant when enabled. */
  toolDebug: z.boolean().catch(false),
  /** Maximum model rounds for one local-model request; the next request picks up changes. */
  localStepLimit: localStepLimitSchema.catch(25),
  /** Claude Code may run with an API key (off by default, decided 2026-11-04). */
  /** Context window for local Ollama models. */
  ollamaContextSize: z.union([
    z.literal(16384),
    z.literal(32768),
    z.literal(65536),
  ]).catch(16384),
  claudeApiBilling: z.boolean().catch(false),
  /** Model and effort per route for new chats (B1); entries that do not fit are skipped one by one. */
  models: z
    .record(z.string(), z.unknown())
    .transform((stored) => {
      const models: Partial<Record<z.infer<typeof agentKindSchema>, z.infer<typeof modelChoiceSchema>>> = {};
      for (const [route, choice] of Object.entries(stored)) {
        const kind = agentKindSchema.safeParse(route);
        const parsed = modelChoiceSchema.safeParse(choice);
        if (kind.success && parsed.success) models[kind.data] = parsed.data;
      }
      return models;
    })
    .catch({}),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingKey = keyof Settings;

/** What "reset" puts back per section of the settings dialog; the first-start flag is never reset. */
export const RESET_KEYS: Record<Exclude<SettingsReset, 'solidcraft' | 'print' | 'all'>, readonly SettingKey[]> = {
  general: ['language', 'theme', 'projectsFolder', 'zoom', 'startPage', 'checkUpdates'],
  assistant: ['webResearch', 'claudeApiBilling', 'models', 'ollamaContextSize', 'toolDebug', 'localStepLimit'],
};

/**
 * The files of PartBuddy before 2026-11-07, one per area, mapped to the keys they held. They are
 * read once into the new file and left in place, so an older PartBuddy still finds its settings.
 */
export const LEGACY_FILES = {
  'general.json': ['language', 'projectsFolder', 'setupDone'],
  'appearance.json': ['theme'],
  'assistant-settings.json': ['claudeApiBilling', 'webResearch', 'models'],
} as const satisfies Record<string, readonly SettingKey[]>;
