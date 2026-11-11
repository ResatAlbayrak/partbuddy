import { z } from 'zod';

import { eventChannels, invokeChannels, type EventChannel, type InvokeChannel } from './channels';
import { keptSketchSchema, sketchStateSchema } from './sketch';
import { drawingSvg, naturalWidth, parseDrawing } from './svgDrawing';
import { assemblyPlanSchema } from './assembly';
import { MAX_PHRASES_PER_STEP, STEP_PHRASE_KEYS } from './stepPhrases';
import { TEMPLATE_IDS } from './templates';

/**
 * The one contract of the typed IPC bridge (ADR 0013). Every channel has a request and a
 * response schema; the main process validates each request and, in development builds, each
 * response and event. Nothing here carries API keys or paths outside the app's own folders.
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const faceInfoSchema = z
  .object({
    index: z.number().int().nonnegative(),
    name: z.string().min(1),
    exact: z.boolean(),
    area: z.number(),
    centroid: vec3,
    point: vec3,
    planeNormal: vec3.optional(),
    cylinder: z.object({ origin: vec3, axis: vec3, radius: z.number() }).strict().optional(),
  })
  .strict();

export const faceTableSchema = z
  .object({
    model: z.string(),
    body: z.string(),
    units: z.literal('mm'),
    faces: z.array(faceInfoSchema),
  })
  .strict();

export const connectionStateSchema = z.enum([
  'searching',
  'notInstalled',
  'notRunning',
  'starting',
  'connecting',
  'connected',
  'lost',
  'failed',
]);

export const connectionStatusSchema = z
  .object({
    state: connectionStateSchema,
    /** Control port of the SolidCraft app PartBuddy talks to, once known. */
    port: z.number().int().positive().optional(),
    /** True when PartBuddy started this SolidCraft and closes it on quit. */
    owned: z.boolean(),
    documentId: z.string().optional(),
    revision: z.number().int().nonnegative().optional(),
    /** Connected to the SolidCraft window, or to the engine PartBuddy runs without a window (ADR 0016). */
    engine: z.enum(['window', 'headless']).optional(),
    /** Mirror state: idle, a newer revision is being mirrored, or the last mirror failed. */
    mirror: z.enum(['idle', 'rebuilding', 'failed']),
    /** Autosave of the design PartBuddy runs without a window: being saved, saved, or the last save failed. */
    save: z.enum(['saving', 'saved', 'failed']).optional(),
    /** Short technical detail for the failed and lost states; never contains a token. */
    detail: z.string().max(500).optional(),
  })
  .strict();

export const mirroredBodySchema = z
  .object({
    name: z.string().min(1),
    /** Face-tagged 3MF bytes as exported by SolidCraft (ADR 0004). */
    mesh: z.instanceof(Uint8Array),
    faces: faceTableSchema,
  })
  .strict();

/**
 * A visible or the active sketch as world-space line segments (issue #21): sketches have no body
 * to export, so the mirror carries their curves, flattened in the main process.
 */
export const mirroredSketchSchema = z
  .object({
    /** SolidCraft's sketch id; stable while the design is open. */
    id: z.number().int().nonnegative(),
    name: z.string(),
    /** The sketch SolidCraft is editing right now. */
    active: z.boolean(),
    /** World positions in mm, two points (six numbers) per segment. */
    positions: z.instanceof(Float32Array),
    /** Per segment: 0 free, 1 fully constrained, 2 construction geometry. */
    styles: z.instanceof(Uint8Array),
    /** The segments of each curve, to see which curves the latest step changed. */
    curves: z.array(
      z.object({ id: z.string().min(1), first: z.number().int().nonnegative(), count: z.number().int().nonnegative() }).strict(),
    ),
  })
  .strict()
  .refine((sketch) => sketch.positions.length === sketch.styles.length * 6, 'positions and styles disagree');

/** One step of the timeline as `document.inspect` reports it (M1c). */
export const timelineFeatureSchema = z
  .object({
    id: z.number().int().nonnegative(),
    name: z.string().max(200),
    type: z.string().max(80),
    error: z.string().max(500).nullable(),
    warning: z.string().max(500).nullable(),
    suppressed: z.boolean(),
    rolledBack: z.boolean(),
    /** Rebuild time in ms. */
    ms: z.number().nonnegative(),
  })
  .strict();

/** A joint between two parts and where it stands (ADR 0027), from SolidCraft's `joint.list`. */
export const jointSchema = z
  .object({
    id: z.number().int().nonnegative(),
    name: z.string().max(200),
    type: z.string().max(40),
    /** One value per direction the joint moves in; a side of the limits that is not set is null. */
    values: z
      .array(
        z
          .object({
            unit: z.enum(['deg', 'mm']),
            value: z.number(),
            limits: z.tuple([z.number().nullable(), z.number().nullable()]).nullable(),
            /** A motion link (a gear, a rack, a screw): this value is `offset + ratio ×` that value of another joint, and cannot be driven itself. */
            follows: z.object({ joint: z.number().int().nonnegative(), index: z.number().int().min(0).max(5), ratio: z.number(), offset: z.number() }).strict().optional(),
          })
          .strict(),
      )
      .max(6),
    /** A point on the joint's axis and the axis, in the world as mirrored; the bodies it moves, those beyond it in the chain too. Left out when SolidCraft gave no frame. */
    origin: z.tuple([z.number(), z.number(), z.number()]).optional(),
    axis: z.tuple([z.number(), z.number(), z.number()]).optional(),
    bodies: z.array(z.string().max(200)).max(500).optional(),
  })
  .strict();

/** What the structure tree and the timeline show: every body and sketch, visible or not, and the features. */
export const structureSchema = z
  .object({
    features: z.array(timelineFeatureSchema).max(5000),
    /** Features before the rollback marker stay active; null when the marker is at the end. */
    marker: z.number().int().nonnegative().nullable(),
    bodies: z
      .array(
        z
          .object({
            name: z.string().max(200),
            visible: z.boolean(),
            feature: z.number().int().nullable(),
            /** The colour given to the body in SolidCraft (appearance.assign), shown in the view. */
            colour: z.string().regex(/^#[0-9a-f]{6}$/).optional(),
          })
          .strict(),
      )
      .max(500),
    sketches: z.array(z.object({ id: z.number().int().nonnegative(), name: z.string().max(200), visible: z.boolean() }).strict()).max(2000),
    /** Bodies that are standard parts (B7): counterparts, neither exported nor checked for printing. */
    standardParts: z.array(z.string().max(200)).max(500).optional(),
    /** The joints of parts that move against each other (ADR 0027); left out when there are none. */
    joints: z.array(jointSchema).max(200).optional(),
  })
  .strict();

export const mirrorRevisionSchema = z
  .object({
    documentId: z.string(),
    revision: z.number().int().nonnegative(),
    designName: z.string(),
    bodies: z.array(mirroredBodySchema),
    sketches: z.array(mirroredSketchSchema),
    structure: structureSchema,
    /** How many steps SolidCraft can undo and redo in this revision. */
    history: z.object({ undo: z.number().int().nonnegative(), redo: z.number().int().nonnegative() }).strict(),
    /** Time from asking SolidCraft for the export to having the files in the main process. */
    mirrorMs: z.number().nonnegative(),
  })
  .strict();

const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i);

/** Colours of the native window buttons, read from the design tokens by the renderer. */
export const titleBarColorsSchema = z
  .object({
    color: hexColor,
    symbolColor: hexColor,
    height: z.number().int().min(24).max(64),
  })
  .strict();

export const appInfoSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    locale: z.string(),
    platform: z.enum(['win32', 'darwin', 'linux']),
    /** Whether the window opens on the start page with no project open (B3); off only in tests. */
    startOnHome: z.boolean(),
  })
  .strict();

/** The SolidCraft program PartBuddy runs and its version (R0, ADR 0024). */
export const engineInfoSchema = z
  .object({
    /** The desktop app's path; null when none is found (or the chosen one is gone). */
    path: z.string().max(1000).nullable(),
    source: z.enum(['override', 'setting', 'automatic']),
    version: z.string().max(60).nullable(),
    support: z.enum(['recommended', 'supported', 'tooOld', 'unknown']),
    minimum: z.string().max(60),
    recommended: z.string().max(60),
    /** The program differs from the one PartBuddy started with: it takes effect after a restart. */
    restartNeeded: z.boolean(),
  })
  .strict();
export const engineChoiceErrorSchema = z.enum(['notSolidCraft', 'noCli', 'noVersion', 'tooOld']);
/** `automatic: true` goes back to the automatic search; otherwise the main process asks for the program. */
export const engineChoiceRequestSchema = z.object({ automatic: z.boolean() }).strict();
export const engineChoiceResultSchema = z
  .object({ info: engineInfoSchema, error: engineChoiceErrorSchema.nullable(), cancelled: z.boolean() })
  .strict();

/** The open project (B2): its name and folder, once the design was saved into one. */
export const projectInfoSchema = z
  .object({ name: z.string().min(1).max(120), folder: z.string().max(1000) })
  .strict()
  .nullable();
