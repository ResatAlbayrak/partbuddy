import {
  IconBrandGithub,
  IconCube,
  IconDeviceDesktop,
  IconFileText,
  IconFolder,
  IconHeart,
  IconInfoCircle,
  IconKeyboard,
  IconMoon,
  IconPrinter,
  IconRefresh,
  IconRestore,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconSun,
  IconX,
} from '@tabler/icons-react';
import i18next from 'i18next';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button as AriaButton,
  Dialog,
  DialogTrigger,
  Popover,
  Heading,
  Input,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  RadioButton,
  RadioField,
  RadioGroup,
  SearchField,
  SwitchButton,
  SwitchField,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from 'react-aria-components';

import { DESIGN_RULES, ZOOM_STEPS, type AppSettings, type AppInfo, type GeneralSettingsInfo, type Language, type PrintSettings, type SettingsReset, type Theme, type UpdateState } from '../../../shared/contract';
import { AssistantChoice } from '../assistant/AgentChip';
import { localeFrom } from '../i18n';
import { PrintProfilesEditor } from '../print/PrintProfilesEditor';
import { platform } from '../platform';
import { useStudio, type SettingsSection } from '../state/store';
import { Button, iconButtonClass, linkClass } from '../ui/Button';
import { SwitchMark, segmentClass, segmentGroupClass } from '../ui/Choice';
import { DialogClose, dialogTitleClass, modalClass, overlayClass } from '../ui/Dialog';
import { inputClass } from '../ui/Field';
import { tabClass, tabListClass } from '../ui/Navigation';
import { POPOVER_OFFSET, popoverPanelClass } from '../ui/Overlay';
import { EnginePanel } from './EnginePanel';
import { searchSettings, settingById, type SettingEntry } from './settingsIndex';
import { SHORTCUTS, type Shortcut } from './shortcuts';

const SECTIONS: {
  id: SettingsSection;
  icon: typeof IconSettings;
  testId: string;
}[] = [
  { id: 'general', icon: IconSettings, testId: 'settings-general' },
  { id: 'solidcraft', icon: IconCube, testId: 'settings-solidcraft' },
  { id: 'assistant', icon: IconSparkles, testId: 'settings-assistant' },
  { id: 'print', icon: IconPrinter, testId: 'settings-print' },
  { id: 'shortcuts', icon: IconKeyboard, testId: 'settings-shortcuts' },
  { id: 'about', icon: IconInfoCircle, testId: 'settings-about' },
];

const DONATE = 'https://ko-fi.com/partbuddy';
const SOURCE = 'https://github.com/PartBuddy/partbuddy';
const LICENCE = 'https://www.gnu.org/licenses/gpl-3.0.html';

const labelId = (id: string) => `setting-${id}-label`;

/** Scrolls to, focuses and briefly highlights the option the settings were opened at. */
function useHighlight(ids: readonly string[]) {
  const target = useStudio((s) => s.settingsOption);
  const ref = useRef<HTMLDivElement>(null);
  const hit = target !== null && ids.includes(target);
  useEffect(() => {
    if (!hit) return;
    const node = ref.current;
    // The control may still be loading, and the dialog moves focus to itself when it opens: try each frame for a moment.
    let tries = 0;
    let frame = 0;
    const reach = () => {
      const control = node?.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled]), a[href]');
      node?.scrollIntoView({ block: 'center' });
      if (control) control.focus({ preventScroll: true });
      if ((!control || document.activeElement !== control) && tries++ < 30) frame = requestAnimationFrame(reach);
    };
    frame = requestAnimationFrame(reach);
    const timer = window.setTimeout(() => {
      useStudio.setState({ settingsOption: null });
    }, 2000);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [hit]);
  return { ref, hit };
}

function entryOf(id: string): SettingEntry {
  const entry = settingById(id);
  if (!entry) throw new Error(`unknown setting ${id}`);
  return entry;
}

