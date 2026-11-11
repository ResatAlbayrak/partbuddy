import type { AssemblyPlan } from './assembly';
import type {
  AgentEvent,
  AgentKind,
  AppInfo,
  SettingsReset,
  AppSettings,
  AppSettingRequest,
  EngineChoiceResult,
  EngineInfo,
  ProjectInfo,
  ProjectEntry,
  ProjectOpenResult,
  InsertResult,
  PartInsert,
  Slicer,
  PartsLibrary,
  GeneralSettingsInfo,
  UpdateState,
  Language,
  PartNote,
  PartsState,
  TrashEntry,
  VersionComparison,
  VersionEntry,
  RepairResult,
  ProjectPreview,
  ProjectRenameResult,
  AssistantState,
  ActionPreviewResult,
  DesignParameter,
  ConnectionStatus,
  DesignAction,
  DimensionApply,
  DimensionMark,
  DimensionProbe,
  DimensionProbeResult,
  LogoMoveRequest,
  LogoSpot,
  ExportFormat,
  ExportResult,
  VideoSave,
  ShareResult,
  MeasureItem,
  MeasureResult,
  ClearanceResult,
  JointDrive,
  JointSweep,
  JointSweepResult,
  MessageAnswer,
  TimelineCommand,
  VisibilityCommand,
  Selection,
  StoredChat,
  StoredChatItem,
  MirrorRevision,
  ModelChoice,
  NotesState,
  PartPrint,
  PrintCheckReport,
  PrintSettings,
  TitleBarColors,
  Theme,
  ViewState,
} from './contract';

import type { FeatureBlock } from './blocks';
import type { KeptSketch, SketchState } from './sketch';
import type { TemplateId } from './templates';

/** An SVG drawing going with a message: the file's text (read again in the main process), the width in mm and its picture. */
export interface OutgoingDrawingMessage {
  svg: string;
  width: number;
  name: string;
  png: Uint8Array;
}

/** A sketch going with a message: its picture, its elements as text (F9) and the whole sketch to keep (F10). */
export interface OutgoingSketch {
  png: Uint8Array;
  elements?: string;
  state?: SketchState;
}

/**
 * What the preload exposes as `window.partbuddy`. Each member is bound to one channel of the
 * contract; there is no generic invoke (ADR 0013).
 */