/** A project of the start page by its folder; without one, the open project (P1). */
const projectFolder = z.string().min(1).max(1000);
export const projectRenameSchema = z.object({ name: z.string().min(1).max(120), folder: projectFolder.optional() }).strict();
export const projectTargetSchema = z.object({ folder: projectFolder.optional() }).strict();
/** The favourite and the tags of a start page project (P5); what is left out stays. */
export const projectMetaSchema = z.object({ folder: projectFolder, favorite: z.boolean().optional(), tags: z.array(z.string().max(200)).max(100).optional() }).strict();
export const projectRenameResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['empty', 'exists', 'noProject', 'busy']) }).strict(),
]);
/** Opening asks for a folder or a design file; `imported`: a design from elsewhere was copied into a new project. */
export const projectOpenResultSchema = z.object({ opened: z.boolean(), imported: z.boolean() }).strict();
/**
 * Import (B4): a file the user dropped onto the window, or none to ask with the open dialog. The
 * main process checks the path (absolute, an existing file of a known kind, not too large).
 */
export const importRequestSchema = z.object({ path: z.string().min(1).max(1000).optional() }).strict();
/** A new project from a template (F3), named in the user's language. */
export const templateRequestSchema = z.object({ template: z.enum(TEMPLATE_IDS), name: z.string().trim().min(1).max(80) }).strict();
/** A file inserted into the open design: its name and the bodies it brought; nothing when cancelled. */
export const insertResultSchema = z
  .object({ inserted: z.boolean(), name: z.string().max(255).nullable(), bodies: z.array(z.string().max(200)).max(500) })
  .strict();
/** Convert a mesh body to faces (`mesh.convert`); SolidCraft has no repair command for imported parts. */
export const repairRequestSchema = z.object({ body: z.string().min(1).max(200) }).strict();
/** How a conversion went: done, a mesh that is not closed (SolidCraft converts only closed meshes), or SolidCraft's own reason. */
export const repairResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['openMesh', 'other']), detail: z.string().max(500) }).strict(),
]);

/** The ready-to-print light of a project on the start page (B3), as at its last preview. */
export const projectCheckSchema = z.enum(['ready', 'warn', 'block']);
/** A project tile of the start page (B3): name, folder, last change, preview and light. */
export const projectEntrySchema = z
  .object({
    name: z.string().min(1).max(255),
    folder: z.string().min(1).max(1000),
    modified: z.number().nonnegative(),
    /** When the project folder was made; the last change where the file system does not know. */
    created: z.number().nonnegative(),
    preview: z.string().max(1_500_000).startsWith('data:image/png;base64,').nullable(),
    check: projectCheckSchema.nullable(),
    favorite: z.boolean(),
    tags: z.array(z.string().min(1).max(40)).max(20),
    /** Printed copies of the parts list (P6), or null without one. */
    progress: z.object({ printed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict().nullable(),
  })
  .strict();
export const projectListSchema = z.array(projectEntrySchema).max(500);
/** Opens a project of the start page by its folder; the main process checks it is one. */
export const projectOpenFolderSchema = z.object({ folder: z.string().min(1).max(1000) }).strict();
/**
 * The preview picture of the open design after a save (B3), rendered by the renderer from the
 * mirrored meshes; written only when it still belongs to the newest revision of that design.
 */
export const projectPreviewSchema = z
  .object({
    documentId: z.string().min(1).max(200),
    revision: z.number().int().nonnegative(),
    png: z.string().min(1).max(1_400_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    check: projectCheckSchema.nullable(),
  })
  .strict();

/** A saved version of the open project (B5), newest first in the list. */
export const versionEntrySchema = z
  .object({
    id: z.string().regex(/^v-[a-z0-9]{1,20}$/),
    created: z.number().nonnegative(),
    reason: z.enum(['manual', 'export', 'assistant', 'restore']),
    label: z.string().max(200),
    preview: z.string().max(1_500_000).startsWith('data:image/png;base64,').nullable(),
  })
  .strict();
export const versionListSchema = z.array(versionEntrySchema).max(300);
export const versionSaveSchema = z.object({ label: z.string().trim().min(1).max(200) }).strict();
export const versionIdSchema = z.object({ id: z.string().regex(/^v-[a-z0-9]{1,20}$/) }).strict();
/** Names a version (P4); an automatic one becomes a milestone that is kept. */
export const versionNameSchema = z.object({ id: z.string().regex(/^v-[a-z0-9]{1,20}$/), label: z.string().trim().min(1).max(200) }).strict();

/** One body of the parts list (P6): copies needed and printed, filament and a note. */
export const partNoteSchema = z
  .object({
    quantity: z.number().int().min(1).max(999),
    printed: z.number().int().min(0).max(999),
    filament: z.string().max(80),
    note: z.string().max(500),
  })
  .strict();
export const partsStateSchema = z.object({ parts: z.record(z.string().max(200), partNoteSchema), bodies: z.array(z.string().max(200)).max(500) }).strict();
/** Keeps one body's note; `bodies` are the printed bodies of the design as the structure tree shows them. */
export const partSetSchema = z.object({ body: z.string().min(1).max(200), note: partNoteSchema, bodies: z.array(z.string().max(200)).max(500) }).strict();

/** A deleted project in PartBuddy's recycle bin (P2), newest first in the list. */
export const trashEntrySchema = z
  .object({
    id: z.string().regex(/^t-[a-z0-9]{1,20}$/),
    name: z.string().min(1).max(255),
    trashed: z.number().nonnegative(),
    preview: z.string().max(1_500_000).startsWith('data:image/png;base64,').nullable(),
  })
  .strict();
export const trashListSchema = z.array(trashEntrySchema).max(200);
/** Whether the project package (P3) was written; false when the save dialog was cancelled. */
export const packageExportResultSchema = z.object({ saved: z.boolean() }).strict();
export const trashIdSchema = z.object({ id: z.string().regex(/^t-[a-z0-9]{1,20}$/) }).strict();

/** The colour theme: follow the system (Windows), or always light or dark. */
export const themeSchema = z.enum(['system', 'light', 'dark']);
export const themeRequestSchema = z.object({ theme: themeSchema }).strict();
/**
 * The update state of the installed app (B10): not available in a development build, checking,
 * up to date, a newer version available, downloading, ready to install, or the check failed.
 */
export const updateStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unavailable') }).strict(),
  z.object({ state: z.literal('idle') }).strict(),
  z.object({ state: z.literal('checking') }).strict(),
  z.object({ state: z.literal('current'), version: z.string().max(40) }).strict(),
  z.object({ state: z.literal('available'), version: z.string().max(40) }).strict(),
  z.object({ state: z.literal('downloading'), percent: z.number().int().min(0).max(100) }).strict(),
  z.object({ state: z.literal('ready'), version: z.string().max(40) }).strict(),
  z.object({ state: z.literal('error') }).strict(),
]);

/** The language of the interface (B6): follow Windows, German or English. */
export const languageSchema = z.enum(['system', 'de', 'en']);
/** The size of the whole interface (2026-11-07): 90 % to 150 %, as Electron's zoom factor. */
export const ZOOM_STEPS = [0.9, 1, 1.1, 1.25, 1.5] as const;
export const zoomSchema = z.number().min(0.8).max(1.5);
/** What PartBuddy shows when it starts: the start page or the last project. */
export const startPageSchema = z.enum(['home', 'last']);
/** The app-wide settings without a channel of their own, read and changed together. */
export const appSettingsSchema = z.object({ zoom: zoomSchema, startPage: startPageSchema, checkUpdates: z.boolean(), toolDebug: z.boolean() }).strict();
export const appSettingRequestSchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('zoom'), value: zoomSchema }).strict(),
  z.object({ key: z.literal('startPage'), value: startPageSchema }).strict(),
  z.object({ key: z.literal('toolDebug'), value: z.boolean() }).strict(),
  z.object({ key: z.literal('checkUpdates'), value: z.boolean() }).strict(),
]);
/** A section of the settings to put back to its defaults, or all of them. */
export const settingsResetSchema = z.enum(['general', 'solidcraft', 'assistant', 'print', 'all']);
export const languageRequestSchema = z.object({ language: languageSchema }).strict();
/**
 * General settings (B6): the language, Windows' own language (for "follow Windows") and the project
 * folder, where it comes from and whether a restart is needed before it applies.
 */
export const generalSettingsSchema = z
  .object({
    language: languageSchema,
    systemLocale: z.string().max(40),
    projectsFolder: z.string().max(1000),
    projectsSource: z.enum(['default', 'setting', 'override']),
    restartNeeded: z.boolean(),
    /** False until the first-start setup (B9) was finished or skipped. */
    setupDone: z.boolean(),
  })
  .strict();

export const agentKindSchema = z.enum(['claude-code', 'chatgpt', 'local']);

// Zod 4 numbers are finite by default.
const finite = z.number();
const point3 = z.tuple([finite, finite, finite]);

const bodyName = z.string().min(1).max(200);
/** SolidCraft's stable face name (ADR 0004): after fillets and engravings it lists every face it came from, 500 characters and more. */
const faceName = z.string().min(1).max(2000);
/** An edge name: both face names, sorted, joined by "|". */
const edgeName = z.string().min(1).max(4010);

/**
 * What changed between a version and the open design, body by body (B5, from `inspect.compare`):
 * material added or removed since the version, with the places where it differs.
 */