/**
 * One option: its name and help text from the settings index, a note if it needs a restart, and
 * its control beside them (`row`) or below them (`block`).
 */
function Setting({ id, layout = 'row', children }: { id: string; layout?: 'row' | 'block'; children: ReactNode }) {
  const { t } = useTranslation();
  const entry = entryOf(id);
  const { ref, hit } = useHighlight([id]);
  return (
    <div
      ref={ref}
      id={`setting-${id}`}
      data-setting={id}
      data-highlighted={hit || undefined}
      className={`scroll-m-4 px-4 py-3 transition-shadow data-[highlighted]:ring-2 data-[highlighted]:ring-accent data-[highlighted]:ring-inset ${layout === 'row' ? 'flex flex-wrap items-center justify-between gap-x-6 gap-y-2' : 'flex flex-col gap-3'}`}
    >
      <div className={`flex min-w-0 flex-col gap-1 ${layout === 'row' ? 'flex-1 basis-text-max' : ''}`}>
        <span className="flex flex-wrap items-center gap-2">
          <span id={labelId(id)} className="text-md font-medium text-text">
            {t(entry.label)}
          </span>
          {entry.restart ? (
            <span className="inline-flex items-center gap-1 rounded-sm bg-surface-sunken px-1 text-xs text-text-muted" data-testid={`setting-${id}-restart`}>
              <IconRefresh className="size-icon-sm" aria-hidden />
              {t('settings.restartNote')}
            </span>
          ) : null}
        </span>
        {entry.hint ? <p className="max-w-chat-max text-sm text-text-muted">{t(entry.hint)}</p> : null}
      </div>
      {layout === 'row' ? <div className="flex shrink-0 items-center">{children}</div> : children}
    </div>
  );
}

/** A titled group of options inside a section, as one card. */
function Group({ id, children }: { id: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby={`settings-group-${id}`} className="flex flex-col gap-2">
      <h3 id={`settings-group-${id}`} className="px-1 text-sm font-semibold text-text-muted">
        {t(`settings.group.${id}`)}
      </h3>
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">{children}</div>
    </section>
  );
}

/** The language of the window after a change or a reset. */
function applyLanguage(info: GeneralSettingsInfo) {
  const locale = localeFrom(info.language === 'system' ? info.systemLocale : info.language);
  void i18next.changeLanguage(locale);
  document.documentElement.lang = locale;
}

