import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SettingsStore } from '../src/main/settingsStore';
import { RESET_KEYS } from '../src/shared/settings';

const dirs: string[] = [];
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'partbuddy-settings-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('settings store', () => {
  it('starts with the defaults', () => {
    const store = new SettingsStore(join(folder(), 'settings.json'));
    expect(store.all()).toEqual({ language: 'system', theme: 'system', projectsFolder: null, zoom: 1, startPage: 'home', checkUpdates: true, setupDone: false, webResearch: true, claudeApiBilling: false, ollamaContextSize: 16384, toolDebug: false, localStepLimit: 25, models: {} });
  });

  it('takes over the files of earlier versions and leaves them in place', () => {
    const dir = folder();
    writeFileSync(join(dir, 'general.json'), JSON.stringify({ language: 'de', projectsFolder: join(dir, 'Teile'), setupDone: true }));
    writeFileSync(join(dir, 'appearance.json'), JSON.stringify({ theme: 'dark' }));
    writeFileSync(join(dir, 'assistant-settings.json'), JSON.stringify({ claudeApiBilling: true, webResearch: false, models: { chatgpt: { model: 'gpt-x', effort: 'high' }, nonsense: 1 } }));
    const lines: string[] = [];
    const store = new SettingsStore(join(dir, 'settings.json'), (line) => lines.push(line));
    expect(store.all()).toEqual({
      language: 'de',
      theme: 'dark',
      projectsFolder: join(dir, 'Teile'),
      zoom: 1,
      startPage: 'home',
      checkUpdates: true,
      setupDone: true,
      webResearch: false,
      claudeApiBilling: true,
      ollamaContextSize: 16384,
      toolDebug: false,
      localStepLimit: 25,
      models: { chatgpt: { model: 'gpt-x', effort: 'high' } },
    });
    expect(existsSync(join(dir, 'general.json'))).toBe(true);
    expect(lines).toContain('settings taken over from general.json');
    // Once taken over, the old files are not read again.
    writeFileSync(join(dir, 'appearance.json'), JSON.stringify({ theme: 'light' }));
    expect(new SettingsStore(join(dir, 'settings.json')).get('theme')).toBe('dark');
  });

  it('reads values that do not fit as the default but keeps them in the file', () => {
    const dir = folder();
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ language: 'fr', theme: 'dark', fromTheFuture: { x: 1 } }));
    const store = new SettingsStore(file);
    expect(store.get('language')).toBe('system');
    store.set('theme', 'light');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(raw).toMatchObject({ language: 'fr', theme: 'light', fromTheFuture: { x: 1 } });
  });

  it('keeps a damaged file beside the new one', () => {
    const dir = folder();
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{ not json');
    const store = new SettingsStore(file);
    expect(store.get('webResearch')).toBe(true);
    expect(readFileSync(`${file}.damaged`, 'utf8')).toBe('{ not json');
  });

  it('persists, validates and resets the model-round limit', () => {
    const file = join(folder(), 'settings.json');
    const store = new SettingsStore(file);
    expect(store.get('localStepLimit')).toBe(25);
    store.set('localStepLimit', 50);
    expect(new SettingsStore(file).get('localStepLimit')).toBe(50);
    store.set('localStepLimit', 100);
    expect(new SettingsStore(file).get('localStepLimit')).toBe(100);
    store.reset(RESET_KEYS.assistant);
    expect(store.get('localStepLimit')).toBe(25);
    writeFileSync(file, JSON.stringify({ localStepLimit: 999 }));
    expect(new SettingsStore(file).get('localStepLimit')).toBe(25);
  });

  it('keeps tool debugging off by default and resets it with assistant settings', () => {
    const store = new SettingsStore(join(folder(), 'settings.json'));
    expect(store.get('toolDebug')).toBe(false);
    store.set('toolDebug', true);
    expect(store.get('toolDebug')).toBe(true);
    store.reset(RESET_KEYS.assistant);
    expect(store.get('toolDebug')).toBe(false);
  });

  it('resets a section and nothing else', () => {
    const store = new SettingsStore(join(folder(), 'settings.json'));
    store.set('language', 'en');
    store.set('setupDone', true);
    store.set('webResearch', false);
    store.reset(RESET_KEYS.general);
    expect(store.get('language')).toBe('system');
    expect(store.get('setupDone')).toBe(true);
    expect(store.get('webResearch')).toBe(false);
  });
});