export const versionComparisonSchema = z
  .object({
    bodies: z
      .array(
        z
          .object({
            body: bodyName,
            status: z.enum(['same', 'changed', 'moved', 'added', 'removed']),
            volumeBefore: finite.nullable(),
            volumeAfter: finite.nullable(),
            addedMm3: finite,
            removedMm3: finite,
            movedMm: finite,
            regions: z.array(z.object({ side: z.enum(['added', 'removed']), volume: finite.nullable(), center: point3.nullable() }).strict()).max(20),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

/**
 * What the user selected in PartBuddy's view, as the assistant gets it with a message: a few
 * words of text instead of a screenshot (decided 2026-11-04, keep token use low). A face, an edge
 * or a vertex (M1, decided 2026-11-04).
 */
export const faceSelectionSchema = z
  .object({
    kind: z.literal('face'),
    body: bodyName,
    /** SolidCraft's stable face name (ADR 0004). */
    face: faceName,
    surface: z.enum(['plane', 'cylinder', 'other']),
    area: finite.nonnegative(),
    /** Where the user clicked, on the face, in mm. */
    point: point3,
    normal: point3,
    radius: finite.positive().optional(),
  })
  .strict();

export const edgeSelectionSchema = z
  .object({
    kind: z.literal('edge'),
    body: bodyName,
    /** SolidCraft's edge name: both face names, sorted, joined by "|". */
    edge: edgeName,
    /** False when the two faces meet along more than one edge; the point tells them apart. */
    exact: z.boolean(),
    length: finite.nonnegative(),
    /** Where the user clicked, on the edge, in mm. */
    point: point3,
    /** End points of an open edge; none for a closed loop such as a full circle. */
    ends: z.array(point3).max(2),
    /** Radius when the edge lies on a cylinder (a hole or boss rim). */
    radius: finite.positive().optional(),
  })
  .strict();

export const vertexSelectionSchema = z.object({ kind: z.literal('vertex'), body: bodyName, point: point3 }).strict();

export const selectionSchema = z.discriminatedUnion('kind', [faceSelectionSchema, edgeSelectionSchema, vertexSelectionSchema]);

/**
 * What the user sees in PartBuddy's 3D view, reported by the renderer when it changes; the
 * assistant reads it with the `partbuddy_view` tool.
 */
export const viewStateSchema = z
  .object({
    camera: z.object({ position: point3, target: point3 }).strict().nullable(),
    selections: z.array(selectionSchema).max(20),
    bodies: z.array(z.object({ name: z.string().max(200), faces: z.number().int().nonnegative() }).strict()).max(500),
    sketches: z.array(z.object({ name: z.string().max(200), active: z.boolean() }).strict()).max(500),
    changes: z.object({ faces: z.number().int().nonnegative(), sketchCurves: z.number().int().nonnegative() }).strict().nullable(),
  })
  .strict();

/**
 * Assistant route (ADR 0015): the user's Claude Code, or ChatGPT plan usage in PartBuddy's own
 * loop. Shows sign-in state, plan and, for ChatGPT, the signed-in account's e-mail to the user.
 */
/** A model the user's plan offers (B1), with the effort levels it takes; none when it has no levels. */
const effortName = z.string().min(1).max(20);
export const modelOptionSchema = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(80),
    description: z.string().max(200).optional(),
    efforts: z.array(effortName).max(12),
    defaultEffort: effortName.optional(),
    /** The context window in tokens, when the route knows it. */
    context: z.number().int().positive().optional(),
  })
  .strict();
/** The model and effort a route works with; `effort` null is the model's own default. */
export const modelChoiceSchema = z.object({ model: z.string().min(1).max(80), effort: effortName.nullable() }).strict();

export const agentStatusSchema = z
  .object({
    agent: agentKindSchema,
    // needsSubscription: Claude Code is signed in, but not with a Claude subscription (decided 2026-11-04).
    state: z.enum(['checking', 'notInstalled', 'signedOut', 'needsSubscription', 'ready', 'busy', 'unavailable']),
    version: z.string().max(40).optional(),
    method: z.string().max(40).optional(),
    plan: z.string().max(40).optional(),
    account: z.string().max(200).optional(),
    /** The user allowed Claude Code to run with an API key, billed separately (off by default). */
    apiBillingAllowed: z.boolean().optional(),
    /** The model in use (B1): the user's choice, else the default for new chats. */
    model: z.string().max(80).optional(),
    /** The effort in use; absent: the model's own default. */
    effort: effortName.optional(),
    /** What the plan offers, once read. */
    models: z.array(modelOptionSchema).max(30).optional(),
    /** The choice kept for new chats, when the user set one. */
    defaultChoice: modelChoiceSchema.optional(),
    detail: z.string().max(500).optional(),
    /** Plan limits as the assistant last reported them: the share used (0 to 1) of each window and when it resets (Unix seconds). */
    usage: z
      .array(z.object({ window: z.string().max(40), used: z.number().min(0).max(1), resetsAt: z.number().int().nonnegative().nullable() }).strict())
      .max(4)
      .optional(),
    /** The conversation's size in tokens after the last request and the model's context window. */
    context: z.object({ used: z.number().int().nonnegative(), size: z.number().int().positive() }).strict().optional(),
  })
  .strict();
/** `asDefault`: keep the choice for new chats too. */
export const modelChoiceRequestSchema = z.object({ choice: modelChoiceSchema, asDefault: z.boolean() }).strict();

/** One line of a work-log step (M2a): a message key and its values, shown in the user's language. */
export const stepPhraseSchema = z
  .object({
    key: z.enum(STEP_PHRASE_KEYS),
    values: z.record(z.string().max(40), z.union([z.string().max(80), z.number()])),
  })
  .strict();

/**
 * One change of the design in the work log (M2a): by the assistant (`toolId` names its tool call)
 * or by the user. `depth` is SolidCraft's undo depth after the step, which "go back" returns to.
 */
export const workStepSchema = z
  .object({
    id: z.string().max(40),
    source: z.enum(['assistant', 'user']),
    phrases: z.array(stepPhraseSchema).min(1).max(MAX_PHRASES_PER_STEP),
    toolId: z.string().max(40).optional(),
    documentId: z.string().max(200),
    revision: z.number().int().nonnegative(),
    depth: z.number().int().nonnegative(),
  })
  .strict();
/** applied: part of the design; undone: Redo or "go back" brings it back; discarded: replaced for good. */
export const workStepStateSchema = z.enum(['applied', 'undone', 'discarded']);

/** One question of a round: 2 to 5 answers, the assistant's recommendation marked, one or several to pick. */
export const roundQuestionSchema = z
  .object({
    header: z.string().max(24).optional(),
    question: z.string().max(500),
    options: z
      .array(z.object({ label: z.string().max(60), detail: z.string().max(200).optional(), recommended: z.literal(true).optional() }).strict())
      .min(2)
      .max(5),
    multiSelect: z.literal(true).optional(),
  })
  .strict();

/** A round of questions or a plan of the assistant, shown as a card in the chat (M2a). */
export const agentQuestionSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string().max(40), kind: z.literal('ask'), questions: z.array(roundQuestionSchema).min(1).max(4) }).strict(),
  z.object({ id: z.string().max(40), kind: z.literal('plan'), summary: z.string().max(300), steps: z.array(z.string().max(200)).min(1).max(12) }).strict(),
]);
/** How the user answered a card: go / cancel on a plan, or "answered" when a round was sent with its button. */
export const messageAnswerSchema = z.object({ question: z.string().min(1).max(40), choice: z.enum(['go', 'cancel', 'answered']) }).strict();

/** Chats saved before rounds (2026-11-06) hold one question with its options; read them as a round of one. */
function roundOfOne(value: unknown): unknown {
  const item = value as { kind?: unknown; question?: unknown; options?: unknown; id?: unknown } | null;
  if (item?.kind !== 'ask' || typeof item.question !== 'string') return value;
  return { id: item.id, kind: 'ask', questions: [{ question: item.question, options: item.options }] };
}
/** What a selection that went with a message holds, counted for the chat line. */
export const selectionSummarySchema = z
  .object({ faces: z.number().int().min(0), edges: z.number().int().min(0), vertices: z.number().int().min(0), bodies: z.array(z.string().max(200)).max(20) })
  .strict();

/** A web address the assistant searched or read (B7); only http and https. */
const webUrl = z.string().max(2000).regex(/^https?:\/\//i);
/**
 * A source of the assistant's research (B7): a web search with its query and the pages it found,
 * or a page it read. Shown as a card with its link; the pages' text never reaches the chat.
 */
export const researchSourceSchema = z
  .object({
    kind: z.enum(['search', 'page']),
    query: z.string().max(300).optional(),
    url: webUrl.optional(),
    title: z.string().max(300).optional(),
    links: z.array(z.object({ url: webUrl, title: z.string().max(300) }).strict()).max(8).optional(),
  })
  .strict();
export const ollamaContextSchema = z.union([
  z.literal(16384),
  z.literal(32768),
  z.literal(65536),
]);

export const ollamaContextRequestSchema = z.object({
  size: ollamaContextSchema,
}).strict();

export const researchRequestSchema = z.object({ allow: z.boolean() }).strict();

export const agentEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('user'),
      text: z.string(),
      selection: z.string().max(400).optional(),
      /** What the selection holds, for a short line in the chat; `selection` keeps the names. */
      selected: selectionSummarySchema.optional(),
      /** A sketch went along (F4). */
      sketch: z.literal(true).optional(),
      /** A photo went along (F6). */
      photo: z.literal(true).optional(),
      /** An SVG drawing went along. */
      drawing: z.literal(true).optional(),
    })
    .strict(),
  z.object({ type: z.literal('textDelta'), text: z.string() }).strict(),
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('tool'),
      id: z.string(),
      name: z.string(),
      summary: z.string().max(2000),
      decision: z.enum(['allowed', 'denied']),
      reason: z.string().max(500).optional(),
      ok: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal('done'), ok: z.boolean(), durationMs: z.number().nullable(), detail: z.string().nullable() }).strict(),
  z.object({ type: z.literal('error'), message: z.string().max(500) }).strict(),
  z.object({ type: z.literal('source'), source: researchSourceSchema }).strict(),
  z.object({ type: z.literal('step'), step: workStepSchema }).strict(),
  z.object({ type: z.literal('question'), question: agentQuestionSchema }).strict(),
  /** The user's next message answered the question; `choice` when a button was pressed. */
  z.object({ type: z.literal('answered'), id: z.string().max(40), choice: z.string().max(10).nullable() }).strict(),
  z
    .object({
      type: z.literal('steps'),
      states: z.array(z.object({ id: z.string().max(40), state: workStepStateSchema }).strict()).max(1000),
      /** The newest applied step: the design is in its state. */
      current: z.string().max(40).nullable(),
    })
    .strict(),
]);
export const goToStepSchema = z.object({ step: z.string().min(1).max(40) }).strict();