/** Puts a section (or all) back to the defaults after asking once; `done` reloads the shown values. */
function ResetButton({ section, done, label }: { section: SettingsReset; done: () => void; label: string }) {
  const { t } = useTranslation();
  return (
    <DialogTrigger>
      <Button variant="quiet" size="sm" data-testid={`settings-reset-${section}`}>
        <IconRestore className="size-icon" aria-hidden />
        {label}
      </Button>
      <Popover placement="bottom end" offset={POPOVER_OFFSET} className={popoverPanelClass}>
        <Dialog aria-label={label} className="flex flex-col gap-3 p-4 outline-none" data-testid="settings-reset-confirm">
          {({ close }) => (
            <>
              <p className="text-md text-text">{t(`settings.reset.what.${section}`)}</p>
              <div className="flex justify-end gap-2">
                <Button onPress={close}>{t('settings.reset.cancel')}</Button>
                <Button
                  variant="primary"
                  onPress={() => {
                    void platform()
                      .settings.reset(section)
                      .then((info) => {
                        applyLanguage(info);
                        close();
                        done();
                      });
                  }}
                  data-testid="settings-reset-go"
                >
                  {t('settings.reset.go')}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

function SectionHead({ id, done }: { id: SettingsSection; done?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-xl font-semibold text-text">{t(`settings.section.${id}`)}</h2>
        <p className="text-md text-text-muted">{t(`settings.intro.${id}`)}</p>
      </div>
      {done && id !== 'about' && id !== 'shortcuts' ? <ResetButton section={id} done={done} label={t('settings.reset.section')} /> : null}
    </div>
  );
}

/** A choice of two to four values as a segmented control (radio buttons). */
function Segmented<T extends string>({
  id,
  value,
  options,
  onChange,
  testId,
}: {
  id: string;
  value: T;
  options: { id: T; label: string; icon?: typeof IconSun }[];
  onChange: (value: T) => void;
  testId: string;
}) {
  return (
    <RadioGroup
      aria-labelledby={labelId(id)}
      orientation="horizontal"
      value={value}
      onChange={(next) => {
        onChange(next as T);
      }}
      className={segmentGroupClass}
      data-testid={testId}
    >
      {options.map(({ id: option, label, icon: Icon }) => (
        <RadioField key={option} value={option}>
          <RadioButton className={`${segmentClass('sm')} px-3`}>
            {Icon ? <Icon className="size-icon-sm" aria-hidden /> : null}
            {label}
          </RadioButton>
        </RadioField>
      ))}
    </RadioGroup>
  );
}

/** An on/off option as a switch, named by its row. */
function Toggle({ id, isSelected, onChange, testId }: { id: string; isSelected: boolean; onChange: (on: boolean) => void; testId: string }) {
  return (
    <SwitchField aria-labelledby={labelId(id)} isSelected={isSelected} onChange={onChange} data-testid={testId}>
      <SwitchButton className="group inline-flex min-h-control-sm cursor-default items-center outline-none">
        <SwitchMark />
      </SwitchButton>
    </SwitchField>
  );
}

/** The project folder with "choose another" and "back to Documents" (B6); also in the first-start setup (B9). */
export function ProjectsFolderField({ info, onChange, titled = true }: { info: GeneralSettingsInfo; onChange: (info: GeneralSettingsInfo) => void; titled?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      {titled ? <h3 className="text-sm font-semibold text-text">{t('settings.projects.title')}</h3> : null}
      <div className="flex items-start gap-2 text-sm text-text">
        <IconFolder className="mt-1 size-icon-sm shrink-0 text-text-muted" aria-hidden />
        <span className="break-all" data-testid="settings-projects-folder">
          {info.projectsFolder}
        </span>
      </div>
      <p className="text-xs text-text-subtle" title={info.projectsSource === 'override' ? 'PARTBUDDY_PROJECTS_DIR' : undefined}>
        {t(`settings.projects.source.${info.projectsSource}`)}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button isDisabled={info.projectsSource === 'override'} onPress={() => void platform().settings.chooseProjectsFolder().then(onChange)} data-testid="settings-projects-choose">
          {t('settings.projects.choose')}
        </Button>
        {info.projectsSource === 'setting' ? (
          <Button onPress={() => void platform().settings.resetProjectsFolder().then(onChange)} data-testid="settings-projects-reset">
            {t('settings.projects.reset')}
          </Button>
        ) : null}
      </div>
      {info.restartNeeded ? (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md bg-warning-subtle px-3 py-2 text-sm text-text" data-testid="settings-restart-hint">
          <span className="flex-1">{t('settings.projects.restartHint')}</span>
          <Button variant="primary" onPress={() => void platform().relaunch()} data-testid="settings-restart">
            {t('engine.restart')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Language, colour theme and project folder (B6). */
function GeneralSection() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<GeneralSettingsInfo | null>(null);
  const [theme, setTheme] = useState<Theme | null>(null);
  const [app, setApp] = useState<AppSettings | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([platform().settings.general(), platform().window.theme(), platform().settings.app()]).then(([general, stored, appSettings]) => {
      if (!live) return;
      setInfo(general);
      setTheme(stored);
      setApp(appSettings);
    });
    return () => {
      live = false;
    };
  }, []);
  if (!info || !theme || !app) return null;
  const setLanguage = (language: Language) => {
    void platform()
      .settings.setLanguage(language)
      .then((next) => {
        setInfo(next);
        applyLanguage(next);
      });
  };
  return (
    <>
      <Group id="appearance">
        <Setting id="language">
          <Segmented
            id="language"
            value={info.language}
            options={(['system', 'de', 'en'] as const).map((id) => ({
              id,
              label: t(`settings.language.${id}`),
            }))}
            onChange={setLanguage}
            testId="settings-language"
          />
        </Setting>
        <Setting id="theme">
          <Segmented
            id="theme"
            value={theme}
            options={[
              {
                id: 'system',
                label: t('settings.theme.system'),
                icon: IconDeviceDesktop,
              },
              { id: 'light', label: t('settings.theme.light'), icon: IconSun },
              { id: 'dark', label: t('settings.theme.dark'), icon: IconMoon },
            ]}
            onChange={(next: Theme) => {
              setTheme(next);
              void platform().window.setTheme(next);
            }}
            testId="settings-theme"
          />
        </Setting>
        <Setting id="zoom">
          <Segmented
            id="zoom"
            value={String(app.zoom)}
            options={ZOOM_STEPS.map((step) => ({ id: String(step), label: `${Math.round(step * 100)} %` }))}
            onChange={(next) => {
              void platform().settings.setApp({ key: 'zoom', value: Number(next) }).then(setApp);
            }}
            testId="settings-zoom"
          />
        </Setting>
      </Group>
      <Group id="startup">
        <Setting id="startPage">
          <Segmented
            id="startPage"
            value={app.startPage}
            options={(['home', 'last'] as const).map((id) => ({ id, label: t(`settings.startPage.${id}`) }))}
            onChange={(next) => {
              void platform().settings.setApp({ key: 'startPage', value: next }).then(setApp);
            }}
            testId="settings-start-page"
          />
        </Setting>
      </Group>
      <Group id="files">
        <Setting id="projectsFolder" layout="block">
          <ProjectsFolderField info={info} onChange={setInfo} titled={false} />
        </Setting>
      </Group>
    </>
  );
}

/** Research on the web (B7): Claude Code's WebSearch and WebFetch, ChatGPT's web search. */
function ResearchToggle() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void platform()
      .agent.research()
      .then((value) => {
        if (live) setAllowed(value);
      });
    return () => {
      live = false;
    };
  }, []);
  if (allowed === null) return null;
  return (
    <Toggle
      id="research"
      isSelected={allowed}
      onChange={(allow) => {
        setAllowed(allow);
        void platform().agent.setResearch(allow).then(setAllowed);
      }}
      testId="research"
    />
  );
}

/** Detailed SolidCraft errors are optional and apply immediately to new tool calls. */
function ToolDebugToggle() {
  const enabled = useStudio((state) => state.toolDebug);
  const setToolDebug = useStudio((state) => state.setToolDebug);
  return (
    <Toggle
      id="toolDebug"
      isSelected={enabled}
      onChange={(value) => {
        setToolDebug(value);
        void platform().settings.setApp({ key: 'toolDebug', value }).then((next) => {
          setToolDebug(next.toolDebug);
        });
      }}
      testId="tool-debug"
    />
  );
}

/** Configurable context window for local Ollama models. */
function OllamaContextSetting() {
  const [size, setSize] = useState<
    16384 | 32768 | 65536 | null
  >(null);

  useEffect(() => {
    let live = true;

    void platform().agent.ollamaContext().then((value) => {
      if (live) setSize(value);
    });

    return () => {
      live = false;
    };
  }, []);

  if (size === null) return null;

  return (
    <Segmented
      id="ollamaContext"
      value={String(size)}
      options={[
        { id: '16384', label: '16K' },
        { id: '32768', label: '32K' },
        { id: '65536', label: '64K' },
      ]}
      onChange={(next) => {
        const value = Number(next);

        if (
          value === 16384 ||
          value === 32768 ||
          value === 65536
        ) {
          void platform()
            .agent.setOllamaContext(value)
            .then(setSize);
        }
      }}
      testId="settings-ollama-context"
    />
  );
}

/**
 * Designing without support and the design rule groups (2026-11-07): kept with the print settings,
 * which the assistant reads. One copy for all rows, so no switch saves over another with a stale one.
 */
function PrintRuleSettings() {
  const [settings, setSettings] = useState<PrintSettings | null>(null);
  useEffect(() => {
    let live = true;
    void platform()
      .print.settings()
      .then((loaded) => {
        if (live) setSettings(loaded);
      });
    return () => {
      live = false;
    };
  }, []);
  if (!settings) return null;
  const save = (next: PrintSettings) => {
    setSettings(next);
    void platform().print.saveSettings(next).then(setSettings);
  };
  return (
    <>
      <Setting id="supportFree">
        <Toggle
          id="supportFree"
          isSelected={settings.supportFree}
          onChange={(supportFree) => {
            save({ ...settings, supportFree });
          }}
          testId="support-free"
        />
      </Setting>
      {DESIGN_RULES.map((rule) => (
        <Setting key={rule} id={`design.${rule}`}>
          <Toggle
            id={`design.${rule}`}
            isSelected={settings.design[rule]}
            onChange={(on) => {
              save({ ...settings, design: { ...settings.design, [rule]: on } });
            }}
            testId={`design-${rule}`}
          />
        </Setting>
      ))}
    </>
  );
}

/** Whether the installed app looks for a new version after the start; applies at the next start. */
function CheckUpdatesToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void platform()
      .settings.app()
      .then((app) => {
        if (live) setOn(app.checkUpdates);
      });
    return () => {
      live = false;
    };
  }, []);
  if (on === null) return null;
  return (
    <Toggle
      id="checkUpdates"
      isSelected={on}
      onChange={(next) => {
        setOn(next);
        void platform()
          .settings.setApp({ key: 'checkUpdates', value: next })
          .then((app) => {
            setOn(app.checkUpdates);
          });
      }}
      testId="settings-check-updates"
    />
  );
}

