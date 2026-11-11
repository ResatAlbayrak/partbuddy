/**
 * Small, deterministic repairs for local-model tool arguments.
 * Never guess CAD coordinates or silently rewrite geometry or parameter names.
 */

function commandStep(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const step = value as Record<string, unknown>;
  return typeof step.command === 'string' && step.command.length > 0 &&
    (step.params === undefined || (typeof step.params === 'object' && step.params !== null && !Array.isArray(step.params)));
}

/**
 * Correct only unambiguous JSON encoding errors; never guess coordinates,
 * feature names, CAD commands or numeric values.
 */
function jsonArray(value: unknown): unknown[] | null {
  if (typeof value !== 'string' || value.length > 100_000) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function faceSelection(value: unknown): boolean {
  return typeof value === 'string' ||
    (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' || typeof v === 'string'));
}

function commandParams(command: string, params: Record<string, unknown>): Record<string, unknown> {
  if (command !== 'solid.shell' || typeof params.faces !== 'string') return params;
  const faces = jsonArray(params.faces);
  return faces?.every(faceSelection) ? { ...params, faces } : params;
}

function normalizeStep(value: unknown): unknown {
  if (!commandStep(value)) return value;
  const step = value as { command: string; params?: Record<string, unknown> };
  if (!step.params) return step;
  const params = commandParams(step.command, step.params);
  return params === step.params ? step : { ...step, params };
}

/** Normalize encoded command arrays and encoded shell face lists, then apply policy checks. */
export function normalizeToolArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'execute') {
    if (typeof args.command !== 'string' || typeof args.params !== 'object' || args.params === null || Array.isArray(args.params)) return args;
    const params = commandParams(args.command, args.params as Record<string, unknown>);
    return params === args.params ? args : { ...args, params };
  }
  if (name !== 'batch') return args;
  const decoded = jsonArray(args.commands);
  const commands = decoded?.every(commandStep) ? decoded : args.commands;
  if (!Array.isArray(commands)) return args;
  const normalized = commands.map(normalizeStep);
  return { ...args, commands: normalized };
}

/** Place the most common SolidCraft traps beside the actual tool descriptions. */
export function cadToolDescription(name: string, description: string): string {
  switch (name) {
    case 'batch':
      return `${description}\nPartBuddy: "commands" MUST be a JSON array of {command, params} objects, never a quoted JSON string. Use small batches. A failed batch is not proof that any feature was created.`;
    case 'execute':
      return `${description}\nPartBuddy: Verify CAD command ids using describe_command. There is no solid.round or solid.union; see solid.fillet and solid.combine respectively. For solid.shell, faces must be an array of face names or 3D points, not a JSON string. For solid.fillet select points on edges (not vertices).`;
    case 'set_parameter':
      return `${description}\nPartBuddy: Parameter names must not be expression function names such as "floor"; use "floorThickness" instead.`;
    case 'body_topology':
      return `${description}\nPartBuddy: Use the exact body name returned by inspect_design; do not invent a name from the requested feature.`;
    default:
      return description;
  }
}