/** Formats of the user's own export (ADR 0016): 3MF for slicers, STL, STEP for other CAD programs. */
export const exportFormatSchema = z.enum(['3mf', 'stl', 'step']);
export const exportRequestSchema = z.object({ format: exportFormatSchema }).strict();
/** The saved file's name only, never the folder (no paths outside the app's own folders here). */
/** A recording of the view (the playback of the joints): the browser's own MP4 or WebM, saved where the user says. */
export const videoSaveSchema = z
  .object({ bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.length > 0 && bytes.length <= 64 * 1024 * 1024, 'no video, or one over 64 MB'), format: z.enum(['mp4', 'webm']) })
  .strict();
export const exportResultSchema = z.object({ file: z.string().min(1).max(260) }).strict().nullable();
/** The sharing package (F5): its folder's name inside the project's exports, never the full path. */
export const shareResultSchema = z.object({ folder: z.string().min(1).max(260) }).strict();

/** The dimension field at a selection (M1b): an edge length or the radius of a cylindrical face. */
export const dimensionTargetSchema = z.discriminatedUnion('measure', [
  z.object({ measure: z.literal('length'), body: bodyName, edge: edgeName, point: point3 }).strict(),
  z.object({ measure: z.literal('radius'), body: bodyName, face: faceName }).strict(),
  z.object({ measure: z.literal('distance'), body: bodyName, faces: z.tuple([faceName, faceName]) }).strict(),
]);
const length = finite.positive().max(100_000);
export const dimensionProbeSchema = z.object({ target: dimensionTargetSchema, current: length, value: length }).strict();
const factorSchema = z.union([z.literal(1), z.literal(2)]);
export const dimensionProbeResultSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('direct'),
      parameter: z.string().min(1).max(200),
      /** 2 when a diameter parameter drives a radius. */
      factor: factorSchema,
      label: z.string().max(400),
      /** Face-tagged 3MF of the body with the new value, for the ghost preview. */
      preview: z.instanceof(Uint8Array).nullable(),
    })
    .strict(),
  /** Several parameters each move the selection to the value: the user picks one. */
  z.object({ mode: z.literal('choice'), options: z.array(z.object({ parameter: z.string().min(1).max(200), factor: factorSchema, label: z.string().max(400) }).strict()).min(2).max(8) }).strict(),
  z.object({ mode: z.literal('assistant'), reason: z.literal('noDriver') }).strict(),
]);
export const dimensionApplySchema = z
  .object({
    parameter: z.string().regex(/^[\p{L}_][\p{L}\p{N}_]{0,99}$/u),
    value: length,
    factor: factorSchema,
    /** What the probe called the dimension ("Box1 · Length"), for the work log. */
    label: z.string().max(400).optional(),
  })
  .strict();

/**
 * A dimension shown in the view (M2b-3, ADR 0020): a sketch dimension or a feature input, with the
 * parameter behind it and where it sits. `edit` tells how the user may change it: `direct` (a
 * plain number), `parameter` (the expression is one user parameter; `others` more use it) or
 * `assistant` (a formula, never overwritten; ADR 0017).
 */
const parameterName = z.string().regex(/^[\p{L}_][\p{L}\p{N}_]{0,99}$/u);
export const dimensionMarkSchema = z
  .object({
    id: z.string().max(220),
    parameter: parameterName,
    label: z.string().max(80),
    feature: z.object({ id: z.number().int().nonnegative(), name: z.string().max(200) }).strict(),
    expression: z.string().max(500),
    value: finite,
    unit: z.enum(['mm', 'deg']),
    kind: z.enum(['linear', 'radius', 'diameter', 'angle']),
    edit: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('direct') }).strict(),
      z.object({ mode: z.literal('parameter'), name: parameterName, others: z.number().int().nonnegative() }).strict(),
      z.object({ mode: z.literal('assistant') }).strict(),
    ]),
    body: bodyName.nullable(),
    /** World space: the measured span, the offset of the dimension line, and where the label sits; null without a place. */
    geometry: z.object({ from: point3, to: point3, offset: point3, anchor: point3 }).strict().nullable(),
  })
  .strict();
export const dimensionMarksRequestSchema = z
  .object({ features: z.union([z.array(z.number().int().nonnegative()).max(50), z.literal('all')]) })
  .strict();
export const dimensionMarksSchema = z.array(dimensionMarkSchema).max(400);
/**
 * A user parameter of the design for the parameter panel (UI upgrade step 6): what SolidCraft's
 * `parameters.list` reports for parameters the user or the assistant created, not the dimensions
 * of single features. `editable` marks a plain length, which the panel may change directly; a
 * formula stays the designer's intent (ADR 0017).
 */
export const designParameterSchema = z
  .object({
    name: parameterName,
    expression: z.string().max(500),
    value: finite,
    unit: z.string().max(20),
    comment: z.string().max(500),
    favorite: z.boolean(),
    error: z.string().max(500).nullable(),
    /** Parameters and feature inputs that follow this one. */
    usedBy: z.number().int().nonnegative(),
    editable: z.boolean(),
  })
  .strict();
export const designParametersSchema = z.array(designParameterSchema).max(300);

/** Tries a value of a parameter for the ghost preview; nothing changes in the design. */
export const parameterProbeSchema = z.object({ parameter: parameterName, value: finite.positive().max(100_000), body: bodyName.nullable() }).strict();

/** Actions at the selection (M1b-2): points on the picked edges or faces and one size in mm. */
const actionPoints = z.array(point3).min(1).max(50);
export const designActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('fillet'), body: bodyName, points: actionPoints, size: length }).strict(),
  z.object({ action: z.literal('chamfer'), body: bodyName, points: actionPoints, size: length }).strict(),
  z
    .object({ action: z.literal('extrude'), body: bodyName, points: z.array(point3).length(1), size: finite.min(-10_000).max(10_000).refine((value) => value !== 0) })
    .strict(),
  z.object({ action: z.literal('hole'), body: bodyName, points: z.array(point3).length(1), size: length, depth: length.optional() }).strict(),
  z.object({ action: z.literal('shell'), body: bodyName, points: actionPoints, size: length }).strict(),
]);
/** The standard part families PartBuddy offers (B7), metric, from SolidCraft's library. */
export const partFamilySchema = z.enum(['socket_head_cap_screw', 'button_head_cap_screw', 'hex_bolt', 'set_screw', 'hex_nut', 'washer', 'dowel_pin', 'bearing']);
export const partsLibrarySchema = z
  .array(
    z
      .object({
        family: partFamilySchema,
        name: z.string().max(200),
        lengths: z.array(finite).max(100).nullable(),
        sizes: z.array(z.object({ size: z.string().max(40), diameter: finite.nullable(), defaultLength: finite.nullable() }).strict()).max(100),
      })
      .strict(),
  )
  .max(20);
/** Seats a standard part in the hole at `point` (a point on the hole's wall). */
export const partInsertSchema = z
  .object({ family: partFamilySchema, size: z.string().min(1).max(40), length: finite.positive().max(1000).optional(), point: point3 })
  .strict();