export interface PartBuddyApi {
  appInfo(): Promise<AppInfo>;
  /** Restarts PartBuddy (after choosing another SolidCraft); the design is saved first. */
  relaunch(): Promise<void>;
  /** General settings (B6): language and project folder. */
  settings: {
    general(): Promise<GeneralSettingsInfo>;
    setLanguage(language: Language): Promise<GeneralSettingsInfo>;
    /** Asks for another project folder; it applies after a restart. */
    chooseProjectsFolder(): Promise<GeneralSettingsInfo>;
    /** Back to Documents\PartBuddy after a restart. */
    resetProjectsFolder(): Promise<GeneralSettingsInfo>;
    /** Marks the first-start setup (B9) as finished or skipped. */
    finishSetup(): Promise<GeneralSettingsInfo>;
    /** Puts a section of the settings, or all of them, back to the defaults; the print profiles stay. */
    reset(section: SettingsReset): Promise<GeneralSettingsInfo>;
    /** Interface size, start behaviour and the update check. */
    app(): Promise<AppSettings>;
    setApp(request: AppSettingRequest): Promise<AppSettings>;
    /** Shows PartBuddy's log file in Explorer, for a problem report. */
    revealLog(): Promise<void>;
  };
  /** Updates of the installed app through GitHub releases (B10); "unavailable" in development. */
  updates: {
    state(): Promise<UpdateState>;
    check(): Promise<UpdateState>;
    download(): Promise<void>;
    /** Quits, installs the downloaded version and starts it. */
    install(): Promise<void>;
    onState(listener: (state: UpdateState) => void): () => void;
  };
  /** Projects (B2): one folder per part in the project folder. Switching saves the open design first. */
  project: {
    info(): Promise<ProjectInfo>;
    /** Closes the open project and starts a new, empty design. */
    create(): Promise<void>;
    /** Asks for a project folder or a design file; a design from elsewhere is copied into a new project. */
    open(): Promise<ProjectOpenResult>;
    /** Renames the open project, or the start page's project in `folder` (P1). */
    rename(name: string, folder?: string): Promise<ProjectRenameResult>;
    /** Copies the open project and opens the copy; a project of the start page is only copied. */
    duplicate(folder?: string): Promise<void>;
    /** Shows the project folder in Explorer. */
    reveal(folder?: string): Promise<void>;
    /** Moves a project to PartBuddy's recycle bin (P2); for the open one a new, empty design starts. */
    trash(folder?: string): Promise<void>;
    /** The projects in the project folder, newest first, for the start page (B3). */
    list(): Promise<ProjectEntry[]>;
    /** Opens a project of the start page by its folder. */
    openFolder(folder: string): Promise<ProjectOpenResult>;
    /**
     * Makes a new project from a file (B4): a SolidCraft design is copied, a STEP, IGES, STL, 3MF
     * or OBJ file is inserted into a new design. Asks with the open dialog when no path is given.
     */
    import(path?: string): Promise<ProjectOpenResult>;
    /** A new project from a template (F3), opened; `name` is the template's name in the user's language. */
    fromTemplate(template: TemplateId, name: string): Promise<ProjectOpenResult>;
    /** The path of a file dropped onto the window, for import (B4); empty for a file without one. */
    pathOfFile(file: File): string;
    /** The saved versions of the open project, newest first (B5). */
    versions(): Promise<VersionEntry[]>;
    /** Saves the open design as a version with the user's name. */
    saveVersion(label: string): Promise<void>;
    /** Opens a version in place of the design; the state before is kept as a version first. */
    restoreVersion(id: string): Promise<void>;
    /** What changed between a version and the open design. */
    compareVersion(id: string): Promise<VersionComparison>;
    /** Names a version; an automatic one becomes a milestone that is no longer pruned (P4). */
    nameVersion(id: string, label: string): Promise<void>;
    /** Opens a version as a new project of its own, with the print settings (P4). */
    versionAsProject(id: string): Promise<void>;
    /** Writes a project as one `.partbuddy` file where the user chooses (P3); the open one without `folder`. */
    exportPackage(folder?: string): Promise<{ saved: boolean }>;
    /** Pins a start page project to the top or changes its tags (P5). */
    setMeta(folder: string, change: { favorite?: boolean; tags?: string[] }): Promise<void>;
    /** The parts list of the open project (P6); empty without one. */
    parts(): Promise<PartsState>;
    /** Keeps one body's note in the open project's parts list, with the printed bodies of now. */
    setPart(body: string, note: PartNote, bodies: string[]): Promise<PartsState>;
    /** The deleted projects in PartBuddy's recycle bin, newest first (P2). */
    trashList(): Promise<TrashEntry[]>;
    /** Puts a deleted project back into the project folder, under the next free name if needed. */
    restoreTrashed(id: string): Promise<void>;
    /** Hands every deleted project on to the Windows recycle bin. */
    emptyTrash(): Promise<void>;
    /** Keeps the preview picture of the open project (base64 PNG) and its ready-to-print light. */
    savePreview(preview: ProjectPreview): Promise<void>;
  };
  solidcraft: {
    /** The SolidCraft program in use and its version. */
    engine(): Promise<EngineInfo>;
    /** Asks for the SolidCraft program and keeps it, or goes back to the automatic search. */
    chooseEngine(automatic: boolean): Promise<EngineChoiceResult>;
    status(): Promise<ConnectionStatus>;
    /** Look for SolidCraft again now instead of waiting for the next poll. */
    retry(): Promise<void>;
    /** Start SolidCraft with the control channel (the user pressed "Start SolidCraft"). */
    start(): Promise<void>;
    onStatus(listener: (status: ConnectionStatus) => void): () => void;
  };
  mirror: {
    current(): Promise<MirrorRevision | null>;
    onRevision(listener: (revision: MirrorRevision) => void): () => void;
  };
  /** The user's own actions on the design, without the assistant (ADR 0016). */
  design: {
    undo(): Promise<void>;
    redo(): Promise<void>;
    /** Asks where to save, then exports all bodies; null when the user cancelled. */
    export(format: ExportFormat): Promise<ExportResult>;
    /** Asks where to save a recording of the view, then writes it; null when the user cancelled. */
    saveVideo(video: VideoSave): Promise<ExportResult>;
    /** The sharing package (F5): 3MF, STEP, pictures and a description in a folder of the project's exports. */
    share(): Promise<ShareResult>;
    /** Saves the design to the project folder and opens it in the SolidCraft window. */
    openInSolidCraft(): Promise<void>;
    /** Tries a new edge length or radius without changing the design (the dimension field, M1b). */
    probeDimension(probe: DimensionProbe): Promise<DimensionProbeResult>;
    /** Sets the parameter a probe found. */
    applyDimension(apply: DimensionApply): Promise<void>;
    /** Builds an action (fillet, chamfer, extrude, hole, shell) on trial for the ghost preview. */
    previewAction(action: DesignAction): Promise<ActionPreviewResult>;
    applyAction(action: DesignAction): Promise<void>;
    /** The slicers SolidCraft found (B8): Bambu Studio, OrcaSlicer and others. */
    slicers(): Promise<Slicer[]>;
    /** Opens the printable bodies in a slicer, laid on their print face; returns the slicer's name. */
    sendToSlicer(slicer: string): Promise<{ name: string }>;
    /** Marks the flat face at a point as the body's print face, or clears it (null). */
    setPrintFace(body: string, point: [number, number, number] | null, face?: string): Promise<void>;
    /** The print faces PartBuddy set in the open project, by body (for the plate view). */
    printFaces(): Promise<Record<string, string>>;
    /** The print faces changed without the window doing it: a mechanism of the assistant laid its part down. */
    onPrintFaces(listener: (faces: Record<string, string>) => void): () => void;
    /** Builds a function block (F1) on trial for the ghost preview. */
    previewBlock(block: FeatureBlock): Promise<ActionPreviewResult>;
    /** Builds a function block for real; one step of the work log. */
    applyBlock(block: FeatureBlock): Promise<void>;
    /** The placed logo at a picked point, or null. */
    logoAt(point: [number, number, number]): Promise<LogoSpot | null>;
    /** Moves a logo on trial for the ghost preview. */
    previewLogoMove(move: LogoMoveRequest): Promise<ActionPreviewResult>;
    /** Moves a logo for real; one step of the work log. */
    moveLogo(move: LogoMoveRequest): Promise<void>;
    /** SolidCraft's standard parts (B7): screws, nuts, washers, pins, bearings, with sizes. */
    partsLibrary(): Promise<PartsLibrary>;
    /** Seats a standard part in a hole as a counterpart; returns its body's name. */
    insertPart(part: PartInsert): Promise<{ body: string | null }>;
    /** Distance and angle between two selections. */
    measure(items: MeasureItem[]): Promise<MeasureResult>;
    /** Overlaps and narrow gaps between printed bodies (F2), measured by SolidCraft. */
    clearance(bodies: string[], gap: number): Promise<ClearanceResult>;
    /** Moves a joint to a value (ADR 0027); SolidCraft keeps it within its limits. */
    driveJoint(drive: JointDrive): Promise<void>;
    /** Runs joint values to their limits on a copy and says where parts stop them (ADR 0027). */
    sweepJoints(sweeps: JointSweep[]): Promise<JointSweepResult>;
    /** Rolls the timeline back or forward, or suppresses a feature (M1c). */
    timeline(command: TimelineCommand): Promise<void>;
    /** Shows or hides bodies and sketches. */
    visibility(command: VisibilityCommand): Promise<void>;
    /** Renames a body (structure tree); SolidCraft refuses a name another body has. */
    renameBody(body: string, name: string): Promise<void>;
    /** Inserts a STEP, IGES, STL, 3MF or OBJ file into the open design (B4); asks when no path is given. */
    insert(path?: string): Promise<InsertResult>;
    /** Converts a mesh body to faces (B4). */
    convertMesh(body: string): Promise<RepairResult>;
    /** "Go back to this state": undoes or redoes to a step of the work log (M2a). */
    goToStep(step: string): Promise<void>;
    /** The dimensions of these features, or of all, placed in the view (M2b-3). */
    dimensions(features: number[] | 'all'): Promise<DimensionMark[]>;
    /** Tries a value of a parameter for the ghost preview, without changing the design. */
    probeParameter(parameter: string, value: number, body: string | null): Promise<ActionPreviewResult>;
    /** The user parameters of the design (parameter panel); favourites first. */
    parameters(): Promise<DesignParameter[]>;
  };
  /** The conversation about the open design, kept next to its file. */
  chat: {
    /** The conversation saved with the design, or null when there is none. */
    load(): Promise<StoredChat | null>;
    save(items: StoredChatItem[]): Promise<void>;
  };
  /** Sketches kept in the open project (F10), newest first, and one of them to draw on again. */
  sketches: {
    list(): Promise<KeptSketch[]>;
    load(id: string): Promise<SketchState | null>;
  };
  /** Notes on the model (M2b, ADR 0020), stored in the design file. */
  notes: {
    current(): Promise<NotesState>;
    /** Pins a note to the selected face, edge or vertex. */
    add(selection: Selection, text: string): Promise<void>;
    edit(id: string, text: string): Promise<void>;
    delete(id: string): Promise<void>;
    /** Accepts a foreign note from the design file, so the assistant may read it. */
    accept(id: string): Promise<void>;
    /** Pins a note to a new place. */
    reattach(id: string, selection: Selection): Promise<void>;
    /** Puts a note that undo or "go back" removed back into the design. */
    restore(id: string): Promise<void>;
    /** Removes a note from the restore list for good. */
    dismiss(id: string): Promise<void>;
    onChange(listener: (state: NotesState) => void): () => void;
  };
  /** Printer and material profiles (M7): the printer in use, and the material per part. */
  print: {
    settings(): Promise<PrintSettings>;
    saveSettings(settings: PrintSettings): Promise<PrintSettings>;
    /** The printer in use and the material of the open part. */
    part(): Promise<PartPrint>;
    /** Chooses the material of the open part; kept next to its design file. */
    setMaterial(material: string): Promise<PartPrint>;
    onChange(listener: (part: PartPrint) => void): () => void;
    /** The latest ready-to-print check, for the assistant's next message. */
    reportCheck(report: PrintCheckReport): Promise<void>;
    /** A picture of the tolerance assistant's test pieces for this nozzle and layer, rendered by SolidCraft; null when it cannot. */
    testPiecesPicture(printer: { nozzle: number; layer: number }): Promise<{ picture: string | null }>;
    /** The test pieces as a 3MF the user saves (slicer null) or opened in a slicer; null when the save was cancelled. */
    exportTestPieces(request: { nozzle: number; layer: number; slicer: string | null }): Promise<{ file: string | null; slicer: string | null } | null>;
  };
  /** The assembly order of the open project (ADR 0026): set by the assistant, null without one. */
  assembly: {
    get(): Promise<AssemblyPlan | null>;
    onChange(listener: (plan: AssemblyPlan | null) => void): () => void;
  };
  viewer: {
    /** Reports what the 3D view shows, for the assistant's `partbuddy_view` tool. */
    report(state: ViewState): Promise<void>;
  };
  window: {
    /** Colours the native window buttons in the integrated title bar like the theme. */
    setTitleBarColors(colors: TitleBarColors): Promise<void>;
    /** The colour theme the user chose; `system` follows Windows. */
    theme(): Promise<Theme>;
    /** Sets and keeps the colour theme; the whole window, its buttons included, follows. */
    setTheme(theme: Theme): Promise<Theme>;
  };
  /** The assistant: the user's Claude Code or ChatGPT plan usage (ADR 0015). */
  agent: {
    status(): Promise<AssistantState>;
    /** Check installation and sign-in again, for example after signing in. */
    refresh(): Promise<AssistantState>;
    select(agent: AgentKind): Promise<AssistantState>;
    /** Let Claude Code run with an API key, billed separately; off by default. */
    allowApiBilling(allow: boolean): Promise<AssistantState>;
    /** The model and effort of the selected route, from now on; with `asDefault` also for new chats (B1). */
    chooseModel(choice: ModelChoice, asDefault: boolean): Promise<AssistantState>;
    /** Whether the assistant may search the web and read pages (B7); applies from the next conversation. */
    research(): Promise<boolean>;
    setResearch(allow: boolean): Promise<boolean>;
    /** Returns the configured context window for local Ollama models, in tokens. */
    ollamaContext(): Promise<16384 | 32768 | 65536>;
    /** Saves the Ollama context window; applies to subsequent model requests. */
    setOllamaContext(size: 16384 | 32768 | 65536): Promise<16384 | 32768 | 65536>;
    /** Sends a message; what is selected in the view goes with it as a short note. */
    send(text: string, selections?: Selection[], answer?: MessageAnswer, sketch?: OutgoingSketch, photos?: Uint8Array[], drawing?: OutgoingDrawingMessage): Promise<void>;
    stop(): Promise<void>;
    /** Start the selected route's sign-in flow; it opens the browser. */
    signIn(): Promise<void>;
    /** Sign out of ChatGPT in PartBuddy; Claude Code keeps its own sign-in. */
    signOut(): Promise<void>;
    onStatus(listener: (state: AssistantState) => void): () => void;
    onEvent(listener: (event: AgentEvent) => void): () => void;
  };
}