/** One way to press a shortcut: its keys as caps, in the interface font with even digits. */
function KeyCombo({ keys }: { keys: string[] }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((key) => (
        <kbd key={key} className="inline-flex h-control-sm min-w-control-sm items-center justify-center rounded-sm border border-border-strong bg-surface-sunken px-1 font-sans text-sm text-text tabular-nums shadow-1">
          {t(`settings.keys.token.${key}`, { defaultValue: key })}
        </kbd>
      ))}
    </span>
  );
}

/** The overview of the shortcuts (2026-11-07), read-only, grouped like the app. */
function ShortcutsSection() {
  const { t } = useTranslation();
  const groups: Shortcut['group'][] = ['app', 'design', 'view', 'sketch'];
  return (
    <>
      {groups.map((group) => (
        <Group key={group} id={`keys.${group}`}>
          {SHORTCUTS.filter((shortcut) => shortcut.group === group).map((shortcut) => (
            <Setting key={shortcut.id} id={`key.${shortcut.id}`}>
              <span className="flex items-center gap-2 text-sm text-text-muted" data-testid={`shortcut-${shortcut.id}`}>
                {shortcut.keys.map((combo, index) => (
                  <span key={combo.join('+')} className="inline-flex items-center gap-2">
                    {index > 0 ? t('settings.keys.or') : null}
                    <KeyCombo keys={combo} />
                  </span>
                ))}
              </span>
            </Setting>
          ))}
        </Group>
      ))}
    </>
  );
}