export const partInsertResultSchema = z.object({ body: z.string().max(200).nullable() }).strict();
/** A slicer SolidCraft found on this computer (B8): its id and name, never its path. */
export const slicersSchema = z.array(z.object({ id: z.string().min(1).max(80), name: z.string().max(120) }).strict()).max(20);
export const sendToSlicerSchema = z.object({ slicer: z.string().min(1).max(80) }).strict();
/** The flat face at `point` of `body` becomes the face it lies on in the slicer (B8); null clears it. */
/** `face`: the face's name, which PartBuddy keeps for the plate view (the engine does not report print faces back). */
export const printFaceSchema = z.object({ body: bodyName, point: point3.nullable(), face: faceName.optional() }).strict();
/** The print face of each body as PartBuddy set it, by face name. */
export const printFacesSchema = z.record(bodyName, z.string().max(300));
/** A function block at a picked flat face (F1); `shared/blocks.ts` turns it into SolidCraft's command. */
const blockSize = z.enum(['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10']);
const blockLength = finite.positive().max(500);
/** Further points of a row of the same hole (the first is `point`). */
const morePoints = z.array(point3).max(99).optional();
export const featureBlockSchema = z.discriminatedUnion('block', [
  z.object({ block: z.literal('tappedHole'), body: bodyName, point: point3, size: blockSize, depth: blockLength.nullable(), modeled: z.boolean(), more: morePoints }).strict(),
  z
    .object({ block: z.literal('screwHole'), body: bodyName, point: point3, size: blockSize, head: z.enum(['none', 'cap', 'countersunk']), fit: z.enum(['close', 'normal', 'loose']), more: morePoints })
    .strict(),
  z.object({ block: z.literal('insertSeat'), body: bodyName, point: point3, size: blockSize, diameter: blockLength, depth: blockLength, more: morePoints }).strict(),
  z.object({ block: z.literal('boss'), body: bodyName, point: point3, size: blockSize, diameter: blockLength, height: blockLength }).strict(),
  z
    .object({
      block: z.literal('text'),
      body: bodyName,
      point: point3,
      normal: point3,
      size: blockSize,
      text: z.string().trim().min(1).max(80),
      height: blockLength,
      depth: blockLength,
      mode: z.enum(['emboss', 'deboss']),
      bold: z.boolean(),
      font: z.string().trim().min(1).max(100).optional(),
      boldFace: z.string().trim().min(1).max(100).optional(),
    })
    .strict(),
  z.object({ block: z.literal('nutTrap'), body: bodyName, point: point3, normal: point3, size: blockSize, flats: blockLength, depth: blockLength }).strict(),
  z
    .object({ block: z.literal('slot'), body: bodyName, point: point3, normal: point3, size: blockSize, length: blockLength, width: blockLength, depth: blockLength.nullable(), along: z.enum(['x', 'y']) })
    .strict(),
  z
    .object({ block: z.literal('lip'), body: bodyName, point: point3, size: blockSize, type: z.enum(['lip', 'groove']), width: blockLength, height: blockLength, gap: finite.min(0).max(5) })
    .strict(),
  z
    .object({
      block: z.literal('logo'),
      body: bodyName,
      point: point3,
      normal: point3,
      size: blockSize,
      name: z.string().max(200),
      // Read again here: only a drawing PartBuddy can read safely goes to SolidCraft (svgDrawing.ts).
      svg: z
        .string()
        .min(1)
        .max(512 * 1024)
        .transform((svg, context) => {
          const result = parseDrawing(svg);
          if (result.ok) return drawingSvg(result.drawing, naturalWidth(result.drawing) ?? 100);
          context.addIssue({ code: 'custom', message: `not a usable SVG drawing: ${result.detail}` });
          return z.NEVER;
        }),
      width: blockLength,
      depth: blockLength,
      mode: z.enum(['emboss', 'deboss']),
      // Each fill its own coloured body, for multi-colour printing.
      colours: z.boolean().optional(),
      // Onto the middle of the face the point is on, instead of at the point.
      centre: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      block: z.literal('snapFit'),
      body: bodyName,
      point: point3,
      normal: point3,
      size: blockSize,
      length: blockLength,
      thickness: blockLength,
      width: blockLength,
      catchDepth: blockLength,
      catchLength: blockLength,
      hook: z.enum(['y+', 'y-', 'x+', 'x-']),
    })
    .strict(),
]);
export const actionPreviewSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), preview: z.instanceof(Uint8Array).nullable() }).strict(),
  z.object({ ok: z.literal(false), error: z.string().max(300) }).strict(),
]);
/** A placed logo at a picked point (sketches named "SVG-Logo <name>"), and where it sits from its face's middle. */
export const logoSpotSchema = z
  .object({ logo: z.string().min(1).max(200), offset: z.tuple([finite, finite]).nullable(), origin: point3, xDir: point3, yDir: point3, box: z.tuple([finite, finite, finite, finite]), depth: z.object({ value: finite, raised: z.boolean() }).strict().nullable(), angle: finite, outline: z.instanceof(Float32Array), text: z.object({ words: z.string().max(200), height: finite, font: z.string().max(200).nullable(), bold: z.boolean() }).strict().nullable() })
  .strict();
/** Changes a logo: onto its face's middle along `centre` first, then by `by` mm along its own x and y, turned by `rotate`, its width and its depth. */
export const logoMoveSchema = z
  .object({
    logo: z.string().min(1).max(200),
    by: z.tuple([finite, finite]).nullable(),
    centre: z.enum(['x', 'y', 'both']).nullable(),
    /** How deep or high, in mm; every extrusion of the logo gets it. */
    depth: finite.positive().max(50).nullable().optional(),
    /** Degrees to turn it counter-clockwise (looking at the face) about its middle. */
    rotate: finite.min(-360).max(360).nullable().optional(),
    /** How wide in mm, aspect kept, about its middle. */
    width: finite.positive().max(1000).nullable().optional(),
    /** A placed text's words, capital height, font ("" the built-in one) and boldness; left out keeps each. */
    text: z
      .object({ words: z.string().trim().min(1).max(80).optional(), height: finite.positive().max(500).optional(), font: z.string().max(100).optional(), bold: z.boolean().optional(), boldFace: z.string().max(100).optional() })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (move) => move.by !== null || move.centre !== null || (move.depth ?? null) !== null || (move.rotate ?? null) !== null || (move.width ?? null) !== null || (move.text ?? null) !== null,
    'nothing to change',
  );
export const measureItemSchema = z.object({ type: z.enum(['face', 'edge', 'vertex']), body: bodyName, point: point3 }).strict();
export const measureRequestSchema = z.object({ items: z.array(measureItemSchema).min(1).max(2) }).strict();
export const measureResultSchema = z.object({ distance: finite.nullable(), angle: finite.nullable() }).strict();
/** The printed bodies whose clearance SolidCraft measures (F2); standard parts stay out. */
export const clearanceRequestSchema = z.object({ bodies: z.array(bodyName).min(2).max(200), gap: finite.min(0).max(5) }).strict();
/** One value of a joint driven to where the user set its slider (ADR 0027); the name is for the work log. */
export const jointDriveSchema = z
  .object({ joint: z.number().int().nonnegative(), index: z.number().int().min(0).max(5), value: finite.min(-100_000).max(100_000), unit: z.enum(['deg', 'mm']), name: z.string().max(200) })
  .strict();
/** Joint values run from where they stand to a limit, without changing the design (ADR 0027, `joint.sweep`). */
export const jointSweepRequestSchema = z
  .object({ sweeps: z.array(z.object({ joint: z.number().int().nonnegative(), index: z.number().int().min(0).max(5), from: finite, to: finite }).strict()).max(40) })
  .strict();
/** Per sweep, in the same order: where two parts stopped it, or null when it ran through. */
export const jointSweepResultSchema = z.array(z.object({ stoppedAt: finite, a: z.string().max(200), b: z.string().max(200), at: point3 }).strict().nullable()).max(40);
const boxSchema = z.object({ min: point3, max: point3 }).strict();
export const clearanceResultSchema = z
  .object({
    overlaps: z.array(z.object({ a: bodyName, b: bodyName, volume: finite.nonnegative(), box: boxSchema }).strict()).max(100),
    near: z.array(z.object({ a: bodyName, b: bodyName, distance: finite.nonnegative(), from: point3, to: point3 }).strict()).max(100),
  })
  .strict();

/** Timeline commands of the user (M1c): roll back to a position or to the end, suppress a feature. */
export const timelineCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rollTo'), position: z.union([z.number().int().nonnegative().max(5000), z.literal('end')]) }).strict(),
  z.object({ action: z.literal('suppress'), feature: z.number().int().nonnegative(), suppressed: z.boolean() }).strict(),
]);
/** Shows or hides bodies (by name) and sketches (by id). */
export const visibilityCommandSchema = z
  .object({ bodies: z.array(bodyName).max(500), sketches: z.array(z.number().int().nonnegative()).max(2000), visible: z.boolean() })
  .strict()
  .refine((command) => command.bodies.length + command.sketches.length > 0, 'nothing to show or hide');

/** Photos that go along with one message; four of about 3 MB stay well inside a request. */
export const MAX_PHOTOS = 4;
/** The PNG signature, and at most 4 MB: the sketch pad writes about 50 KB, a photo scaled to 1568 px about 3 MB. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const sketchPngSchema = z
  .instanceof(Uint8Array)
  .refine((bytes) => bytes.length > PNG_SIGNATURE.length && bytes.length <= 4 * 1024 * 1024 && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte), 'not a PNG picture');
export const agentMessageSchema = z
  .object({
    text: z.string().min(1).max(20_000),
    selections: z.array(selectionSchema).min(1).max(20).optional(),
    answer: messageAnswerSchema.optional(),
    /** A rough sketch the user drew (F4), as a PNG that goes along as a picture. */
    sketch: sketchPngSchema.optional(),
    /** The sketch's shapes, dimensions and labels as a list (F9), next to its picture. */
    sketchElements: z.string().min(1).max(8000).optional(),
    /** The whole sketch, kept in the project with its picture (F10). */
    sketchState: sketchStateSchema.optional(),
    /** Photos of a real object (F6), scaled down and turned into PNGs by the renderer; up to four. */
    photos: z.array(sketchPngSchema).min(1).max(MAX_PHOTOS).optional(),
    /** An SVG drawing: the file's text, read again in the main process, the width in mm and its picture. */
    drawing: z
      .object({ svg: z.string().min(1).max(512 * 1024), width: z.number().positive().max(1000), name: z.string().min(1).max(200), png: sketchPngSchema })
      .strict()
      .optional(),
  })
  .strict()
  .refine((message) => [message.sketch, message.photos, message.drawing].filter(Boolean).length <= 1, 'one kind of picture: a sketch, photos or a drawing');
