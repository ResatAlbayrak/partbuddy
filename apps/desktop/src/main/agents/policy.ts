/**
 * Tool policy of the gate proxy (ADR 0010, ADR 0015). Every SolidCraft tool an external agent
 * calls passes here first; the model cannot skip it, because the agent sees SolidCraft only
 * through PartBuddy's proxy.
 */

import { METADATA_PREFIX } from '../notes/noteRecord';
import { PHOTO_FILE } from './photoNote';

export type ToolDecision = { allow: true } | { allow: false; reason: string };

/** Tools that read, model or render without touching files or discarding work. */
const ALLOWED = new Set([
  'list_commands',
  'describe_command',
  'execute',
  'batch',
  'inspect_design',
  'measure',
  'body_topology',
  'set_parameter',
  'check_parameters',
  'screenshot',
  'compare_picture',
  'running',
  'pending',
  'undo',
  'redo',
  'skill_reference',
  // Answered by PartBuddy itself from its own view (viewContext.ts), never forwarded.
  'partbuddy_view',
  // Cards in PartBuddy's chat (questions.ts), never forwarded.
  'partbuddy_ask',
  'partbuddy_plan',
  // The assembly order (assemblyTool.ts), kept by PartBuddy, never forwarded.
  'partbuddy_assembly',
  // The design rule groups of the project (designTool.ts), kept by PartBuddy, never forwarded.
  'partbuddy_design_rules',
  // Moves a placed logo through sketch.redefine (drawingTool.ts), answered by PartBuddy.
  'partbuddy_move_drawing',
  // Places an attached SVG as a logo with the logo block's steps (drawingTool.ts), answered by PartBuddy.
  'partbuddy_place_drawing',
  // Builds a print-in-place hinge with its joint from engine commands (mechanismTool.ts), answered by PartBuddy.
  'partbuddy_mechanism',
  // Builds a function block or a wall mounting from the standard tables (blockTool.ts), answered by PartBuddy.
  'partbuddy_block',
]);

/**
 * Tools that discard the design or read and write files. They need the confirmation and export
 * gates of ADR 0010, which the preview does not have yet, so they are refused with a reason the
 * model can pass on.
 */
const NEEDS_CONFIRMATION: Record<string, string> = {
  new_design: 'starting a new design discards the current one',
  open: 'opening a file replaces the design',
  save: 'PartBuddy saves the design by itself after every change',
  export: 'the user exports with PartBuddy’s Export button (3MF, STL, STEP)',
};

/**
 * Tools SolidCraft also runs as `batch` steps (SolidCraft 0.30.1, batch tool description). Such a
 * step is decided like a call of that tool, so `{command: "save"}` in a batch is refused as well.
 */
const BATCH_TOOL_STEPS = new Set([
  'set_parameter',
  'list_commands',
  'describe_command',
  'execute',
  'measure',
  'compare_picture',
  'inspect_design',
  'undo',
  'redo',
  'export',
  'save',
  'open',
  'new_design',
  'crash_reports',
]);

/**
 * Engine commands that open, save, export, upload or hand files to other programs, change app
 * settings or read crash reports.
 */
const FILE_COMMANDS = /^(file|doc|settings|diagnostics)\./;

/**
 * The only text a geometry `path` holds: a sketch curve id such as "l1". SolidCraft also uses
 * `path` for curve lists, occurrence paths and edge refs (arrays and objects); any other text in
 * `path` is taken as a file name, so an unknown form is refused rather than written.
 */
const CURVE_ID = /^[a-z]{1,3}\d{1,6}$/;

/** Metadata commands and the keys they write: PartBuddy's own keys hold the user's notes (ADR 0020). */
const METADATA_WRITES = new Set(['document.metadata.set', 'document.metadata.remove', 'component.metadata.set']);

