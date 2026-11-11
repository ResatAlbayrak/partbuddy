import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

import type { PartBuddyApi } from '../shared/api';
import { eventChannels, invokeChannels, type EventChannel } from '../shared/channels';
import type { AppSettingRequest, EventPayload, SettingsReset } from '../shared/contract';

// Sandboxed preload (ADR 0013): only named channels are exposed, never ipcRenderer itself.

function subscribe<C extends EventChannel>(channel: C, listener: (payload: EventPayload<C>) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: EventPayload<C>) => {
    listener(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: PartBuddyApi = {
  appInfo: () => ipcRenderer.invoke(invokeChannels.appInfo),
  relaunch: () => ipcRenderer.invoke(invokeChannels.appRelaunch),
  settings: {
    general: () => ipcRenderer.invoke(invokeChannels.settingsGeneral),
    setLanguage: (language) => ipcRenderer.invoke(invokeChannels.settingsSetLanguage, { language }),
    chooseProjectsFolder: () => ipcRenderer.invoke(invokeChannels.settingsChooseProjectsFolder),
    resetProjectsFolder: () => ipcRenderer.invoke(invokeChannels.settingsResetProjectsFolder),
    finishSetup: () => ipcRenderer.invoke(invokeChannels.settingsFinishSetup),
    reset: (section: SettingsReset) => ipcRenderer.invoke(invokeChannels.settingsReset, { section }),
    app: () => ipcRenderer.invoke(invokeChannels.settingsApp),
    setApp: (request: AppSettingRequest) => ipcRenderer.invoke(invokeChannels.settingsSetApp, request),
    revealLog: () => ipcRenderer.invoke(invokeChannels.settingsRevealLog),
  },
  updates: {
    state: () => ipcRenderer.invoke(invokeChannels.updatesState),
    check: () => ipcRenderer.invoke(invokeChannels.updatesCheck),
    download: () => ipcRenderer.invoke(invokeChannels.updatesDownload),
    install: () => ipcRenderer.invoke(invokeChannels.updatesInstall),
    onState: (listener) => subscribe(eventChannels.updatesState, listener),
  },
  project: {
    info: () => ipcRenderer.invoke(invokeChannels.projectInfo),
    create: () => ipcRenderer.invoke(invokeChannels.projectNew),
    open: () => ipcRenderer.invoke(invokeChannels.projectOpen),
    rename: (name, folder) => ipcRenderer.invoke(invokeChannels.projectRename, folder === undefined ? { name } : { name, folder }),
    duplicate: (folder) => ipcRenderer.invoke(invokeChannels.projectDuplicate, folder === undefined ? {} : { folder }),
    reveal: (folder) => ipcRenderer.invoke(invokeChannels.projectReveal, folder === undefined ? {} : { folder }),
    trash: (folder) => ipcRenderer.invoke(invokeChannels.projectTrash, folder === undefined ? {} : { folder }),
    list: () => ipcRenderer.invoke(invokeChannels.projectList),
    openFolder: (folder) => ipcRenderer.invoke(invokeChannels.projectOpenFolder, { folder }),
    import: (path) => ipcRenderer.invoke(invokeChannels.projectImport, path === undefined ? {} : { path }),
    fromTemplate: (template, name) => ipcRenderer.invoke(invokeChannels.projectFromTemplate, { template, name }),
    pathOfFile: (file) => webUtils.getPathForFile(file),
    savePreview: (preview) => ipcRenderer.invoke(invokeChannels.projectSavePreview, preview),
    versions: () => ipcRenderer.invoke(invokeChannels.projectVersions),
    saveVersion: (label) => ipcRenderer.invoke(invokeChannels.projectSaveVersion, { label }),
    restoreVersion: (id) => ipcRenderer.invoke(invokeChannels.projectRestoreVersion, { id }),
    compareVersion: (id) => ipcRenderer.invoke(invokeChannels.projectCompareVersion, { id }),
    nameVersion: (id, label) => ipcRenderer.invoke(invokeChannels.projectNameVersion, { id, label }),
    versionAsProject: (id) => ipcRenderer.invoke(invokeChannels.projectVersionAsProject, { id }),
    trashList: () => ipcRenderer.invoke(invokeChannels.projectTrashList),
    parts: () => ipcRenderer.invoke(invokeChannels.projectParts),
    setPart: (body, note, bodies) => ipcRenderer.invoke(invokeChannels.projectSetPart, { body, note, bodies }),
    setMeta: (folder, change) => ipcRenderer.invoke(invokeChannels.projectSetMeta, { folder, ...change }),
    exportPackage: (folder) => ipcRenderer.invoke(invokeChannels.projectExportPackage, folder === undefined ? {} : { folder }),
    restoreTrashed: (id) => ipcRenderer.invoke(invokeChannels.projectTrashRestore, { id }),
    emptyTrash: () => ipcRenderer.invoke(invokeChannels.projectTrashEmpty),
  },
  solidcraft: {
    engine: () => ipcRenderer.invoke(invokeChannels.solidcraftEngine),
    chooseEngine: (automatic) => ipcRenderer.invoke(invokeChannels.solidcraftChooseEngine, { automatic }),
    status: () => ipcRenderer.invoke(invokeChannels.solidcraftStatus),
    retry: () => ipcRenderer.invoke(invokeChannels.solidcraftRetry),
    start: () => ipcRenderer.invoke(invokeChannels.solidcraftStart),
    onStatus: (listener) => subscribe(eventChannels.solidcraftStatus, listener),
  },
  mirror: {
    current: () => ipcRenderer.invoke(invokeChannels.mirrorCurrent),
    onRevision: (listener) => subscribe(eventChannels.mirrorRevision, listener),
  },
  design: {
    undo: () => ipcRenderer.invoke(invokeChannels.designUndo),
    redo: () => ipcRenderer.invoke(invokeChannels.designRedo),
    export: (format) => ipcRenderer.invoke(invokeChannels.designExport, { format }),
    saveVideo: (video) => ipcRenderer.invoke(invokeChannels.designSaveVideo, video),
    share: () => ipcRenderer.invoke(invokeChannels.designShare),
    openInSolidCraft: () => ipcRenderer.invoke(invokeChannels.designOpenInSolidCraft),
    probeDimension: (probe) => ipcRenderer.invoke(invokeChannels.designProbeDimension, probe),
    applyDimension: (apply) => ipcRenderer.invoke(invokeChannels.designApplyDimension, apply),
    previewAction: (action) => ipcRenderer.invoke(invokeChannels.designPreviewAction, action),
    applyAction: (action) => ipcRenderer.invoke(invokeChannels.designApplyAction, action),
    partsLibrary: () => ipcRenderer.invoke(invokeChannels.designPartsLibrary),
    previewBlock: (block) => ipcRenderer.invoke(invokeChannels.designPreviewBlock, block),
    applyBlock: (block) => ipcRenderer.invoke(invokeChannels.designApplyBlock, block),
    logoAt: (point) => ipcRenderer.invoke(invokeChannels.designLogoAt, { point }),
    previewLogoMove: (move) => ipcRenderer.invoke(invokeChannels.designPreviewLogoMove, move),
    moveLogo: (move) => ipcRenderer.invoke(invokeChannels.designMoveLogo, move),
    slicers: () => ipcRenderer.invoke(invokeChannels.designSlicers),
    sendToSlicer: (slicer) => ipcRenderer.invoke(invokeChannels.designSendToSlicer, { slicer }),
    setPrintFace: (body, point, face) => ipcRenderer.invoke(invokeChannels.designPrintFace, { body, point, ...(face ? { face } : {}) }),
    printFaces: () => ipcRenderer.invoke(invokeChannels.designPrintFaces),
    onPrintFaces: (listener) => subscribe(eventChannels.printFacesChanged, listener),
    insertPart: (part) => ipcRenderer.invoke(invokeChannels.designInsertPart, part),
    measure: (items) => ipcRenderer.invoke(invokeChannels.designMeasure, { items }),
    clearance: (bodies, gap) => ipcRenderer.invoke(invokeChannels.designClearance, { bodies, gap }),
    driveJoint: (drive) => ipcRenderer.invoke(invokeChannels.designDriveJoint, drive),
    sweepJoints: (sweeps) => ipcRenderer.invoke(invokeChannels.designSweepJoints, { sweeps }),
    timeline: (command) => ipcRenderer.invoke(invokeChannels.designTimeline, command),
    visibility: (command) => ipcRenderer.invoke(invokeChannels.designVisibility, command),
    renameBody: (body, name) => ipcRenderer.invoke(invokeChannels.designRenameBody, { body, name }),
    insert: (path) => ipcRenderer.invoke(invokeChannels.designInsert, path === undefined ? {} : { path }),
    convertMesh: (body) => ipcRenderer.invoke(invokeChannels.designRepair, { body }),
    goToStep: (step) => ipcRenderer.invoke(invokeChannels.designGoToStep, { step }),
    dimensions: (features) => ipcRenderer.invoke(invokeChannels.designDimensions, { features }),
    probeParameter: (parameter, value, body) => ipcRenderer.invoke(invokeChannels.designProbeParameter, { parameter, value, body }),
    parameters: () => ipcRenderer.invoke(invokeChannels.designParameters),
  },
  notes: {
    current: () => ipcRenderer.invoke(invokeChannels.notesCurrent),
    add: (selection, text) => ipcRenderer.invoke(invokeChannels.notesAdd, { selection, text }),
    edit: (id, text) => ipcRenderer.invoke(invokeChannels.notesEdit, { id, text }),
    delete: (id) => ipcRenderer.invoke(invokeChannels.notesDelete, { id }),
    accept: (id) => ipcRenderer.invoke(invokeChannels.notesAccept, { id }),
    reattach: (id, selection) => ipcRenderer.invoke(invokeChannels.notesReattach, { id, selection }),
    restore: (id) => ipcRenderer.invoke(invokeChannels.notesRestore, { id }),
    dismiss: (id) => ipcRenderer.invoke(invokeChannels.notesDismiss, { id }),
    onChange: (listener) => subscribe(eventChannels.notesChanged, listener),
  },
  print: {
    settings: () => ipcRenderer.invoke(invokeChannels.printSettings),
    saveSettings: (settings) => ipcRenderer.invoke(invokeChannels.printSaveSettings, settings),
    part: () => ipcRenderer.invoke(invokeChannels.printPart),
    setMaterial: (material) => ipcRenderer.invoke(invokeChannels.printSetMaterial, { material }),
    onChange: (listener) => subscribe(eventChannels.printChanged, listener),
    reportCheck: (report) => ipcRenderer.invoke(invokeChannels.printReportCheck, report),
    testPiecesPicture: (printer) => ipcRenderer.invoke(invokeChannels.printTestPiecesPicture, printer),
    exportTestPieces: (request) => ipcRenderer.invoke(invokeChannels.printTestPiecesExport, request),
  },
  viewer: {
    report: (state) => ipcRenderer.invoke(invokeChannels.viewerState, state),
  },
  window: {
    setTitleBarColors: (colors) => ipcRenderer.invoke(invokeChannels.windowTitleBar, colors),
    theme: () => ipcRenderer.invoke(invokeChannels.windowTheme),
    setTheme: (theme) => ipcRenderer.invoke(invokeChannels.windowSetTheme, { theme }),
  },
  chat: {
    load: () => ipcRenderer.invoke(invokeChannels.chatLoad),
    save: (items) => ipcRenderer.invoke(invokeChannels.chatSave, { items }),
  },
  assembly: {
    get: () => ipcRenderer.invoke(invokeChannels.assemblyGet),
    onChange: (listener) => subscribe(eventChannels.assemblyChanged, listener),
  },
  sketches: {
    list: () => ipcRenderer.invoke(invokeChannels.sketchList),
    load: (id) => ipcRenderer.invoke(invokeChannels.sketchLoad, { id }),
  },
  agent: {
    status: () => ipcRenderer.invoke(invokeChannels.agentStatus),
    refresh: () => ipcRenderer.invoke(invokeChannels.agentRefresh),
    send: (text, selections, answer, sketch, photos, drawing) =>
      ipcRenderer.invoke(invokeChannels.agentSend, {
        text,
        ...(selections && selections.length > 0 ? { selections } : {}),
        ...(answer ? { answer } : {}),
        ...(sketch ? { sketch: sketch.png } : {}),
        ...(sketch?.elements ? { sketchElements: sketch.elements } : {}),
        ...(sketch?.state ? { sketchState: sketch.state } : {}),
        ...(photos && photos.length > 0 ? { photos } : {}),
        ...(drawing ? { drawing } : {}),
      }),
    stop: () => ipcRenderer.invoke(invokeChannels.agentStop),
    select: (agent) => ipcRenderer.invoke(invokeChannels.agentSelect, { agent }),
    allowApiBilling: (allow) => ipcRenderer.invoke(invokeChannels.agentAllowApiBilling, { allow }),
    chooseModel: (choice, asDefault) => ipcRenderer.invoke(invokeChannels.agentChooseModel, { choice, asDefault }),
    research: () => ipcRenderer.invoke(invokeChannels.agentResearch),
    setResearch: (allow) => ipcRenderer.invoke(invokeChannels.agentSetResearch, { allow }),
    ollamaContext: () =>
      ipcRenderer.invoke(invokeChannels.agentOllamaContext),

    setOllamaContext: (size) =>
      ipcRenderer.invoke(invokeChannels.agentSetOllamaContext, { size }),
    signIn: () => ipcRenderer.invoke(invokeChannels.agentSignIn),
    signOut: () => ipcRenderer.invoke(invokeChannels.agentSignOut),
    onStatus: (listener) => subscribe(eventChannels.agentStatus, listener),
    onEvent: (listener) => subscribe(eventChannels.agentEvent, listener),
  },
};

contextBridge.exposeInMainWorld('partbuddy', api);