export const apiBillingSchema = z.object({ allow: z.boolean() }).strict();
export const agentSelectionSchema = z.object({ agent: agentKindSchema }).strict();
export const assistantStateSchema = z.object({ selected: agentKindSchema, agents: z.array(agentStatusSchema) }).strict();

/**
 * Notes on the model (M2b, ADR 0020): stored in the design file, placed by their anchor (ADR 0006).
 * `own`: signed by this installation; a foreign note is shown to the user but not to the assistant
 * until the user accepts it.
 */
const noteId = z.string().regex(/^[a-z0-9]{6,16}$/);
const noteText = z.string().min(1).max(1000);
export const noteViewSchema = z
  .object({
    id: noteId,
    text: noteText,
    kind: z.enum(['face', 'edge', 'point']),
    body: bodyName,
    /** The face or edge name the note sits on now; null for a point note. */
    target: z.string().max(4010).nullable(),
    status: z.enum(['attached', 'moved', 'ambiguous', 'orphaned']),
    own: z.boolean(),
    world: point3,
    normal: point3.optional(),
    created: z.string().max(40),
  })
  .strict();
export const notesStateSchema = z
  .object({
    documentId: z.string().max(200).nullable(),
    notes: z.array(noteViewSchema).max(500),
    /** Notes that undo or "go back" removed, for this design; the user can put them back. */
    restorable: z.array(z.object({ id: noteId, text: noteText, target: z.string().max(4010).nullable() }).strict()).max(50),
    /** Note entries in the file that PartBuddy could not read (damaged or from a newer version). */
    unreadable: z.number().int().nonnegative(),
  })
  .strict();
export const noteAddSchema = z.object({ selection: selectionSchema, text: noteText }).strict();
export const noteEditSchema = z.object({ id: noteId, text: noteText }).strict();
export const noteIdRequestSchema = z.object({ id: noteId }).strict();
export const noteReattachSchema = z.object({ id: noteId, selection: selectionSchema }).strict();

const none = z.undefined();


/**
 * The conversation about a design, kept next to its file (`Grundplatte.chat.json`) so it is there
 * again after a restart. Only what the chat shows: no tool details, no pictures. Read back as
 * untrusted input.
 */
export const storedChatItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), text: z.string().max(20_000), selection: z.string().max(400).optional(), selected: selectionSummarySchema.optional(), sketch: z.literal(true).optional(), photo: z.literal(true).optional(), drawing: z.literal(true).optional() }).strict(),
  z.object({ kind: z.literal('assistant'), text: z.string().max(50_000) }).strict(),
  z.object({ kind: z.literal('step'), step: workStepSchema, state: workStepStateSchema }).strict(),
  z.object({ kind: z.literal('question'), question: z.preprocess(roundOfOne, agentQuestionSchema), choice: z.string().max(40).nullable() }).strict(),
  z.object({ kind: z.literal('error'), message: z.string().max(2000) }).strict(),
  z.object({ kind: z.literal('source'), source: researchSourceSchema }).strict(),
]);
export const storedChatSchema = z
  .object({ version: z.literal(1), savedAt: z.string().max(40), items: z.array(storedChatItemSchema).max(400) })
  .strict();
export const chatSaveSchema = z.object({ items: z.array(storedChatItemSchema).max(400) }).strict();

/**
 * Printer and material profiles (M7, decided 2026-11-05): printers are kept for the whole
 * installation and one of them is in use; the material is chosen per part, with a default for
 * new parts. Entered by hand, no slicer import. Lengths in mm, angles in degrees.
 */
const profileId = z.string().regex(/^[a-z0-9-]{1,40}$/);
const profileName = z.string().trim().min(1).max(60);
const range = (min: number, max: number) => finite.min(min).max(max);
/** How many printers the settings keep. */
export const MAX_PRINTERS = 20;
/** How many materials the settings keep. */
export const MAX_MATERIALS = 50;

export const printerProfileSchema = z
  .object({
    id: profileId,
    name: profileName,
    /** Build volume X, Y, Z. */
    bed: z.tuple([range(20, 2000), range(20, 2000), range(20, 2000)]),
    nozzle: range(0.1, 2),
    layer: range(0.04, 1.2),
  })
  .strict();

/** Fits from tightest to loosest: held by clamping, pushed together and apart, sliding, turning. */
export const fitKindSchema = z.enum(['clamp', 'push', 'slide', 'turn']);
export const FIT_KINDS = fitKindSchema.options;

export const materialProfileSchema = z
  .object({
    id: profileId,
    name: profileName,
    /** How far a downward face may lean from the vertical and still print without support. */
    overhang: range(20, 70),
    /** How much smaller than drawn a hole comes out, on the diameter. */
    holeShrink: range(0, 1),
    /** Clearance per side between two mating parts, per fit. */
    clearance: z.object({ clamp: range(-0.5, 2), push: range(-0.5, 2), slide: range(-0.5, 2), turn: range(-0.5, 2) }).strict(),
  })
  .strict();

const uniqueIds = (items: readonly { id: string }[]) => new Set(items.map((item) => item.id)).size === items.length;

/**
 * The groups of design rules the assistant applies without being asked (decided 2026-11-07):
 * rounded and chamfered edges, print-in-place joints, clean details and sizes snapped to nozzle and
 * layer. The user turns a group off in the settings, or for one project in the chat.
 */
export const DESIGN_RULES = ['rounding', 'printInPlace', 'details', 'snap'] as const;
export type DesignRule = (typeof DESIGN_RULES)[number];
export const designRulesSchema = z
  .object({ rounding: z.boolean().default(true), printInPlace: z.boolean().default(true), details: z.boolean().default(true), snap: z.boolean().default(true) })
  .strict();
export type DesignRules = z.infer<typeof designRulesSchema>;
export const DESIGN_DEFAULTS: DesignRules = { rounding: true, printInPlace: true, details: true, snap: true };

export const printSettingsSchema = z
  .object({
    version: z.literal(1),
    printers: z.array(printerProfileSchema).min(1).max(MAX_PRINTERS).refine(uniqueIds, 'printer ids must be unique'),
    /** The printer in use. */
    printer: profileId,
    materials: z.array(materialProfileSchema).min(1).max(MAX_MATERIALS).refine(uniqueIds, 'material ids must be unique'),
    /** The material of a part that has none of its own. */
    material: profileId,
    /**
     * Design to print without support (M7f, decided 2026-11-05): the assistant gets the rules for it
     * with the profile. On unless the user turns it off; files from before it have it on.
     */
    supportFree: z.boolean().default(true),
    /** The design rules the assistant applies on its own (decided 2026-11-07); every group on unless turned off. */
    design: designRulesSchema.default(DESIGN_DEFAULTS),
  })
  .strict()
  .refine((settings) => settings.printers.some((printer) => printer.id === settings.printer), 'the printer in use must exist')
  .refine((settings) => settings.materials.some((material) => material.id === settings.material), 'the default material must exist');

/** The tolerance assistant's test pieces for a nozzle and layer; to a 3MF file (slicer null) or into a slicer. */
const testPiecesForSchema = z.object({ nozzle: range(0.1, 2), layer: range(0.04, 1.2) }).strict();
export const testPiecesExportSchema = testPiecesForSchema.extend({ slicer: z.string().min(1).max(80).nullable() }).strict();

/** What the open part is printed with: the printer in use and the part's material. */
export const partPrintSchema = z
  .object({
    printer: printerProfileSchema,
    material: materialProfileSchema,
    /** False while the part uses the default material. */
    chosen: z.boolean(),
    /** Whether the assistant designs to print without support. */
    supportFree: z.boolean(),
    /** The design rule groups in force for this part: the project's choice over the setting. */
    design: designRulesSchema,
  })
  .strict();
export const partMaterialRequestSchema = z.object({ material: profileId }).strict();

/**
 * The result of the ready-to-print check (M7) as the renderer reports it, for the note to the
 * assistant. Worked out in the renderer from the mirrored meshes (`checkPrint` in the geometry
 * package); the main process only words it.
 */
const findingSeveritySchema = z.enum(['block', 'warn']);
const findingPlacesSchema = z
  .array(z.object({ body: bodyName, faces: z.array(faceName).max(40) }).strict())
  .max(20);