function metadataKeys(params: Record<string, unknown>): string[] {
  const keys: string[] = [];
  if (typeof params.key === 'string') keys.push(params.key);
  if (Array.isArray(params.keys)) keys.push(...params.keys.filter((key): key is string => typeof key === 'string'));
  if (typeof params.values === 'object' && params.values !== null) keys.push(...Object.keys(params.values));
  return keys;
}

/** Checkpoints restore around PartBuddy's undo-based work log (ADR 0018) and drop its later steps. */
const HISTORY_COMMANDS = new Set(['edit.checkpoint', 'edit.restore_checkpoint']);

const refuse = (reason: string): ToolDecision => ({ allow: false, reason });

function objectOr(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** One engine command, as `execute` or a `batch` step sends it. */
function decideCommand(command: string, params: Record<string, unknown>): ToolDecision {
  if (FILE_COMMANDS.test(command)) {
    return refuse(
      `${command} reads or writes files or settings; PartBuddy does not allow it for the assistant. PartBuddy saves the ` +
        'design by itself, and the user exports with the Export button. Continue without it.',
    );
  }
  if (METADATA_WRITES.has(command) && metadataKeys(params).some((key) => key.toLowerCase().startsWith(METADATA_PREFIX))) {
    return refuse(
      `${command} would change PartBuddy's notes; only the user writes notes. Read them with partbuddy_view and continue without it.`,
    );
  }
  if (HISTORY_COMMANDS.has(command)) {
    return refuse(
      `${command} is not available in PartBuddy: PartBuddy keeps the history as steps the user can go back to. Use undo ` +
        'and redo instead.',
    );
  }
  // A photo the user sent (F6) may be laid out as a canvas; it is read, never written.
  if (command === 'canvas.insert' && typeof params.path === 'string' && PHOTO_FILE.test(params.path) && !params.path.includes('..')) {
    return { allow: true };
  }
  if (typeof params.path === 'string' && !CURVE_ID.test(params.path)) {
    return refuse(
      `${command} with a path reads or writes a file; PartBuddy does not allow that for the assistant. Leave out path ` +
        'if the command can answer with its content, or continue without it.',
    );
  }
  if ((command === 'set_parameter' || command === 'parameters.change') && params.name === 'floor') {
    return refuse('`floor` is a reserved expression function. Use `floorThickness` and update its references.');
  }
  return { allow: true };
}

function decideBatch(args: Record<string, unknown>, depth: number): ToolDecision {
  if (!Array.isArray(args.commands)) return refuse('batch.commands must be a JSON array of command objects, not a string. No commands were executed.');
  const steps = args.commands as unknown[];
  for (const [index, entry] of steps.entries()) {
    const step = objectOr(entry);
    const command = typeof step.command === 'string' ? step.command : '';
    if (!command) return refuse(`batch step ${index} must name a command`);
    const params = objectOr(step.params);
    const decision = BATCH_TOOL_STEPS.has(command) ? decideTool(command, params, depth + 1) : decideCommand(command, params);
    if (!decision.allow) return refuse(`batch step ${index} (${command || 'no command'}): ${decision.reason}`);
  }
  return { allow: true };
}

function decideTool(name: string, args: Record<string, unknown>, depth: number): ToolDecision {
  const confirmation = NEEDS_CONFIRMATION[name];
  if (confirmation) {
    return refuse(`${name} is not available in PartBuddy yet: ${confirmation}. Tell the user how to do it in PartBuddy instead.`);
  }
  if (!ALLOWED.has(name)) return refuse(`${name} is not allowed by PartBuddy. Continue with the other tools.`);
  // SolidCraft refuses nested batches itself; a deeper nesting is refused here rather than walked.
  if (depth > 2) return refuse(`${name} is nested too deeply`);
  if (name === 'set_parameter') return decideCommand(name, args);
  if (name === 'execute') {
    return decideCommand(typeof args.command === 'string' ? args.command : '', objectOr(args.params));
  }
  if (name === 'batch') return decideBatch(args, depth);
  return { allow: true };
}

export function decide(name: string, args: Record<string, unknown>): ToolDecision {
  return decideTool(name, args, 0);
}
