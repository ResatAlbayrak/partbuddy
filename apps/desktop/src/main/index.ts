import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, screen, session, shell } from 'electron';

import { invokeChannels, eventChannels } from '../shared/channels';
import type { AssemblyPlan } from '../shared/assembly';
import { DESIGN_DEFAULTS, type AgentEvent, type ExportFormat, type PartPrint, type PrintCheckReport, type PrintSettings, type ViewState } from '../shared/contract';
import { refit, withoutFitMark } from '../shared/designFit';
import { AgentService } from './agents/agentService';
import { AppearanceSettings } from './appearance';
import { GeneralSettings } from './generalSettings';
import { SettingsStore } from './settingsStore';
import { RESET_KEYS } from '../shared/settings';
import { Updates } from './updates';
import { Assistant } from './agents/assistant';
import { SolidCraftTools } from './agents/solidcraftTools';
import type { UpstreamTools } from './agents/gateProxy';
import { guardNotes } from './agents/noteGuard';
import { withViewTool } from './agents/viewContext';
import { withAssemblyTool } from './agents/assemblyTool';
import { withDesignTool } from './agents/designTool';
import { keepPrintFace, readAssembly, readPrintFaces, writeAssembly } from './projects/assembly';
import { Questions } from './agents/questions';
import { WorkLog } from './agents/workLog';
import { withBlockTool } from './agents/blockTool';
import { withMechanismTool } from './agents/mechanismTool';
import { blockPhrase, describeUserAction, type StepPhrase } from '../shared/stepPhrases';
import { ChatGptAccount } from './chatgpt/account';
import { ChatGptAgent } from './chatgpt/chatgptAgent';
import { LocalAgent } from './local/localAgent';
import { hostId } from './chatgpt/oauth';
import { SecretStore } from './credentials/secretStore';
import { loadNoteKey } from './notes/noteRecord';
import { NotesService } from './notes/notesService';
import { Bridge, trustedSender } from './bridge';
import { findExecutable, systemEnvironment } from './solidcraft/discovery';
import { EngineChoice } from './solidcraft/engineChoice';
import { AssistantSettings } from './agents/assistantSettings';
import { checkImportFile, IMPORT_EXTENSIONS, importName, type ImportKind } from './projects/importFile';
import { migrateDesigns, ProjectStore, whenFree } from './projects/projectStore';
import { readParts, writePart } from './projects/parts';
import { writeMeta } from './projects/projectMeta';
import { exportPackage, importPackage, PACKAGE_EXTENSION } from './projects/projectPackage';
import { ProjectTrash } from './projects/trash';
import { LogFile } from './logFile';
import { keepSketch, listSketches, loadSketch } from './projects/sketches';
import { summarizeComparison } from './projects/versionCompare';
import { VersionStore, type VersionReason } from './projects/versionStore';
import { readVersion } from './solidcraft/engineVersion';
import { safeDesignFileName } from './solidcraft/headless';
import { longPath, SolidCraftSupervisor } from './solidcraft/supervisor';
import { ChatArchive } from './chat/chatArchive';
import { printCheckNote } from './print/printCheckNote';
import { templatePrintFaces, templateSteps } from '../shared/templates';
import { testPieceSteps } from '../shared/testPieces';
import { sketchNote } from './agents/sketchNote';
import { photoFile, photoNote } from './agents/photoNote';
import { drawingNote, Drawings, withDrawings } from './agents/drawingTool';
import { parseDrawing } from '../shared/svgDrawing';
import { shareDescription } from './share/description';
import { freeFolder } from './share/freeFolder';
import { PrintProfiles, ProfileNote, printNote } from './print/printProfiles';
import { logoTitle } from '../shared/drawingPlacement';

app.setName('PartBuddy');
// Windows counts a window beside all displays as covered and stops painting it; test runs
// (PARTBUDDY_WINDOW_DISPLAY=offscreen) keep it painting.
/** Test runs and screenshot runs (any PARTBUDDY_WINDOW_DISPLAY) never open Explorer windows. */
const testRun = process.env.PARTBUDDY_WINDOW_DISPLAY !== undefined;
if (process.env.PARTBUDDY_WINDOW_DISPLAY === 'offscreen') app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/**
 * Builds are served from a privileged custom scheme instead of file:// (Electron security
 * checklist): one origin for the bridge's sender check, module workers allowed, and only files
 * inside the renderer folder can be read.
 */
const APP_SCHEME = 'partbuddy';
const APP_HOST = 'app';
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const rendererRoot = resolve(__dirname, '../renderer');

function serveRenderer(request: Request): Response | Promise<Response> {
  const url = new URL(request.url);
  const file = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`);
  if (url.host !== APP_HOST || !file.startsWith(rendererRoot + sep)) {
    return new Response('not found', { status: 404 });
  }
  return net.fetch(pathToFileURL(file).href);
}

const EXPORT_FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  '3mf': { name: '3MF', extensions: ['3mf'] },
  stl: { name: 'STL', extensions: ['stl'] },
  step: { name: 'STEP', extensions: ['step', 'stp'] },
};

const devServerUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const rendererOrigin = devServerUrl ? new URL(devServerUrl).origin : `${APP_SCHEME}://${APP_HOST}`;

let mainWindow: BrowserWindow | null = null;

// In the profile's logs folder (a test profile keeps its own); PARTBUDDY_LOG_FILE points it elsewhere for tests.
const logFile = new LogFile(process.env.PARTBUDDY_LOG_FILE ?? join(app.getPath('userData'), 'logs', 'partbuddy.log'));

function log(message: string): void {
  // Logs carry no prompts, tokens or personal data (architecture: user data at runtime).
  console.log(`[partbuddy] ${message}`);
  logFile.write(message);
}

// Crashes and forgotten promise errors land in the log too; the monitor leaves Electron's own handling as it is.
process.on('uncaughtExceptionMonitor', (error) => {
  log(`uncaught: ${error.stack ?? error.message}`);
});
process.on('unhandledRejection', (reason) => {
  log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

function cacheDirectory(): string {
  if (process.env.PARTBUDDY_CACHE_DIR) return process.env.PARTBUDDY_CACHE_DIR;
  const local = process.platform === 'win32' ? process.env.LOCALAPPDATA : undefined;
  return local ? join(local, 'PartBuddy', 'cache', 'mirror') : join(app.getPath('userData'), 'cache', 'mirror');
}

function launchPort(): number {
  const value = Number.parseInt(process.env.PARTBUDDY_SOLIDCRAFT_PORT ?? '', 10);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 7878;
}

/** Height of the integrated title bar; the renderer's token `--cs-titlebar-height` confirms it. */
const TITLE_BAR_HEIGHT = 40;
/** The system window buttons grow with the interface size, so they stay as high as the title bar. */
const titleBarHeight = (zoom: number) => Math.round(TITLE_BAR_HEIGHT * zoom);

const WINDOW_WIDTH = 1440;
const WINDOW_HEIGHT = 900;

/**
 * Test runs must not disturb the developer (rule of 2026-11-04): PARTBUDDY_WINDOW_DISPLAY=offscreen
 * (the E2E launcher's default) opens the window beside all displays, without focus and without a
 * taskbar button, so nothing of it is seen; `leftmost` puts it on the leftmost display, still
 * without focus, for watching a test on purpose. The app itself opens where the system puts it.
 */
type TestPlacement = { x: number; y: number; hidden: boolean };
function testPlacement(): TestPlacement | null {
  const mode = process.env.PARTBUDDY_WINDOW_DISPLAY;
  const displays = [...screen.getAllDisplays()].sort((a, b) => a.bounds.x - b.bounds.x);
  const [leftmost] = displays;
  if (!leftmost) return null;
  if (mode === 'offscreen') {
    const top = Math.min(...displays.map((display) => display.bounds.y));
    return { x: leftmost.bounds.x - WINDOW_WIDTH - 400, y: top, hidden: true };
  }
  if (mode === 'leftmost') return { x: leftmost.workArea.x + 24, y: leftmost.workArea.y + 24, hidden: false };
  return null;
}

function createWindow(): BrowserWindow {
  const placement = testPlacement();
  const window = new BrowserWindow({
    ...(placement ? { x: placement.x, y: placement.y, skipTaskbar: placement.hidden } : {}),
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'PartBuddy',
    autoHideMenuBar: true,
    // Integrated title bar: the app draws logo, wordmark and design name, the system keeps its
    // own window buttons (Snap layouts on Windows 11, traffic lights on macOS). The renderer
    // colours the buttons from the design tokens (window:title-bar).
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? true : { height: titleBarHeight(settingsStore.get('zoom')) },
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 12 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // The interface size the user chose (2026-11-07); changed later with setZoomFactor.
      zoomFactor: settingsStore.get('zoom'),
      // Off screen the window must keep rendering, or the 3D view of a test stays empty.
      ...(placement?.hidden ? { backgroundThrottling: false } : {}),
    },
  });
  window.once('ready-to-show', () => {
    if (placement) window.showInactive();
    else window.show();
  });
  // No remote content and no new windows in the privileged window (architecture: security).
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Errors of the interface land in the log too, or a white window leaves nothing to go on.
  window.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error') log(`interface error: ${message.slice(0, 4000)}`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    log(`interface process gone: ${details.reason} (exit code ${String(details.exitCode)})`);
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(rendererOrigin)) event.preventDefault();
  });
  if (devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadURL(`${rendererOrigin}/index.html`);
  return window;
}