const mmValue = finite.nonnegative().max(100_000);
export const printFindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('size'), severity: findingSeveritySchema, size: z.tuple([mmValue, mmValue, mmValue]), bed: z.tuple([mmValue, mmValue, mmValue]), lying: z.boolean() }).strict(),
  z.object({ kind: z.literal('thinWall'), severity: findingSeveritySchema, thickness: mmValue, minimum: mmValue, area: finite.nonnegative(), places: findingPlacesSchema }).strict(),
  z.object({ kind: z.literal('overhang'), severity: findingSeveritySchema, area: finite.nonnegative(), limit: range(0, 90), places: findingPlacesSchema }).strict(),
  z.object({ kind: z.literal('contact'), severity: findingSeveritySchema, area: finite.nonnegative(), places: findingPlacesSchema }).strict(),
  z.object({ kind: z.literal('feature'), severity: findingSeveritySchema, feature: z.string().max(200), message: z.string().max(500) }).strict(),
  z.object({ kind: z.literal('separate'), severity: findingSeveritySchema, bodies: z.array(z.string().max(200)).min(2).max(20) }).strict(),
  z.object({ kind: z.literal('overlap'), severity: findingSeveritySchema, bodies: z.tuple([bodyName, bodyName]), volume: finite.nonnegative(), places: findingPlacesSchema }).strict(),
  z.object({ kind: z.literal('tight'), severity: findingSeveritySchema, bodies: z.tuple([bodyName, bodyName]), gap: mmValue, minimum: mmValue, places: findingPlacesSchema }).strict(),
  z.object({ kind: z.literal('blocked'), severity: findingSeveritySchema, joint: z.string().max(200), bodies: z.tuple([bodyName, bodyName]), at: finite, limit: finite, unit: z.enum(['deg', 'mm']), places: findingPlacesSchema }).strict(),
  z.object({ kind: z.literal('posed'), severity: findingSeveritySchema, joint: z.string().max(200), value: finite, unit: z.enum(['deg', 'mm']) }).strict(),
]);
export const printCheckReportSchema = z
  .object({
    status: z.enum(['ready', 'warn', 'block']),
    findings: z.array(printFindingSchema).max(40),
    /** The printer's nozzle the check used, for the wording of walls under it. */
    nozzle: range(0.1, 2),
    /** The mirrored revision the check belongs to, so a check of an older revision reads as pending. */
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const invokeContract = {
  [invokeChannels.appInfo]: { request: none, response: appInfoSchema },
  [invokeChannels.solidcraftStatus]: { request: none, response: connectionStatusSchema },
  [invokeChannels.solidcraftRetry]: { request: none, response: none },
  [invokeChannels.solidcraftStart]: { request: none, response: none },
  [invokeChannels.solidcraftEngine]: { request: none, response: engineInfoSchema },
  [invokeChannels.solidcraftChooseEngine]: { request: engineChoiceRequestSchema, response: engineChoiceResultSchema },
  [invokeChannels.appRelaunch]: { request: none, response: none },
  [invokeChannels.projectInfo]: { request: none, response: projectInfoSchema },
  [invokeChannels.projectNew]: { request: none, response: none },
  [invokeChannels.projectOpen]: { request: none, response: projectOpenResultSchema },
  [invokeChannels.projectRename]: { request: projectRenameSchema, response: projectRenameResultSchema },
  [invokeChannels.projectDuplicate]: { request: projectTargetSchema, response: none },
  [invokeChannels.projectReveal]: { request: projectTargetSchema, response: none },
  [invokeChannels.projectTrash]: { request: projectTargetSchema, response: none },
  [invokeChannels.projectList]: { request: none, response: projectListSchema },
  [invokeChannels.projectOpenFolder]: { request: projectOpenFolderSchema, response: projectOpenResultSchema },
  [invokeChannels.projectImport]: { request: importRequestSchema, response: projectOpenResultSchema },
  [invokeChannels.projectFromTemplate]: { request: templateRequestSchema, response: projectOpenResultSchema },
  [invokeChannels.projectSavePreview]: { request: projectPreviewSchema, response: none },
  [invokeChannels.projectVersions]: { request: none, response: versionListSchema },
  [invokeChannels.projectSaveVersion]: { request: versionSaveSchema, response: none },
  [invokeChannels.projectRestoreVersion]: { request: versionIdSchema, response: none },
  [invokeChannels.projectCompareVersion]: { request: versionIdSchema, response: versionComparisonSchema },
  [invokeChannels.projectNameVersion]: { request: versionNameSchema, response: none },
  [invokeChannels.projectVersionAsProject]: { request: versionIdSchema, response: none },
  [invokeChannels.projectTrashList]: { request: none, response: trashListSchema },
  [invokeChannels.projectParts]: { request: none, response: partsStateSchema },
  [invokeChannels.projectSetPart]: { request: partSetSchema, response: partsStateSchema },
  [invokeChannels.projectSetMeta]: { request: projectMetaSchema, response: none },
  [invokeChannels.projectExportPackage]: { request: projectTargetSchema, response: packageExportResultSchema },
  [invokeChannels.projectTrashRestore]: { request: trashIdSchema, response: none },
  [invokeChannels.projectTrashEmpty]: { request: none, response: none },
  [invokeChannels.mirrorCurrent]: { request: none, response: mirrorRevisionSchema.nullable() },
  [invokeChannels.agentStatus]: { request: none, response: assistantStateSchema },
  [invokeChannels.agentRefresh]: { request: none, response: assistantStateSchema },
  [invokeChannels.agentSelect]: { request: agentSelectionSchema, response: assistantStateSchema },
  [invokeChannels.agentAllowApiBilling]: { request: apiBillingSchema, response: assistantStateSchema },
  [invokeChannels.agentChooseModel]: { request: modelChoiceRequestSchema, response: assistantStateSchema },
  [invokeChannels.agentResearch]: { request: none, response: z.boolean() },
  [invokeChannels.agentSetResearch]: { request: researchRequestSchema, response: z.boolean() },
  [invokeChannels.agentOllamaContext]: { request: none, response: ollamaContextSchema, },
  [invokeChannels.agentSetOllamaContext]: { request: ollamaContextRequestSchema, response: ollamaContextSchema, },
  [invokeChannels.agentSignOut]: { request: none, response: none },
  [invokeChannels.agentSend]: { request: agentMessageSchema, response: none },
  [invokeChannels.agentStop]: { request: none, response: none },
  [invokeChannels.agentSignIn]: { request: none, response: none },
  [invokeChannels.viewerState]: { request: viewStateSchema, response: none },
  [invokeChannels.windowTitleBar]: { request: titleBarColorsSchema, response: none },
  [invokeChannels.windowTheme]: { request: none, response: themeSchema },
  [invokeChannels.windowSetTheme]: { request: themeRequestSchema, response: themeSchema },
  [invokeChannels.settingsGeneral]: { request: none, response: generalSettingsSchema },
  [invokeChannels.settingsRevealLog]: { request: none, response: none },
  [invokeChannels.settingsSetLanguage]: { request: languageRequestSchema, response: generalSettingsSchema },
  [invokeChannels.settingsChooseProjectsFolder]: { request: none, response: generalSettingsSchema },
  [invokeChannels.settingsResetProjectsFolder]: { request: none, response: generalSettingsSchema },
  [invokeChannels.settingsFinishSetup]: { request: none, response: generalSettingsSchema },
  [invokeChannels.settingsApp]: { request: none, response: appSettingsSchema },
  [invokeChannels.settingsSetApp]: { request: appSettingRequestSchema, response: appSettingsSchema },
  [invokeChannels.settingsReset]: { request: z.object({ section: settingsResetSchema }).strict(), response: generalSettingsSchema },
  [invokeChannels.updatesState]: { request: none, response: updateStateSchema },
  [invokeChannels.updatesCheck]: { request: none, response: updateStateSchema },
  [invokeChannels.updatesDownload]: { request: none, response: none },
  [invokeChannels.updatesInstall]: { request: none, response: none },
  [invokeChannels.designUndo]: { request: none, response: none },
  [invokeChannels.designRedo]: { request: none, response: none },
  [invokeChannels.designExport]: { request: exportRequestSchema, response: exportResultSchema },
  [invokeChannels.designSaveVideo]: { request: videoSaveSchema, response: exportResultSchema },
  [invokeChannels.designShare]: { request: none, response: shareResultSchema },
  [invokeChannels.designOpenInSolidCraft]: { request: none, response: none },
  [invokeChannels.designProbeDimension]: { request: dimensionProbeSchema, response: dimensionProbeResultSchema },
  [invokeChannels.designApplyDimension]: { request: dimensionApplySchema, response: none },
  [invokeChannels.designPreviewAction]: { request: designActionSchema, response: actionPreviewSchema },
  [invokeChannels.designApplyAction]: { request: designActionSchema, response: none },
  [invokeChannels.designMeasure]: { request: measureRequestSchema, response: measureResultSchema },
  [invokeChannels.designClearance]: { request: clearanceRequestSchema, response: clearanceResultSchema },
  [invokeChannels.designDriveJoint]: { request: jointDriveSchema, response: none },
  [invokeChannels.designSweepJoints]: { request: jointSweepRequestSchema, response: jointSweepResultSchema },
  [invokeChannels.designPartsLibrary]: { request: none, response: partsLibrarySchema },
  [invokeChannels.designPreviewBlock]: { request: featureBlockSchema, response: actionPreviewSchema },
  [invokeChannels.designApplyBlock]: { request: featureBlockSchema, response: none },
  [invokeChannels.designLogoAt]: { request: z.object({ point: point3 }).strict(), response: logoSpotSchema.nullable() },
  [invokeChannels.designPreviewLogoMove]: { request: logoMoveSchema, response: actionPreviewSchema },
  [invokeChannels.designMoveLogo]: { request: logoMoveSchema, response: none },
  [invokeChannels.designSlicers]: { request: none, response: slicersSchema },
  [invokeChannels.designSendToSlicer]: { request: sendToSlicerSchema, response: z.object({ name: z.string().max(120) }).strict() },
  [invokeChannels.designPrintFace]: { request: printFaceSchema, response: none },
  [invokeChannels.designPrintFaces]: { request: none, response: printFacesSchema },
  [invokeChannels.designInsertPart]: { request: partInsertSchema, response: partInsertResultSchema },
  [invokeChannels.designTimeline]: { request: timelineCommandSchema, response: none },
  [invokeChannels.designGoToStep]: { request: goToStepSchema, response: none },
  [invokeChannels.designDimensions]: { request: dimensionMarksRequestSchema, response: dimensionMarksSchema },
  [invokeChannels.designProbeParameter]: { request: parameterProbeSchema, response: actionPreviewSchema },
  [invokeChannels.designParameters]: { request: none, response: designParametersSchema },
  [invokeChannels.chatLoad]: { request: none, response: storedChatSchema.nullable() },
  // The project's assembly order (ADR 0026); null when the assistant has not set one.
  [invokeChannels.assemblyGet]: { request: none, response: assemblyPlanSchema.nullable() },
  [invokeChannels.sketchList]: { request: none, response: z.array(keptSketchSchema).max(50) },
  [invokeChannels.sketchLoad]: { request: z.object({ id: keptSketchSchema.shape.id }).strict(), response: sketchStateSchema.nullable() },
  [invokeChannels.chatSave]: { request: chatSaveSchema, response: none },
  [invokeChannels.designVisibility]: { request: visibilityCommandSchema, response: none },
  [invokeChannels.designRenameBody]: { request: z.object({ body: bodyName, name: bodyName }).strict(), response: none },
  [invokeChannels.designInsert]: { request: importRequestSchema, response: insertResultSchema },
  [invokeChannels.designRepair]: { request: repairRequestSchema, response: repairResultSchema },
  [invokeChannels.notesCurrent]: { request: none, response: notesStateSchema },
  [invokeChannels.notesAdd]: { request: noteAddSchema, response: none },
  [invokeChannels.notesEdit]: { request: noteEditSchema, response: none },
  [invokeChannels.notesDelete]: { request: noteIdRequestSchema, response: none },
  [invokeChannels.notesAccept]: { request: noteIdRequestSchema, response: none },
  [invokeChannels.notesReattach]: { request: noteReattachSchema, response: none },
  [invokeChannels.notesRestore]: { request: noteIdRequestSchema, response: none },
  [invokeChannels.notesDismiss]: { request: noteIdRequestSchema, response: none },
  [invokeChannels.printSettings]: { request: none, response: printSettingsSchema },
  [invokeChannels.printSaveSettings]: { request: printSettingsSchema, response: printSettingsSchema },
  [invokeChannels.printPart]: { request: none, response: partPrintSchema },
  [invokeChannels.printSetMaterial]: { request: partMaterialRequestSchema, response: partPrintSchema },
  [invokeChannels.printReportCheck]: { request: printCheckReportSchema, response: none },
  [invokeChannels.printTestPiecesPicture]: { request: testPiecesForSchema, response: z.object({ picture: z.string().startsWith('data:image/png;base64,').max(8_000_000).nullable() }).strict() },
  [invokeChannels.printTestPiecesExport]: { request: testPiecesExportSchema, response: z.object({ file: z.string().max(260).nullable(), slicer: z.string().max(120).nullable() }).strict().nullable() },
} as const satisfies Record<InvokeChannel, { request: z.ZodType; response: z.ZodType }>;

export const eventContract = {
  [eventChannels.solidcraftStatus]: connectionStatusSchema,
  [eventChannels.mirrorRevision]: mirrorRevisionSchema,
  [eventChannels.agentStatus]: assistantStateSchema,
  [eventChannels.updatesState]: updateStateSchema,
  [eventChannels.agentEvent]: agentEventSchema,
  [eventChannels.notesChanged]: notesStateSchema,
  [eventChannels.printChanged]: partPrintSchema,
  [eventChannels.assemblyChanged]: assemblyPlanSchema.nullable(),
  [eventChannels.printFacesChanged]: printFacesSchema,
} as const satisfies Record<EventChannel, z.ZodType>;

export type FaceTableMessage = z.infer<typeof faceTableSchema>;
export type ConnectionState = z.infer<typeof connectionStateSchema>;
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export type MirroredBody = z.infer<typeof mirroredBodySchema>;
export type MirroredSketch = z.infer<typeof mirroredSketchSchema>;
export type MirrorRevision = z.infer<typeof mirrorRevisionSchema>;
export type AppInfo = z.infer<typeof appInfoSchema>;
export type EngineInfo = z.infer<typeof engineInfoSchema>;
export type ProjectInfo = z.infer<typeof projectInfoSchema>;
export type ProjectRenameResult = z.infer<typeof projectRenameResultSchema>;
export type ProjectOpenResult = z.infer<typeof projectOpenResultSchema>;
export type InsertResult = z.infer<typeof insertResultSchema>;
export type PartFamily = z.infer<typeof partFamilySchema>;
export type Slicer = z.infer<typeof slicersSchema>[number];
export type PartsLibrary = z.infer<typeof partsLibrarySchema>;
export type PartInsert = z.infer<typeof partInsertSchema>;
export type Language = z.infer<typeof languageSchema>;
export type SettingsReset = z.infer<typeof settingsResetSchema>;
export type AppSettings = z.infer<typeof appSettingsSchema>;
export type AppSettingRequest = z.infer<typeof appSettingRequestSchema>;
export type UpdateState = z.infer<typeof updateStateSchema>;
export type GeneralSettingsInfo = z.infer<typeof generalSettingsSchema>;
export type VersionEntry = z.infer<typeof versionEntrySchema>;
export type VersionComparison = z.infer<typeof versionComparisonSchema>;
export type RepairResult = z.infer<typeof repairResultSchema>;
export type ProjectCheck = z.infer<typeof projectCheckSchema>;
export type ProjectEntry = z.infer<typeof projectEntrySchema>;
export type TrashEntry = z.infer<typeof trashEntrySchema>;
export type PartNote = z.infer<typeof partNoteSchema>;
export type PartsState = z.infer<typeof partsStateSchema>;
export type ProjectPreview = z.infer<typeof projectPreviewSchema>;
export type EngineChoiceError = z.infer<typeof engineChoiceErrorSchema>;
export type EngineChoiceResult = z.infer<typeof engineChoiceResultSchema>;
export type AgentKind = z.infer<typeof agentKindSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type ModelOption = z.infer<typeof modelOptionSchema>;
export type ModelChoice = z.infer<typeof modelChoiceSchema>;
export type AssistantState = z.infer<typeof assistantStateSchema>;
export type AgentEvent = z.infer<typeof agentEventSchema>;
export type ResearchSource = z.infer<typeof researchSourceSchema>;
export type FaceSelection = z.infer<typeof faceSelectionSchema>;
export type EdgeSelection = z.infer<typeof edgeSelectionSchema>;
export type Selection = z.infer<typeof selectionSchema>;
export type StoredChatItem = z.infer<typeof storedChatItemSchema>;
export type StoredChat = z.infer<typeof storedChatSchema>;
export type WorkStep = z.infer<typeof workStepSchema>;
export type AgentQuestion = z.infer<typeof agentQuestionSchema>;
export type MessageAnswer = z.infer<typeof messageAnswerSchema>;
export type WorkStepState = z.infer<typeof workStepStateSchema>;
export type ViewState = z.infer<typeof viewStateSchema>;
export type TitleBarColors = z.infer<typeof titleBarColorsSchema>;
export type Theme = z.infer<typeof themeSchema>;
export type PrinterProfile = z.infer<typeof printerProfileSchema>;
export type MaterialProfile = z.infer<typeof materialProfileSchema>;
export type FitKind = z.infer<typeof fitKindSchema>;
export type PrintSettings = z.infer<typeof printSettingsSchema>;
export type PartPrint = z.infer<typeof partPrintSchema>;
export type PrintCheckReport = z.infer<typeof printCheckReportSchema>;
export type DesignParameter = z.infer<typeof designParameterSchema>;
export type ExportFormat = z.infer<typeof exportFormatSchema>;
export type ExportResult = z.infer<typeof exportResultSchema>;
export type VideoSave = z.infer<typeof videoSaveSchema>;
export type ShareResult = z.infer<typeof shareResultSchema>;
export type LogoSpot = z.infer<typeof logoSpotSchema>;
export type LogoMoveRequest = z.infer<typeof logoMoveSchema>;
export type DimensionTarget = z.infer<typeof dimensionTargetSchema>;
export type DimensionProbe = z.infer<typeof dimensionProbeSchema>;
export type DimensionProbeResult = z.infer<typeof dimensionProbeResultSchema>;
export type DimensionApply = z.infer<typeof dimensionApplySchema>;
export type DesignAction = z.infer<typeof designActionSchema>;
export type ActionPreviewResult = z.infer<typeof actionPreviewSchema>;
export type MeasureItem = z.infer<typeof measureItemSchema>;
export type MeasureResult = z.infer<typeof measureResultSchema>;
export type ClearanceResult = z.infer<typeof clearanceResultSchema>;
export type TimelineFeature = z.infer<typeof timelineFeatureSchema>;
export type Structure = z.infer<typeof structureSchema>;
export type Joint = z.infer<typeof jointSchema>;
export type JointDrive = z.infer<typeof jointDriveSchema>;
export type JointSweep = z.infer<typeof jointSweepRequestSchema>['sweeps'][number];
export type JointSweepResult = z.infer<typeof jointSweepResultSchema>;
export type TimelineCommand = z.infer<typeof timelineCommandSchema>;
export type VisibilityCommand = z.infer<typeof visibilityCommandSchema>;
export type NoteView = z.infer<typeof noteViewSchema>;
export type DimensionMark = z.infer<typeof dimensionMarkSchema>;
export type NotesState = z.infer<typeof notesStateSchema>;

export type InvokeRequest<C extends InvokeChannel> = z.infer<(typeof invokeContract)[C]['request']>;
export type InvokeResponse<C extends InvokeChannel> = z.infer<(typeof invokeContract)[C]['response']>;
export type EventPayload<C extends EventChannel> = z.infer<(typeof eventContract)[C]>;