/** Updates through GitHub releases (B10): look now, download, restart and install. */
function UpdatesBlock() {
  const { t } = useTranslation();
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let live = true;
    const api = platform().updates;
    void api.state().then((current) => {
      if (live) setState(current);
    });
    const off = api.onState(setState);
    return () => {
      live = false;
      off();
    };
  }, []);
  if (!state) return null;
  const api = platform().updates;
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="updates" data-state={state.state}>
      <p className="flex-1 text-sm text-text tabular-nums" role="status">
        {state.state === 'available' || state.state === 'ready' || state.state === 'current'
          ? t(`updates.state.${state.state}`, { version: state.version })
          : state.state === 'downloading'
            ? t('updates.state.downloading', { percent: state.percent })
            : t(`updates.state.${state.state}`)}
      </p>
      {state.state === 'available' ? (
        <Button variant="primary" onPress={() => void api.download()} data-testid="updates-download">
          {t('updates.download')}
        </Button>
      ) : state.state === 'ready' ? (
        <Button variant="primary" onPress={() => void api.install()} data-testid="updates-install">
          {t('updates.install')}
        </Button>
      ) : state.state !== 'unavailable' ? (
        <Button isDisabled={state.state === 'checking' || state.state === 'downloading'} onPress={() => void api.check().then(setState)} data-testid="updates-check">
          {t('updates.check')}
        </Button>
      ) : null}
    </div>
  );
}

