import { modelChoiceSchema, type AgentKind, type ModelChoice } from '../../shared/contract';
import type { SettingsStore } from '../settingsStore';
import type { ChoiceStore } from './modelChoice';

/**
 * The assistant settings of the installation: whether Claude Code may run with an API key (off by
 * default, decided 2026-11-04), web research (B7) and the model and effort per route for new
 * chats (B1). Kept in the settings file; what does not fit reads as the default.
 */
export class AssistantSettings implements ChoiceStore {
  constructor(private readonly store: SettingsStore) {}

  apiBilling(): boolean {
    return this.store.get('claudeApiBilling');
  }

  setApiBilling(allow: boolean): void {
    this.store.set('claudeApiBilling', allow);
  }

  /** Whether the assistant may search the web and read pages (B7); on unless the user turned it off. */
  webResearch(): boolean {
    return this.store.get('webResearch');
  }

  setWebResearch(allow: boolean): void {
    this.store.set('webResearch', allow);
  }

  get(route: AgentKind): ModelChoice | null {
    return this.store.get('models')[route] ?? null;
  }

  set(route: AgentKind, choice: ModelChoice): void {
    this.store.set('models', { ...this.store.get('models'), [route]: modelChoiceSchema.parse(choice) });
  }

  ollamaContextSize(): 16384 | 32768 | 65536 {
    return this.store.get('ollamaContextSize');
  }

  setOllamaContextSize(size: 16384 | 32768 | 65536): void {
    this.store.set('ollamaContextSize', size);
  }
}