// The language the user chose (B6) is Chromium's locale, set before the app is ready; a `--lang`
// on the command line (tests) wins.
// All settings in one file, read through the shared schema; the files of earlier versions are taken over once.
const settingsStore = new SettingsStore(join(app.getPath('userData'), 'settings.json'), log);
const general = new GeneralSettings(settingsStore);
const chosenLanguage = general.language();
if (chosenLanguage !== 'system' && !process.argv.some((arg) => arg.startsWith('--lang'))) {
  app.commandLine.appendSwitch('lang', chosenLanguage === 'de' ? 'de-DE' : 'en-US');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });

  void app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, serveRenderer);
    // Only the installed fonts' names, for the font of a text block; every other permission is refused.
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      callback(permission === 'local-fonts' && contents.id === mainWindow?.webContents.id);
    });

    const appearance = new AppearanceSettings(settingsStore);
    nativeTheme.themeSource = appearance.theme();

    const bridge = new Bridge(ipcMain, trustedSender(() => mainWindow?.webContents.id, rendererOrigin), !app.isPackaged, log);
    // The user's project folder: the only place the assistant's SolidCraft may read and write.
    // PARTBUDDY_PROJECTS_DIR: tests keep the user's documents untouched.
    const defaultProjects = join(app.getPath('documents'), 'PartBuddy');
    const projects = longPath(process.env.PARTBUDDY_PROJECTS_DIR ?? general.projectsFolder() ?? defaultProjects);
    // Projects (B2): one folder per part; designs kept in PartBuddy's own folder before become projects once.
    const designsDir = join(app.getPath('userData'), 'designs');
    let german = app.getLocale().toLowerCase().startsWith('de');
    const projectStore = new ProjectStore(projects, designsDir, german ? 'Teil' : 'Part');
    const migrated = migrateDesigns(designsDir, projectStore, log);
    if (migrated > 0) log(`${String(migrated)} earlier designs became projects`);
    // The recycle bin (P2): entries older than 30 days go on to the Windows recycle bin at start.
    const projectTrash = new ProjectTrash(projectStore, (folder) => shell.trashItem(folder));
    void projectTrash
      .empty(true)
      .then((handed) => {
        if (handed > 0) log(`${String(handed)} deleted projects went on to the Windows recycle bin`);
      })
      .catch((error: unknown) => {
        log(`the recycle bin could not be tidied: ${(error as Error).message}`);
      });
    // The first-start setup (B9) shows once; not for installations that have projects already and
    // not in tests that start without it (PARTBUDDY_FIRST_START=0).
    const setupNeeded = process.env.PARTBUDDY_FIRST_START !== '0' && !general.setupDone() && projectStore.list().length === 0;
    // The work log of the conversation (M2a); made once the supervisor exists.
    let workLog: WorkLog | null = null;
    // Notes on the model (M2b, ADR 0020); made once the supervisor exists.
    let notes: NotesService | null = null;
    let chats: ChatArchive | null = null;
    let prints: PrintProfiles | null = null;
    // Which SolidCraft runs (R0, ADR 0024): the automatic search or the program the user chose.
    const engineChoice = new EngineChoice({
      file: join(app.getPath('userData'), 'solidcraft-settings.json'),
      environment: systemEnvironment,
      readVersion,
    });
    const engineEnvironment = engineChoice.environment();
    void engineChoice.info().then((engine) => {
      log(`SolidCraft ${engine.version ?? 'version unknown'} (${engine.source}, ${engine.support})`);
    });
    // The start page or the last project, as the user chose (2026-11-07); tests set PARTBUDDY_START_PAGE.
    const startEnv = process.env.PARTBUDDY_START_PAGE;
    const startOnHome = startEnv === undefined ? settingsStore.get('startPage') === 'home' : startEnv !== '0';
    const supervisor = new SolidCraftSupervisor(
      {
        environment: engineEnvironment,
        launchPort: launchPort(),
        autoStart: process.env.PARTBUDDY_SOLIDCRAFT_AUTOSTART !== '0',
        cacheDir: cacheDirectory(),
        // SolidCraft without a window by default (ADR 0016); the window only on purpose.
        launchMode: process.env.PARTBUDDY_SOLIDCRAFT_WINDOW === '1' ? 'window' : 'headless',
        designsDir,
        newPartName: german ? 'Teil' : 'Part',
        projectsDir: projects,
        // PartBuddy starts on the start page and opens no project on its own (B3, Manuel 2026-11-05).
        openLastOnStart: !startOnHome,
        log,
      },
      {
        status: (status) => {
          bridge.emit(mainWindow?.webContents ?? null, eventChannels.solidcraftStatus, status);
          // A conversation held before the design had a file goes next to it after the first save.
          if (status.state === 'connected' && status.save === 'saved') {
            chats?.flush();
            prints?.flush();
          }
        },
        revision: (revision) => {
          bridge.emit(mainWindow?.webContents ?? null, eventChannels.mirrorRevision, revision);
          workLog?.observe({ documentId: revision.documentId, revision: revision.revision, ...revision.history });
          notes?.refresh().catch((error: unknown) => {
            log(`notes could not be read: ${(error as Error).message}`);
          });
        },
      },
    );

    bridge.handle(invokeChannels.appInfo, () => ({
      name: app.getName(),
      version: app.getVersion(),
      locale: app.getLocale(),
      platform: process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux',
      startOnHome,
    }));
    bridge.handle(invokeChannels.solidcraftStatus, () => supervisor.status());
    bridge.handle(invokeChannels.solidcraftEngine, () => engineChoice.info());
    bridge.handle(invokeChannels.solidcraftChooseEngine, async ({ automatic }) => {
      if (automatic) return { ...(await engineChoice.choose(null)), cancelled: false };
      const current = (await engineChoice.info()).path;
      const options: Electron.OpenDialogOptions = {
        title: 'SolidCraft',
        properties: ['openFile'],
        filters: process.platform === 'win32' ? [{ name: 'SolidCraft', extensions: ['exe'] }] : [],
        ...(current ? { defaultPath: current } : {}),
      };
      const picked = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      const [file] = picked.filePaths;
      if (picked.canceled || !file) return { info: await engineChoice.info(), error: null, cancelled: true };
      return { ...(await engineChoice.choose(file)), cancelled: false };
    });
    bridge.handle(invokeChannels.appRelaunch, () => {
      app.relaunch();
      app.quit();
      return undefined;
    });
    bridge.handle(invokeChannels.solidcraftRetry, () => {
      supervisor.retry();
      return undefined;
    });
    bridge.handle(invokeChannels.solidcraftStart, () => {
      supervisor.startSolidCraft();
      return undefined;
    });
    bridge.handle(invokeChannels.mirrorCurrent, () => supervisor.currentRevision());

    // Printer and material profiles (M7); the part's material lives next to its design file.
    const printProfiles = new PrintProfiles({ file: join(app.getPath('userData'), 'print-profiles.json'), designFile: () => supervisor.designPath(), log, printerName: () => (german ? 'Mein Drucker' : 'My printer') });
    prints = printProfiles;
    const profileNote = new ProfileNote();
    // The ready-to-print check (M7), as the renderer last reported it.
    const checkNote = new ProfileNote();
    let printCheck: PrintCheckReport | null = null;
    // The check as partbuddy_view shows it: a check of an older revision is still catching up.
    const checkForView = () => {
      if (!printCheck) return null;
      if (printCheck.revision !== supervisor.currentRevision()?.revision)
        return '[PartBuddy: the ready-to-print check of the latest change is still running; call partbuddy_view again in a moment.]';
      return printCheckNote(printCheck);
    };
    bridge.handle(invokeChannels.printReportCheck, (report) => {
      printCheck = report;
      return undefined;
    });
    const printChanged = () => {
      bridge.emit(mainWindow?.webContents ?? null, eventChannels.printChanged, printProfiles.part());
    };
    bridge.handle(invokeChannels.printSettings, () => printProfiles.settings());
    // Another printer or nozzle: the sizes the assistant snapped ("[auto 3×line]") follow, the user's stay (decided 2026-11-07).
    const refitSizes = async (before: PartPrint) => {
      const { printer, design } = printProfiles.part();
      if (!design.snap || (printer.nozzle === before.printer.nozzle && printer.layer === before.printer.layer)) return;
      if (!supervisor.currentRevision()) return;
      if (agent.state().agents.some((status) => status.state === 'busy')) {
        steps.mention('changed the printer while you worked; fit the sizes marked [auto …] to the new nozzle and layer height');
        log('printer changed while the assistant works; it fits the snapped sizes itself');
        return;
      }
      const changes = refit((await supervisor.parameters()).filter((parameter) => parameter.editable), printer);
      for (const change of changes)
        await steps.recordUser(describeUserAction({ kind: 'dimension', parameter: change.name, value: change.value }), () => supervisor.applyDimension(change.name, change.value, 1, true));
      if (changes.length > 0) log(`fitted ${String(changes.length)} snapped sizes to the printer`);
    };
    const savePrint = (settings: PrintSettings) => {
      const before = printProfiles.part();
      const saved = printProfiles.save(settings);
      printChanged();
      void refitSizes(before).catch((error: unknown) => {
        log(`the snapped sizes were not fitted to the printer: ${(error as Error).message}`);
      });
      return saved;
    };
    bridge.handle(invokeChannels.printSaveSettings, savePrint);
    bridge.handle(invokeChannels.printPart, () => printProfiles.part());
    bridge.handle(invokeChannels.printSetMaterial, ({ material }) => {
      const part = printProfiles.setMaterial(material);
      printChanged();
      return part;
    });

    const secrets = new SecretStore();
    let noteKey: Buffer;
    try {
      noteKey = loadNoteKey(secrets);
    } catch (error) {
      // Without the credential store the key lasts for this run; notes count as foreign after a restart.
      log(`the note key could not be kept: ${(error as Error).message}`);
      noteKey = randomBytes(32);
    }
    const notesService = new NotesService({
      design: {
        read: () => supervisor.readMetadata(),
        write: (values) => supervisor.writeMetadata(values),
        tables: () => supervisor.currentRevision()?.bodies.map((body) => body.faces) ?? [],
        designName: () => supervisor.currentRevision()?.designName ?? '',
      },
      key: noteKey,
      restoreFile: join(app.getPath('userData'), 'notes-restore.json'),
      emit: (state) => {
        bridge.emit(mainWindow?.webContents ?? null, eventChannels.notesChanged, state);
      },
      mention: (text) => workLog?.mention(text),
    });
    notes = notesService;
    bridge.handle(invokeChannels.notesCurrent, () => notesService.state());

    // SolidCraft's MCP tools for the assistant, bridged to the app the supervisor is connected to.
    // What the 3D view shows, as the renderer last reported it (for `partbuddy_view`).
    let viewState: ViewState | null = null;
    bridge.handle(invokeChannels.windowTitleBar, (colors) => {
      if (process.platform !== 'darwin') mainWindow?.setTitleBarOverlay({ ...colors, height: titleBarHeight(settingsStore.get('zoom')) });
      return undefined;
    });
    // The chosen theme drives Chromium's colour scheme, so the tokens and the window buttons follow.
    bridge.handle(invokeChannels.windowTheme, () => appearance.theme());
    bridge.handle(invokeChannels.windowSetTheme, ({ theme }) => {
      appearance.setTheme(theme);
      nativeTheme.themeSource = theme;
      return theme;
    });
    // General settings (B6): the language applies at once in the window and fully after a restart;
    // the project folder after a restart (SolidCraft gets its allowed folders when it starts).
    const generalInfo = () => {
      const chosen = general.projectsFolder();
      const override = process.env.PARTBUDDY_PROJECTS_DIR;
      const folder = override ?? chosen ?? defaultProjects;
      return {
        language: general.language(),
        systemLocale: app.getSystemLocale().slice(0, 40),
        projectsFolder: folder,
        projectsSource: override ? ('override' as const) : chosen ? ('setting' as const) : ('default' as const),
        // Both as long paths: a short 8.3 path (ADMINI~1) of the same folder needs no restart (audit A-26).
        restartNeeded: resolve(longPath(folder)) !== resolve(projects),
        setupDone: !setupNeeded || general.setupDone(),
      };
    };
    bridge.handle(invokeChannels.settingsGeneral, generalInfo);
    bridge.handle(invokeChannels.settingsRevealLog, () => {
      log('log file shown in Explorer');
      if (!testRun) shell.showItemInFolder(logFile.file);
      return undefined;
    });
    bridge.handle(invokeChannels.settingsSetLanguage, ({ language }) => {
      general.setLanguage(language);
      german = (language === 'system' ? app.getSystemLocale() : language).toLowerCase().startsWith('de');
      log(`the interface language is now ${language}`);
      return generalInfo();
    });
    bridge.handle(invokeChannels.settingsChooseProjectsFolder, async () => {
      const options: Electron.OpenDialogOptions = {
        title: german ? 'Projektordner wählen' : 'Choose the project folder',
        defaultPath: generalInfo().projectsFolder,
        properties: ['openDirectory', 'createDirectory'],
      };
      const picked = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      const [folder] = picked.filePaths;
      if (!picked.canceled && folder && existsSync(folder) && statSync(folder).isDirectory()) {
        general.setProjectsFolder(resolve(folder) === resolve(defaultProjects) ? null : folder);
        log('chose another project folder');
      }
      return generalInfo();
    });
    // Updates (B10): one quiet look after the start; download and install only on the user's word.
    const updates = new Updates(log);
    updates.onChange((state) => {
      bridge.emit(mainWindow?.webContents ?? null, eventChannels.updatesState, state);
    });
    bridge.handle(invokeChannels.updatesState, () => updates.current());
    bridge.handle(invokeChannels.updatesCheck, () => updates.check());
    bridge.handle(invokeChannels.updatesDownload, async () => {
      await updates.download();
      return undefined;
    });
    bridge.handle(invokeChannels.updatesInstall, () => {
      updates.install();
      return undefined;
    });
    if (updates.enabled && settingsStore.get('checkUpdates')) setTimeout(() => void updates.check(), 10_000);
    // Interface size, start behaviour and update check (2026-11-07): the size applies at once, the rest at the next start.
    const appSettings = () => ({ zoom: settingsStore.get('zoom'), startPage: settingsStore.get('startPage'), checkUpdates: settingsStore.get('checkUpdates'), toolDebug: settingsStore.get('toolDebug'), localStepLimit: settingsStore.get('localStepLimit') });
    const applyZoom = () => {
      const zoom = settingsStore.get('zoom');
      mainWindow?.webContents.setZoomFactor(zoom);
      if (process.platform !== 'darwin') mainWindow?.setTitleBarOverlay({ height: titleBarHeight(zoom) });
    };
    bridge.handle(invokeChannels.settingsApp, appSettings);
    bridge.handle(invokeChannels.settingsSetApp, ({ key, value }) => {
      settingsStore.set(key, value);
      if (key === 'zoom') applyZoom();
      log(`setting ${key} is now ${String(value)}`);
      return appSettings();
    });
    bridge.handle(invokeChannels.settingsFinishSetup, () => {
      general.finishSetup();
      log('the first-start setup is done');
      return generalInfo();
    });
    bridge.handle(invokeChannels.settingsResetProjectsFolder, () => {
      general.setProjectsFolder(null);
      return generalInfo();
    });
    bridge.handle(invokeChannels.viewerState, (state) => {
      viewState = state;
      return undefined;
    });
    const emitEvent = (event: AgentEvent) => {
      // A failed turn and its reason go to the log file too, where the chat points for details.
      if (event.type === 'done' && !event.ok) log(`assistant turn ended: ${event.detail ?? 'failed'}`);
      if (event.type === 'error') log(`assistant error: ${event.message.slice(0, 300)}`);
      // Do not send or save diagnostic tool output unless the user enabled it.
      const visible = event.type === 'tool' && event.decision === 'allowed' && !settingsStore.get('toolDebug')
        ? { ...event, reason: undefined }
        : event;
      bridge.emit(mainWindow?.webContents ?? null, eventChannels.agentEvent, visible);
    };
    const steps = new WorkLog({
      history: () => supervisor.history(),
      travel: (command, count) => supervisor.travel(command, count),
      emit: emitEvent,
    });
    workLog = steps;
    // Questions and plans as cards (M2a); changes wait until the user answered.
    const questions = new Questions(emitEvent, (name) => supervisor.nameNewDesign(name));
    // The assembly order (ADR 0026) lives in the open project's folder, next to the design.
    const assemblyFolder = (): string | null => {
      const project = supervisor.projectFile();
      return project && projectStore.holds(project) ? dirname(project) : null;
    };
    bridge.handle(invokeChannels.assemblyGet, () => {
      const folder = assemblyFolder();
      return folder ? readAssembly(folder, log) : null;
    });
    const saveAssembly = (plan: AssemblyPlan) => {
      const folder = assemblyFolder();
      if (!folder) throw new Error('no project is open, so there is nowhere to keep it');
      writeAssembly(folder, plan);
      log(`kept the assembly order: ${String(plan.steps.length)} steps`);
      bridge.emit(mainWindow?.webContents ?? null, eventChannels.assemblyChanged, plan);
    };
    // A mechanism that lays its part down (a screw lid on its top) says so here, so the plate view turns it as the slicer will.
    const keepMechanismFace = (body: string, face: string) => {
      const folder = assemblyFolder();
      if (!folder) return;
      keepPrintFace(folder, body, face);
      bridge.emit(mainWindow?.webContents ?? null, eventChannels.printFacesChanged, readPrintFaces(folder));
    };
    // SVG drawings sent along; the model names them and PartBuddy puts the exact contours in (drawingTool.ts).
    const drawings = new Drawings();
    // The model reads notes only through PartBuddy; results lose the note data, undo may not take a note (ADR 0020).
    const track = (upstream: UpstreamTools) =>
      questions.tools(
        steps.tools(
          withDesignTool(
            withAssemblyTool(
              withViewTool(guardNotes(withBlockTool(withMechanismTool(withDrawings(upstream, drawings), () => printProfiles.part().printer.nozzle, keepMechanismFace), keepMechanismFace), (trial) => supervisor.trialSteps(trial)), () => viewState, () => notesService.forView(), checkForView),
              () => viewState?.bodies.map((body) => body.name) ?? [],
              saveAssembly,
            ),
            (change) => {
              const part = printProfiles.setDesign(change);
              log(`design rules of the project: ${JSON.stringify(change)}`);
              printChanged();
              return part.design;
            },
          ),
        ),
      );
    let toolsCache: { port: number; tools: UpstreamTools; close(): Promise<void> } | null = null;
    const tools = async () => {
      const headless = supervisor.headlessTools();
      if (headless) return track(headless);
      const port = supervisor.connectedPort();
      const executable = findExecutable(engineEnvironment);
      if (port === null || !executable) return null;
      if (toolsCache?.port !== port) {
        await toolsCache?.close();
        const next = new SolidCraftTools({ solidcraftExe: executable, port, allowPath: projects, env: process.env });
        await next.connect();
        toolsCache = { port, tools: track(next), close: () => next.close() };
      }
      return toolsCache.tools;
    };
    let assistant: Assistant | null = null;
    const changed = () => assistant?.changed();
    // The user's choice to allow API billing for Claude Code (off by default), kept per installation.
    // API billing for Claude Code and the model and effort per route for new chats (B1).
    const assistantSettings = new AssistantSettings(settingsStore);
    const apiBilling = {
      get: () => assistantSettings.apiBilling(),
      set: (allow: boolean) => {
        assistantSettings.setApiBilling(allow);
      },
    };
    const claude = new AgentService(
      { env: process.env, home: homedir(), workDir: join(app.getPath('userData'), 'agent'), apiBilling, log, tools, choices: assistantSettings, research: () => assistantSettings.webResearch() },
      { status: changed, event: emitEvent },
    );
    // ChatGPT tokens live only in the Windows credential store (ADR 0011, ADR 0015).
    const account = new ChatGptAccount({
      store: secrets,
      hostId: () => hostId(join(app.getPath('userData'), 'chatgpt-host-id')),
      openBrowser: async (url) => {
        if (!url.startsWith('https://auth.openai.com/')) throw new Error('refused to open an unexpected sign-in address');
        await shell.openExternal(url);
      },
      onStatus: changed,
    });
    account.load();
    const chatgpt = new ChatGptAgent({ account, tools, event: emitEvent, changed, log, choices: assistantSettings, research: () => assistantSettings.webResearch() });
    // Local models (F8): Ollama and Strata on this machine; PARTBUDDY_OLLAMA_URL and PARTBUDDY_STRATA_URL point tests elsewhere.
    const local = new LocalAgent({
      tools,
      event: emitEvent,
      changed,
      log,
      contextSize: () => assistantSettings.ollamaContextSize(),
      stepLimit: () => settingsStore.get('localStepLimit'),
      choices: assistantSettings,
      ...(process.env.PARTBUDDY_OLLAMA_URL ? { url: process.env.PARTBUDDY_OLLAMA_URL } : {}),
      ...(process.env.PARTBUDDY_STRATA_URL ? { strataUrl: process.env.PARTBUDDY_STRATA_URL } : {}),
    });
    assistant = new Assistant({ 'claude-code': claude, chatgpt, local }, (state) => {
      bridge.emit(mainWindow?.webContents ?? null, eventChannels.agentStatus, state);
    });
    const agent = assistant;
    bridge.handle(invokeChannels.agentStatus, () => agent.state());
    bridge.handle(invokeChannels.agentRefresh, () => agent.refresh());
    bridge.handle(invokeChannels.agentSelect, ({ agent: kind }) => {
      // The other route starts its own conversation, without the open question.
      questions.clear();
      return agent.select(kind);
    });
    bridge.handle(invokeChannels.agentChooseModel, ({ choice, asDefault }) => agent.chooseModel(choice, asDefault));
    bridge.handle(invokeChannels.agentAllowApiBilling, async ({ allow }) => {
      await claude.allowApiBilling(allow);
      return agent.state();
    });
    // Versions (B5): a copy of the saved design in the project, by the user, at an export and
    // before a request to the assistant (automatic ones only when the design changed since).
    const versions = new VersionStore();
    const keepVersion = async (reason: VersionReason, label: string, skipUnchanged: boolean): Promise<string | null> => {
      const file = await supervisor.saveNow();
      if (!file || !projectStore.holds(file) || !existsSync(file)) return null;
      return versions.save(file, reason, label, skipUnchanged);
    };
    // A photo (F6) is kept in the project's "photos" folder, so SolidCraft can use it by path.
    const keepPhoto = (png: Uint8Array, when: Date, index: number): string | null => {
      const project = supervisor.projectFile();
      if (!project || !projectStore.holds(project)) return null;
      try {
        const file = photoFile(dirname(project), when, index);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, png);
        return file;
      } catch (error) {
        log(`photo not kept: ${(error as Error).message}`);
        return null;
      }
    };
    // Sketches (F10) live in the open project's folder; without a project there is nowhere to keep them.
    const projectFolder = (): string | null => {
      const project = supervisor.projectFile();
      return project && projectStore.holds(project) ? dirname(project) : null;
    };
    bridge.handle(invokeChannels.sketchList, () => {
      const folder = projectFolder();
      return folder ? listSketches(folder, log) : [];
    });
    bridge.handle(invokeChannels.sketchLoad, ({ id }) => {
      const folder = projectFolder();
      return folder ? loadSketch(folder, id, log) : null;
    });
    bridge.handle(invokeChannels.agentSend, async ({ text, selections, answer, sketch, sketchElements, sketchState, photos, drawing }) => {
      // The drawing's text is untrusted: read here again, and only its clean form is kept.
      const read = drawing ? parseDrawing(drawing.svg) : null;
      if (read && !read.ok) {
        log(`drawing refused: ${read.detail}`);
        throw new Error(`the drawing cannot be used: ${read.detail}`);
      }
      let drawingLine: string | null = null;
      if (drawing && read?.ok) {
        const kept = { name: drawing.name, drawing: read.drawing, width: drawing.width };
        const id = drawings.keep(kept);
        log(`drawing ${id} kept: ${String(read.drawing.shapes.length)} shapes, ${String(drawing.width)} mm wide`);
        drawingLine = drawingNote(id, kept, read.drawing.skipped);
      }
      const folder = projectFolder();
      if (sketch && sketchState && folder) {
        try {
          keepSketch(folder, sketchState, sketch);
        } catch (error) {
          log(`sketch not kept: ${(error as Error).message}`);
        }
      }
      // The design as it was before the assistant changes it; a failure never stops the request.
      await keepVersion('assistant', text.replace(/\s+/g, ' ').slice(0, 120), true).catch((error: unknown) => {
        log(`no version before the request: ${(error as Error).message}`);
      });
      const conversation = agent.conversation();
      const sentAt = new Date();
      const lines = [
        // Once after a restart: what the earlier conversation about this design was about.
        chats?.takeDigest() ?? null,
        // The printer and material (M7), once per conversation and again after a change.
        profileNote.take(conversation.route, conversation.fresh, printNote(printProfiles.part())),
        printCheck ? checkNote.take(conversation.route, conversation.fresh, printCheckNote(printCheck)) : null,
        questions.answer(answer),
        steps.takeNote(),
        notesService.selectionNote(selections ?? []),
        sketch ? sketchNote(sketchElements) : null,
        photos ? photoNote(photos.map((png, i) => keepPhoto(png, sentAt, i))) : null,
        drawingLine,
      ].filter((line): line is string => line !== null);
      try {
        await agent.send(text, selections, lines.length > 0 ? lines.join('\n') : null, photos ?? (drawing ? [drawing.png] : sketch ? [sketch] : []), photos ? 'photo' : drawing ? 'drawing' : 'sketch');
      } catch (error) {
        profileNote.forget();
        checkNote.forget();
        throw error;
      }
      return undefined;
    });
    bridge.handle(invokeChannels.agentStop, async () => {
      await agent.stop();
      return undefined;
    });

    // Ollama context window settings
    bridge.handle(invokeChannels.agentOllamaContext, () =>
      assistantSettings.ollamaContextSize()
    );

    // Persist the selected Ollama context size and refresh the model status.
    bridge.handle(invokeChannels.agentSetOllamaContext, ({ size }) => {
      assistantSettings.setOllamaContextSize(size);
      agent.changed();
      return assistantSettings.ollamaContextSize();
    });

    // Research on the web (B7): Claude Code reads the switch when a conversation starts, ChatGPT per request.
    bridge.handle(invokeChannels.agentResearch, () => assistantSettings.webResearch());
    bridge.handle(invokeChannels.agentSetResearch, ({ allow }) => {
      assistantSettings.setWebResearch(allow);
      log(`web research ${allow ? 'allowed' : 'turned off'}`);
      return assistantSettings.webResearch();
    });
    // Reset per section of the settings, or all of them; the print profiles are the user's data and stay.
    bridge.handle(invokeChannels.settingsReset, async ({ section }) => {
      if (section === 'general' || section === 'all') {
        settingsStore.reset(RESET_KEYS.general);
        nativeTheme.themeSource = appearance.theme();
        applyZoom();
        german = app.getSystemLocale().toLowerCase().startsWith('de');
      }
      if (section === 'assistant' || section === 'all') {
        settingsStore.reset(RESET_KEYS.assistant);
        printProfiles.save({ ...printProfiles.settings(), supportFree: true, design: DESIGN_DEFAULTS });
        changed();
      }
      if (section === 'solidcraft' || section === 'all') await engineChoice.choose(null);
      if (section === 'print') savePrint(printProfiles.startingProfiles());
      log(`settings reset: ${section}`);
      return generalInfo();
    });
    bridge.handle(invokeChannels.agentSignIn, () => {
      agent.signIn();
      return undefined;
    });
    bridge.handle(invokeChannels.agentSignOut, async () => {
      await agent.signOut();
      return undefined;
    });
    void agent.refresh();

    // The user's own actions on the design (ADR 0016). They wait while the assistant works, so
    // the two never change the design at the same time.
    const assistantIdle = () => {
      if (agent.state().agents.some((status) => status.state === 'busy')) throw new Error('the assistant is working on the design');
    };
    bridge.handle(invokeChannels.designUndo, async () => {
      assistantIdle();
      await steps.userHistory('undo', () => supervisor.undo());
      return undefined;
    });
    bridge.handle(invokeChannels.designRedo, async () => {
      assistantIdle();
      await steps.userHistory('redo', () => supervisor.redo());
      return undefined;
    });
    bridge.handle(invokeChannels.designExport, async ({ format }) => {
      const name = safeDesignFileName(supervisor.currentRevision()?.designName ?? '');
      // Exports go to the project's own "exports" folder (B2).
      const project = supervisor.projectFile();
      const folder = project ? join(dirname(project), 'exports') : projects;
      mkdirSync(folder, { recursive: true });
      const options = { title: 'Export', defaultPath: join(folder, `${name}.${format}`), filters: [EXPORT_FILTERS[format]] };
      const choice = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
      if (choice.canceled || !choice.filePath) return null;
      await supervisor.exportDesign(format, choice.filePath);
      log(`exported the design as ${format}`);
      await keepVersion('export', basename(choice.filePath), true).catch((error: unknown) => {
        log(`no version at the export: ${(error as Error).message}`);
      });
      return { file: basename(choice.filePath) };
    });
    // A recording of the joints playing: the bytes come from the view, the user says where they go.
    bridge.handle(invokeChannels.designSaveVideo, async ({ bytes, format }) => {
      const name = safeDesignFileName(supervisor.currentRevision()?.designName ?? '');
      const project = supervisor.projectFile();
      const folder = project ? join(dirname(project), 'exports') : projects;
      mkdirSync(folder, { recursive: true });
      const options = { title: 'Video', defaultPath: join(folder, `${name}.${format}`), filters: [{ name: format.toUpperCase(), extensions: [format] }] };
      const choice = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
      if (choice.canceled || !choice.filePath) return null;
      writeFileSync(choice.filePath, bytes);
      log(`saved a recording of the view as ${format}, ${String(bytes.length)} bytes`);
      return { file: basename(choice.filePath) };
    });
    // The sharing package (F5): everything Printables or MakerWorld asks for, in one new folder.
    bridge.handle(invokeChannels.designShare, async () => {
      const design = await supervisor.saveNow();
      if (!design || !projectStore.holds(design)) throw new Error('the design has no project yet');
      const name = safeDesignFileName(supervisor.currentRevision()?.designName ?? basename(design, '.sc'));
      const day = new Date().toISOString().slice(0, 10);
      const folder = freeFolder(join(dirname(design), 'exports'), `${name} ${german ? 'Teilen' : 'share'} ${day}`);
      mkdirSync(folder, { recursive: true });
      try {
        const model = `${name}.3mf`;
        const step = `${name}.step`;
        await supervisor.exportDesign('3mf', join(folder, model));
        await supervisor.exportDesign('step', join(folder, step));
        log('sharing package: 3MF and STEP written');
        // Each picture is its own SolidCraft run that rebuilds the design (about 20 s for a housing), so
        // the four run side by side.
        const pictures = await Promise.all(
          (['iso', 'front', 'top', 'right'] as const).map(async (view) => {
            const picture = `${name}-${view}.png`;
            await supervisor.snapshot(design, view, join(folder, picture));
            return picture;
          }),
        );
        log('sharing package: pictures written');
        const print = printProfiles.part();
        const parameters = (await supervisor.parameters().catch(() => [])).filter((parameter) => parameter.editable);
        const description = shareDescription({
          name: supervisor.currentRevision()?.designName ?? name,
          language: german ? 'de' : 'en',
          // Copies and filament from the parts list (P6), where the user noted them.
          bodies: await supervisor
            .bodySizes()
            .then((sizes) => {
              const { parts } = readParts(dirname(design));
              return sizes.map((body) => ({ ...body, quantity: parts[body.name]?.quantity ?? 1, filament: parts[body.name]?.filament ?? '' }));
            })
            .catch(() => []),
          hardware: await supervisor.hardware().catch((error: unknown) => {
            log(`no parts list in the sharing package: ${(error as Error).message}`);
            return [];
          }),
          parameters: parameters.map((parameter) => ({ name: parameter.name, value: parameter.value, unit: parameter.unit, comment: withoutFitMark(parameter.comment.replace(/\s*\[[^\]]*\.\.[^\]]*\]\s*/, ' ')) || null })),
          material: print.material.name,
          layer: print.printer.layer,
          nozzle: print.printer.nozzle,
          check: printCheck ? { status: printCheck.status, overhang: printCheck.findings.some((finding) => finding.kind === 'overhang') } : null,
          files: { model, step, pictures },
        });
        writeFileSync(join(folder, german ? 'Beschreibung.md' : 'description.md'), description, 'utf8');
      } catch (error) {
        rmSync(folder, { recursive: true, force: true });
        log(`no sharing package: ${(error as Error).message}`);
        throw error;
      }
      log('saved a sharing package');
      // Explorer opens on the folder, except in tests, which run without disturbing the screen.
      if (!testRun) void shell.openPath(folder);
      return { folder: basename(folder) };
    });
    bridge.handle(invokeChannels.designProbeDimension, ({ target, current, value }) => {
      assistantIdle();
      return supervisor.probeDimension(target, current, value);
    });
    bridge.handle(invokeChannels.designApplyDimension, async ({ parameter, value, factor, label }) => {
      assistantIdle();
      await steps.recordUser(describeUserAction({ kind: 'dimension', parameter: label ?? parameter, value: value * factor }), () => supervisor.applyDimension(parameter, value, factor));
      log('changed a dimension directly');
      return undefined;
    });
    bridge.handle(invokeChannels.designPreviewAction, (action) => {
      assistantIdle();
      return supervisor.previewAction(action);
    });
    bridge.handle(invokeChannels.designApplyAction, async (action) => {
      assistantIdle();
      const phrase = describeUserAction({
        kind: 'action',
        action: action.action,
        size: action.size,
        count: action.points.length,
        depth: action.action === 'hole' ? action.depth : undefined,
      });
      await steps.recordUser(phrase, () => supervisor.applyAction(action));
      log(`applied ${action.action} directly`);
      return undefined;
    });
    bridge.handle(invokeChannels.designMeasure, ({ items }) => supervisor.measure(items));
    bridge.handle(invokeChannels.designClearance, ({ bodies, gap }) => supervisor.clearance(bodies, gap));
    bridge.handle(invokeChannels.designSweepJoints, ({ sweeps }) => supervisor.sweepJoints(sweeps));
    bridge.handle(invokeChannels.designDriveJoint, async ({ joint, index, value, unit, name }) => {
      assistantIdle();
      await steps.recordUser(describeUserAction({ kind: 'jointMove', name, value, unit }), () => supervisor.driveJoint(joint, index, value));
      log('moved a joint directly');
      return undefined;
    });
    bridge.handle(invokeChannels.designTimeline, async (command) => {
      assistantIdle();
      const phrase =
        command.action === 'rollTo'
          ? describeUserAction({ kind: 'rollTo', position: command.position })
          : describeUserAction({ kind: 'suppress', suppressed: command.suppressed });
      await steps.recordUser(phrase, () => supervisor.timeline(command));
      return undefined;
    });
    bridge.handle(invokeChannels.designGoToStep, async ({ step }) => {
      assistantIdle();
      await steps.goTo(step);
      log('went back to a step of the work log');
      return undefined;
    });
    bridge.handle(invokeChannels.designDimensions, ({ features }) => supervisor.dimensionMarks(features));
    bridge.handle(invokeChannels.designParameters, () => supervisor.parameters());
    const chatArchive = new ChatArchive({ designFile: () => supervisor.designPath(), log });
    chats = chatArchive;
    bridge.handle(invokeChannels.chatLoad, () => chatArchive.load());

    // Projects (B2): switching saves the design, the conversation and the print settings first;
    // the next project starts a new conversation with the assistant.
    const switchProject = async (prepare: (current: string | null) => Promise<string | null>) => {
      chatArchive.flush();
      printProfiles.flush();
      await agent.newConversation();
      questions.clear();
      profileNote.forget();
      checkNote.forget();
      await supervisor.switchProject(prepare);
    };
    const openProject = () => {
      const file = supervisor.projectFile();
      return file && projectStore.holds(file) ? file : null;
    };
    /** A start page project by its folder (P1), or the open one; `open` tells whether it is open now. */
    const targetOf = (folder: string | undefined): { design: string | null; open: boolean } => {
      const current = openProject();
      if (folder === undefined) return { design: current, open: true };
      const design = projectStore.designOfFolder(folder);
      if (!design) throw new Error('not a project in the project folder');
      return { design, open: current !== null && resolve(current) === resolve(design) };
    };
    bridge.handle(invokeChannels.projectInfo, () => {
      const file = openProject();
      return file ? { name: basename(file, '.sc'), folder: dirname(file) } : null;
    });
    bridge.handle(invokeChannels.projectNew, async () => {
      await switchProject(() => Promise.resolve(null));
      log('started a new project');
      return undefined;
    });
    bridge.handle(invokeChannels.projectOpen, async () => {
      const options: Electron.OpenDialogOptions = {
        title: german ? 'Projekt öffnen' : 'Open project',
        defaultPath: projects,
        properties: ['openFile'],
        filters: [{ name: 'SolidCraft', extensions: ['sc'] }],
      };
      const picked = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      const [file] = picked.filePaths;
      if (picked.canceled || !file) return { opened: false, imported: false };
      if (!file.toLowerCase().endsWith('.sc') || !existsSync(file) || !statSync(file).isFile()) throw new Error('not a SolidCraft design');
      // A design from elsewhere is copied into a project of its own; the original stays untouched.
      const imported = !projectStore.holds(file);
      await switchProject(() => Promise.resolve(imported ? projectStore.importDesign(file) : file));
      log(imported ? 'copied a design into a new project and opened it' : 'opened a project');
      return { opened: true, imported };
    });
    bridge.handle(invokeChannels.projectRename, async ({ name, folder }) => {
      const target = targetOf(folder);
      const file = target.design;
      if (!file) return { ok: false, reason: 'noProject' };
      const usable = projectStore.usableName(name, file);
      if (!usable.ok) return { ok: false, reason: usable.reason };
      if (usable.name === basename(file, '.sc')) return { ok: true };
      if (!target.open) {
        await projectStore.rename(file, usable.name);
        log('renamed a project of the start page');
        return { ok: true };
      }
      await switchProject((current) => (current ? projectStore.rename(current, usable.name) : Promise.resolve(null)));
      log('renamed the project');
      return { ok: true };
    });
    bridge.handle(invokeChannels.projectDuplicate, async ({ folder }) => {
      const target = targetOf(folder);
      if (!target.design) throw new Error('the design has no project yet');
      if (folder !== undefined) {
        // From the start page a project is only copied; the open one stays open.
        projectStore.duplicate(target.design, german ? 'Kopie' : 'copy');
        log('duplicated a project of the start page');
        return undefined;
      }
      await switchProject((current) => Promise.resolve(current ? projectStore.duplicate(current, german ? 'Kopie' : 'copy') : null));
      log('duplicated the project');
      return undefined;
    });
    bridge.handle(invokeChannels.projectReveal, ({ folder }) => {
      const file = targetOf(folder).design;
      if (testRun) return undefined;
      if (file) shell.showItemInFolder(file);
      else void shell.openPath(projects);
      return undefined;
    });
    bridge.handle(invokeChannels.projectTrash, async ({ folder }) => {
      const target = targetOf(folder);
      if (!target.design) throw new Error('the design has no project yet');
      if (!target.open) {
        await projectTrash.put(target.design);
        log('moved a project of the start page to the recycle bin');
        return undefined;
      }
      await switchProject(async (current) => {
        // Only a project folder inside the project folder goes to the recycle bin.
        if (current && projectStore.holds(current)) await projectTrash.put(current);
        return null;
      });
      log('moved the project to the recycle bin');
      return undefined;
    });
    // The project as one file (P3); the open project is saved first, so the package holds its newest state.
    bridge.handle(invokeChannels.projectExportPackage, async ({ folder }) => {
      const target = targetOf(folder);
      if (!target.design) throw new Error('the design has no project yet');
      if (target.open) {
        chatArchive.flush();
        printProfiles.flush();
        await supervisor.saveNow();
      }
      const name = basename(target.design, '.sc');
      const options: Electron.SaveDialogOptions = {
        title: german ? 'Projekt exportieren' : 'Export project',
        defaultPath: join(app.getPath('documents'), `${name}.${PACKAGE_EXTENSION}`),
        filters: [{ name: german ? 'PartBuddy-Projekt' : 'PartBuddy project', extensions: [PACKAGE_EXTENSION] }],
      };
      const picked = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return { saved: false };
      exportPackage(target.design, picked.filePath, app.getVersion());
      log('exported a project package');
      return { saved: true };
    });
    bridge.handle(invokeChannels.projectSetMeta, ({ folder, favorite, tags }) => {
      const design = projectStore.designOfFolder(folder);
      if (!design) throw new Error('not a project in the project folder');
      writeMeta(dirname(design), { ...(favorite === undefined ? {} : { favorite }), ...(tags === undefined ? {} : { tags }) });
      return undefined;
    });
    bridge.handle(invokeChannels.projectParts, () => {
      const file = openProject();
      return file ? readParts(dirname(file)) : { parts: {}, bodies: [] };
    });
    bridge.handle(invokeChannels.projectSetPart, ({ body, note, bodies }) => {
      const file = openProject();
      if (!file) throw new Error('the design has no project yet');
      return writePart(dirname(file), body, note, bodies);
    });
    bridge.handle(invokeChannels.projectTrashList, () => projectTrash.list());
    bridge.handle(invokeChannels.projectTrashRestore, async ({ id }) => {
      await projectTrash.restore(id);
      log('restored a project from the recycle bin');
      return undefined;
    });
    bridge.handle(invokeChannels.projectTrashEmpty, async () => {
      log(`handed ${String(await projectTrash.empty())} deleted projects to the Windows recycle bin`);
      return undefined;
    });
    // The start page (B3): the projects with preview and light, opening one, importing a design.
    bridge.handle(invokeChannels.projectList, () => projectStore.list());
    bridge.handle(invokeChannels.projectOpenFolder, async ({ folder }) => {
      const design = projectStore.designOfFolder(folder);
      if (!design) throw new Error('not a project in the project folder');
      if (supervisor.projectFile() === design) return { opened: true, imported: false };
      await switchProject(() => Promise.resolve(design));
      log('opened a project from the start page');
      return { opened: true, imported: false };
    });
    // Import (B4): the open dialog offers every kind PartBuddy reads, or only files to insert.
    const pickImport = async (insert: boolean): Promise<string | null> => {
      const kinds: ImportKind[] = insert ? ['step', 'mesh'] : ['package', 'design', 'step', 'mesh'];
      const names: Record<ImportKind, string> = { package: german ? 'PartBuddy-Projekt' : 'PartBuddy project', design: 'SolidCraft', step: 'STEP, IGES', mesh: 'STL, 3MF, OBJ' };
      const options: Electron.OpenDialogOptions = {
        title: insert ? (german ? 'Datei einfügen' : 'Insert file') : german ? 'Importieren' : 'Import',
        defaultPath: app.getPath('documents'),
        properties: ['openFile'],
        filters: [
          { name: german ? 'Alle unterstützten Dateien' : 'All supported files', extensions: kinds.flatMap((kind) => [...IMPORT_EXTENSIONS[kind]]) },
          ...kinds.map((kind) => ({ name: names[kind], extensions: [...IMPORT_EXTENSIONS[kind]] })),
        ],
      };
      const picked = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      const [file] = picked.filePaths;
      return picked.canceled || !file ? null : file;
    };
    bridge.handle(invokeChannels.projectImport, async ({ path }) => {
      const file = path ?? (await pickImport(false));
      if (!file) return { opened: false, imported: false };
      const kind = checkImportFile(file);
      // Always a copy, also of a design inside the project folder: importing never moves the original.
      let target: string;
      if (kind === 'design') target = projectStore.importDesign(file);
      else if (kind === 'package') target = await importPackage(file, projectStore);
      else {
        // The new design is made before the switch, so a file SolidCraft cannot read leaves the open project as it is.
        target = projectStore.newDesignFile(importName(file));
        try {
          await supervisor.designFromFile(file, kind, target);
        } catch (error) {
          rmSync(dirname(target), { recursive: true, force: true });
          throw error;
        }
      }
      await switchProject(() => Promise.resolve(target));
      log(kind === 'design' ? 'imported a design into a new project' : `made a new project from a ${kind} file`);
      return { opened: true, imported: true };
    });
    // Tolerance assistant: test pieces for the printer in the settings draft, built beside the open design.
    const testPiecesDesign = async ({ nozzle, layer }: { nozzle: number; layer: number }) => {
      const design = join(cacheDirectory(), 'test-pieces', `test-pieces-${String(nozzle)}-${String(layer)}.sc`);
      if (!existsSync(design)) await supervisor.designFromSteps(testPieceSteps({ nozzle, layer }), design);
      return design;
    };
    bridge.handle(invokeChannels.printTestPiecesPicture, async (printer) => {
      try {
        const design = await testPiecesDesign(printer);
        const picture = design.replace(/\.sc$/, '.png');
        if (!existsSync(picture)) await supervisor.snapshot(design, 'iso', picture);
        return { picture: `data:image/png;base64,${readFileSync(picture).toString('base64')}` };
      } catch (error) {
        log(`no picture of the test pieces: ${(error as Error).message}`);
        return { picture: null };
      }
    });
    bridge.handle(invokeChannels.printTestPiecesExport, async ({ nozzle, layer, slicer }) => {
      const steps = testPieceSteps({ nozzle, layer });
      const name = german ? 'Prüfkörper' : 'Test pieces';
      if (slicer) {
        const file = join(cacheDirectory(), 'test-pieces', `${name}.3mf`);
        await supervisor.designFromSteps(steps, file);
        const opened = await supervisor.openInSlicer(slicer, file);
        log(`opened the test pieces in ${opened}`);
        return { file: null, slicer: opened };
      }
      const options = { title: name, defaultPath: join(projects, `${name}.3mf`), filters: [EXPORT_FILTERS['3mf']] };
      const choice = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
      if (choice.canceled || !choice.filePath) return null;
      await supervisor.designFromSteps(steps, choice.filePath);
      log('saved the test pieces as 3MF');
      return { file: basename(choice.filePath), slicer: null };
    });
    // Templates (F3): the template's script becomes the design of a new project, then it opens.
    bridge.handle(invokeChannels.projectFromTemplate, async ({ template, name }) => {
      const target = projectStore.newDesignFile(name);
      try {
        await supervisor.designFromSteps(templateSteps(template, german), target);
      } catch (error) {
        rmSync(dirname(target), { recursive: true, force: true });
        throw error;
      }
      await switchProject(() => Promise.resolve(target));
      // A part the template lays down for printing (the stop on its top) lies so on the plate as well.
      for (const { body, point } of templatePrintFaces(template, german)) {
        const face = await supervisor.printFaceName(body, point).catch((error: unknown) => {
          log(`print face of ${body} not read: ${(error as Error).message}`);
          return null;
        });
        if (face) keepMechanismFace(body, face);
        else log(`the template's print face of ${body} is not kept for the plate view`);
      }
      log(`made a new project from the template ${template}`);
      return { opened: true, imported: false };
    });
    bridge.handle(invokeChannels.designInsert, async ({ path }) => {
      assistantIdle();
      const file = path ?? (await pickImport(true));
      if (!file) return { inserted: false, name: null, bodies: [] };
      const kind = checkImportFile(file);
      if (kind === 'design' || kind === 'package') throw new Error('a SolidCraft design or project package opens as a project of its own');
      const name = basename(file).slice(0, 255);
      let bodies: string[] = [];
      await steps.recordUser(describeUserAction({ kind: 'insertFile', name }), async () => {
        bodies = await supervisor.insertFile(file, kind);
      });
      log(`inserted a ${kind} file into the design`);
      return { inserted: true, name, bodies: bodies.slice(0, 500) };
    });
    // Function blocks (F1): previewed like actions, built as one step of the work log.
    bridge.handle(invokeChannels.designPreviewBlock, (block) => {
      assistantIdle();
      return supervisor.previewBlock(block);
    });
    bridge.handle(invokeChannels.designApplyBlock, async (block) => {
      assistantIdle();
      await steps.recordUser(blockPhrase(block), () => supervisor.applyBlock(block));
      log(`built the function block ${block.block}`);
      return undefined;
    });
    // Moving a placed logo from the selection dock: read, previewed, applied as one step of the work log.
    bridge.handle(invokeChannels.designLogoAt, ({ point }) => supervisor.logoAt(point));
    bridge.handle(invokeChannels.designPreviewLogoMove, (move) => {
      assistantIdle();
      return supervisor.previewLogoMove(move);
    });
    bridge.handle(invokeChannels.designMoveLogo, async (move) => {
      assistantIdle();
      const name = logoTitle(move.logo).slice(0, 40);
      const only = move.by === null && move.centre === null;
      const phrase: StepPhrase =
        only && move.depth
          ? { key: 'logoDepth' as const, values: { name, depth: move.depth } }
          : only && move.rotate
            ? { key: 'logoRotated' as const, values: { name, angle: move.rotate } }
            : only && move.width
              ? { key: 'logoResized' as const, values: { name, width: move.width } }
              : { key: 'logoMoved' as const, values: { name } };
      await steps.recordUser(phrase, () => supervisor.moveLogo(move));
      log('moved a logo');
      return undefined;
    });
    // To the slicer (B8): through SolidCraft's slicer detection; the print face is SolidCraft's own.
    bridge.handle(invokeChannels.designSlicers, () => supervisor.slicers());
    bridge.handle(invokeChannels.designSendToSlicer, async ({ slicer }) => {
      const name = await supervisor.sendToSlicer(slicer);
      log(`opened the design in ${name}`);
      return { name };
    });
    bridge.handle(invokeChannels.designPrintFaces, () => {
      const folder = assemblyFolder();
      return folder ? readPrintFaces(folder) : {};
    });
    bridge.handle(invokeChannels.designPrintFace, async ({ body, point, face }) => {
      assistantIdle();
      await steps.recordUser(describeUserAction({ kind: 'printFace', cleared: point === null }), () => supervisor.setPrintFace(body, point));
      const folder = assemblyFolder();
      if (folder) {
        try {
          keepPrintFace(folder, body, point === null ? null : (face ?? null));
        } catch (error) {
          log(`print face not kept for the plate view: ${(error as Error).message}`);
        }
      }
      log(point ? 'set a print face' : 'cleared a print face');
      return undefined;
    });
    // Standard parts (B7): seated in a hole as counterparts, one step of the work log.
    bridge.handle(invokeChannels.designPartsLibrary, () => supervisor.partsLibrary());
    bridge.handle(invokeChannels.designInsertPart, async (part) => {
      assistantIdle();
      let body: string | null = null;
      const name = `${part.size}${part.length ? `×${String(part.length)}` : ''}`;
      await steps.recordUser(describeUserAction({ kind: 'standardPart', name }), async () => {
        body = await supervisor.insertPart(part);
      });
      log('seated a standard part');
      return { body };
    });
    bridge.handle(invokeChannels.designRepair, async ({ body }) => {
      assistantIdle();
      try {
        await steps.recordUser(describeUserAction({ kind: 'convertMesh', body }), () => supervisor.convertMesh(body));
        log('converted a mesh body to faces');
        return { ok: true };
      } catch (error) {
        const detail = (error as Error).message.replace(/^\S+ failed: /, '').slice(0, 500);
        if (/must be closed/i.test(detail)) return { ok: false, reason: 'openMesh', detail };
        return { ok: false, reason: 'other', detail };
      }
    });
    bridge.handle(invokeChannels.projectVersions, () => {
      const file = openProject();
      return file ? versions.list(file) : [];
    });
    bridge.handle(invokeChannels.projectSaveVersion, async ({ label }) => {
      if (!openProject()) throw new Error('the design has no project yet');
      if (!(await keepVersion('manual', label, false))) throw new Error('the design could not be saved');
      log('saved a version');
      return undefined;
    });
    bridge.handle(invokeChannels.projectRestoreVersion, async ({ id }) => {
      assistantIdle();
      const design = openProject();
      const file = design ? versions.fileOf(design, id) : null;
      if (!design || !file) throw new Error('not a version of the open project');
      // The state before stays as a version, so a restore can be taken back.
      await keepVersion('restore', german ? 'Vor dem Wiederherstellen' : 'Before restoring', true);
      await switchProject(async (current) => {
        if (current) await whenFree(() => copyFileSync(file, current));
        return current;
      });
      log('restored a version');
      return undefined;
    });
    bridge.handle(invokeChannels.projectNameVersion, ({ id, label }) => {
      const design = openProject();
      if (!design) throw new Error('not a version of the open project');
      versions.name(design, id, label);
      log('named a version');
      return undefined;
    });
    bridge.handle(invokeChannels.projectVersionAsProject, async ({ id }) => {
      const design = openProject();
      const file = design ? versions.fileOf(design, id) : null;
      if (!design || !file) throw new Error('not a version of the open project');
      const label = versions.list(design).find((version) => version.id === id)?.label || (german ? 'Version' : 'version');
      const target = projectStore.fromVersion(design, file, label);
      await switchProject(() => Promise.resolve(target));
      log('opened a version as a new project');
      return undefined;
    });
    bridge.handle(invokeChannels.projectCompareVersion, async ({ id }) => {
      const design = openProject();
      const file = design ? versions.fileOf(design, id) : null;
      if (!design || !file) throw new Error('not a version of the open project');
      return summarizeComparison(await supervisor.compareWith(file));
    });
    bridge.handle(invokeChannels.projectSavePreview, ({ documentId, revision, png, check }) => {
      // Only a picture of the design that is open now goes into its project, never one that
      // arrives after a switch.
      const current = supervisor.currentRevision();
      const file = openProject();
      if (!file || !current || current.documentId !== documentId || revision > current.revision) return undefined;
      if (!projectStore.writePreview(file, Buffer.from(png, 'base64'), check)) log('a preview picture was refused');
      return undefined;
    });
    bridge.handle(invokeChannels.chatSave, ({ items }) => {
      chatArchive.save(items);
      return undefined;
    });
    bridge.handle(invokeChannels.designProbeParameter, ({ parameter, value, body }) => {
      assistantIdle();
      return supervisor.probeParameter(parameter, value, body);
    });
    bridge.handle(invokeChannels.designRenameBody, async ({ body, name }) => {
      assistantIdle();
      await supervisor.renameBody(body, name);
      log('renamed a body');
      return undefined;
    });
    bridge.handle(invokeChannels.designVisibility, async (command) => {
      await supervisor.visibility(command);
      return undefined;
    });
    // The user's notes (M2b); like every change of the design they wait while the assistant works.
    bridge.handle(invokeChannels.notesAdd, async ({ selection, text }) => {
      assistantIdle();
      await notesService.add(selection, text);
      return undefined;
    });
    bridge.handle(invokeChannels.notesEdit, async ({ id, text }) => {
      assistantIdle();
      await notesService.edit(id, text);
      return undefined;
    });
    bridge.handle(invokeChannels.notesDelete, async ({ id }) => {
      assistantIdle();
      await notesService.remove(id);
      return undefined;
    });
    bridge.handle(invokeChannels.notesAccept, async ({ id }) => {
      assistantIdle();
      await notesService.accept(id);
      return undefined;
    });
    bridge.handle(invokeChannels.notesReattach, async ({ id, selection }) => {
      assistantIdle();
      await notesService.reattach(id, selection);
      return undefined;
    });
    bridge.handle(invokeChannels.notesRestore, async ({ id }) => {
      assistantIdle();
      await notesService.restoreNote(id);
      return undefined;
    });
    bridge.handle(invokeChannels.notesDismiss, async ({ id }) => {
      await notesService.dismiss(id);
      return undefined;
    });
    bridge.handle(invokeChannels.designOpenInSolidCraft, async () => {
      assistantIdle();
      await supervisor.openInSolidCraft();
      return undefined;
    });

    mainWindow = createWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    supervisor.start();

    let quitting = false;
    app.on('before-quit', (event) => {
      if (quitting) return;
      quitting = true;
      event.preventDefault();
      void Promise.allSettled([agent.dispose(), toolsCache?.close()])
        .then(() => supervisor.shutdown())
        .finally(() => {
          app.quit();
        });
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