function AboutSection({ done }: { done: () => void }) {
  const { t } = useTranslation();
  const [app, setApp] = useState<AppInfo | null>(null);
  useEffect(() => {
    let live = true;
    void platform()
      .appInfo()
      .then((info) => {
        if (live) setApp(info);
      });
    return () => {
      live = false;
    };
  }, []);
  const link = `inline-flex items-center gap-2 text-sm ${linkClass}`;
  return (
    <div className="flex flex-col gap-5" data-testid="settings-about-panel">
      <div className="flex flex-col gap-1 text-text">
        <span className="font-display text-xl font-semibold">{app?.name ?? 'PartBuddy'}</span>
        <span className="text-md text-text-muted tabular-nums" data-testid="settings-version">
          {t('settings.about.version', { version: app?.version ?? '…' })}
        </span>
      </div>
      <Group id="app">
        <Setting id="updates" layout="block">
          <UpdatesBlock />
        </Setting>
        <Setting id="checkUpdates">
          <CheckUpdatesToggle />
        </Setting>
        <Setting id="licence" layout="block">
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <a href={DONATE} target="_blank" rel="noreferrer" className={link} data-testid="settings-sponsor">
              <IconHeart className="size-icon-sm" aria-hidden />
              {t('settings.about.sponsor')}
            </a>
            <a href={SOURCE} target="_blank" rel="noreferrer" className={link}>
              <IconBrandGithub className="size-icon-sm" aria-hidden />
              {t('settings.about.source')}
            </a>
            <a href={LICENCE} target="_blank" rel="noreferrer" className={link}>
              {t('settings.about.licenceLink')}
            </a>
          </div>
        </Setting>
      </Group>
      <Group id="help">
        <Setting id="log">
          <Button
            onPress={() => {
              void platform().settings.revealLog();
            }}
            data-testid="settings-reveal-log"
          >
            <IconFileText className="size-icon" aria-hidden />
            {t('settings.about.revealLogButton')}
          </Button>
        </Setting>
        <Setting id="resetAll">
          <ResetButton section="all" done={done} label={t('settings.reset.all')} />
        </Setting>
      </Group>
    </div>
  );
}

/** The print profiles keep their own tabs; a link to printers or materials opens the right one. */
function PrintSection() {
  const { ref, hit } = useHighlight(['printers', 'materials']);
  return (
    <div ref={ref} data-highlighted={hit || undefined} className="flex flex-col gap-4 rounded-lg transition-shadow data-[highlighted]:ring-2 data-[highlighted]:ring-accent data-[highlighted]:ring-inset">
      <PrintProfilesEditor />
    </div>
  );
}

/** Search results across every section; choosing one opens its section at the option. */
function SearchResults({ results, query, open, listRef }: { results: SettingEntry[]; query: string; open: (entry: SettingEntry) => void; listRef: RefObject<HTMLDivElement | null> }) {
  const { t } = useTranslation();
  if (results.length === 0) {
    return (
      <p className="p-6 text-md text-text-muted" role="status" data-testid="settings-search-empty">
        {t('settings.search.empty', { query })}
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-6 py-5">
      <p className="text-sm text-text-muted" role="status">
        {t('settings.search.count', { count: results.length })}
      </p>
      <ListBox
        ref={listRef}
        aria-label={t('settings.search.results')}
        items={results}
        onAction={(key) => {
          const entry = results.find((candidate) => candidate.id === key);
          if (entry) open(entry);
        }}
        className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface outline-none"
        data-testid="settings-search-results"
      >
        {(entry) => (
          <ListBoxItem
            id={entry.id}
            textValue={t(entry.label)}
            className="flex cursor-default flex-col gap-1 px-4 py-3 outline-none transition-colors hover:bg-surface-hover pressed:bg-surface-pressed focused:bg-surface-hover focus-visible:focus-ring-inset"
            data-setting={entry.id}
          >
            <span className="text-md font-medium text-text">{t(entry.label)}</span>
            <span className="text-xs text-text-subtle">
              {t(`settings.section.${entry.section}`)} › {t(`settings.group.${entry.group}`)}
            </span>
            {entry.hint ? <span className="line-clamp-2 text-sm text-text-muted">{t(entry.hint)}</span> : null}
          </ListBoxItem>
        )}
      </ListBox>
    </div>
  );
}

const panelClass = 'flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5 outline-none';

/**
 * The settings (plan step B6; reworked 2026-11-07): a search over every option, sections on the
 * left with grouped options, each with a help text. Ctrl+, opens them, Esc closes them, the arrow
 * keys move through the sections. Any place of the app opens an option directly with
 * `setSettingsSection(section, optionId)`.
 */
export function SettingsDialog() {
  const { t } = useTranslation();
  const section = useStudio((s) => s.settingsSection);
  const option = useStudio((s) => s.settingsOption);
  const setSection = useStudio((s) => s.setSettingsSection);
  const setProfilesTab = useStudio((s) => s.setProfilesTab);
  const [query, setQuery] = useState('');
  // Raised by a reset: the sections mount again and read the values afresh.
  const [revision, setRevision] = useState(0);
  const reload = () => {
    setRevision((value) => value + 1);
    void platform().settings.app().then(({ toolDebug }) => useStudio.getState().setToolDebug(toolDebug));
  };
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchSettings(query, (key) => t(key)), [query, t]);
  const close = () => {
    setQuery('');
    setSection(null);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key !== ',') return;
      event.preventDefault();
      if (useStudio.getState().settingsSection === null) setSection('general');
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [setSection]);

  useEffect(() => {
    if (option === 'printers') setProfilesTab('printer');
    if (option === 'materials') setProfilesTab('material');
  }, [option, setProfilesTab]);

  const open = (entry: SettingEntry) => {
    setQuery('');
    setSection(entry.section, entry.id);
  };
  const searching = query.trim() !== '';

  return (
    <ModalOverlay
      isOpen={section !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) close();
      }}
      isDismissable
      className={overlayClass}
    >
      <Modal className={modalClass('settings')}>
        <Dialog className="flex h-[min(54rem,calc(100dvh_-_7rem))] flex-col outline-none" data-testid="settings-dialog">
          <div className="flex items-center gap-3 border-b border-border py-2 pr-2 pl-5">
            <Heading slot="title" className={`mr-auto ${dialogTitleClass}`}>
              {t('settings.title')}
            </Heading>
            <SearchField
              aria-label={t('settings.search.label')}
              value={query}
              onChange={setQuery}
              onSubmit={() => {
                const first = results[0];
                if (first) open(first);
              }}
              onKeyDown={(event) => {
                // Down moves into the results; Esc stays with the field (it clears it first).
                if (event.key === 'ArrowDown' && searching) listRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
                else if (event.key !== 'Escape' || query === '') event.continuePropagation();
              }}
              className="group relative flex w-search items-center"
            >
              <IconSearch className="pointer-events-none absolute left-2 size-icon-sm text-text-subtle" aria-hidden />
              <Input
                placeholder={t('settings.search.placeholder')}
                className={`${inputClass('md')} pr-6 pl-6 [&::-webkit-search-cancel-button]:hidden`}
                data-testid="settings-search"
              />
              <AriaButton aria-label={t('settings.search.clear')} className={`absolute right-1 group-empty:hidden ${iconButtonClass('sm')}`}>
                <IconX className="size-icon-sm" aria-hidden />
              </AriaButton>
            </SearchField>
            <DialogClose onPress={close} />
          </div>
          <div className="flex min-h-0 flex-1">
            <Tabs
              orientation="vertical"
              selectedKey={section ?? 'general'}
              onSelectionChange={(key) => {
                // The profiles open at the printer, as from the material menu.
                if (key === 'print') setProfilesTab('printer');
                setQuery('');
                setSection(key as SettingsSection);
              }}
              // The results sit beside the tabs: React Aria renders the children of Tabs once more to collect the tabs.
              className={searching ? 'flex min-h-0 shrink-0' : 'flex min-h-0 flex-1'}
            >
              <TabList aria-label={t('settings.title')} className={`w-settings-nav shrink-0 border-r border-border bg-surface-sunken p-2 ${tabListClass('vertical')}`}>
                {SECTIONS.map(({ id, icon: Icon, testId }) => (
                  <Tab
                    key={id}
                    id={id}
                    className={tabClass('vertical')}
                    data-testid={testId}
                  >
                    <Icon className="size-icon shrink-0" aria-hidden />
                    {t(`settings.section.${id}`)}
                  </Tab>
                ))}
              </TabList>
              <div key={revision} className={searching ? 'hidden' : 'flex min-w-0 flex-1'}>
                <TabPanel id="general" className={panelClass} data-testid="settings-general-panel">
                  <SectionHead id="general" done={reload} />
                  <GeneralSection />
                </TabPanel>
                <TabPanel id="solidcraft" className={panelClass} data-testid="solidcraft-engine">
                  <SectionHead id="solidcraft" done={reload} />
                  <Group id="program">
                    <Setting id="engine" layout="block">
                      <EnginePanel />
                    </Setting>
                  </Group>
                </TabPanel>
                <TabPanel id="assistant" className={panelClass} data-testid="settings-assistant-panel">
                  <SectionHead id="assistant" done={reload} />
                  <Group id="route">
                    <Setting id="assistant" layout="block">
                      <div className="flex flex-col gap-3">
                        <AssistantChoice />
                      </div>
                    </Setting>
                    <Setting id="ollamaContext">
                      <OllamaContextSetting />
                    </Setting>
                  </Group>
                  <Group id="work">
                    <Setting id="research">
                      <ResearchToggle />
                    </Setting>
                    <Setting id="toolDebug">
                      <ToolDebugToggle />
                    </Setting>
                  </Group>
                  <Group id="rules">
                    <PrintRuleSettings />
                  </Group>
                </TabPanel>
                <TabPanel id="print" className={panelClass} data-testid="print-profiles">
                  <SectionHead id="print" done={reload} />
                  <PrintSection />
                </TabPanel>
                <TabPanel id="shortcuts" className={panelClass} data-testid="settings-shortcuts-panel">
                  <SectionHead id="shortcuts" />
                  <ShortcutsSection />
                </TabPanel>
                <TabPanel id="about" className={panelClass}>
                  <AboutSection done={reload} />
                </TabPanel>
              </div>
            </Tabs>
            {searching ? <SearchResults results={results} query={query.trim()} open={open} listRef={listRef} /> : null}
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
