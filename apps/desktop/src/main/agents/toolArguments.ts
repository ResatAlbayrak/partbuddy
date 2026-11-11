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
  let source = value.trim();
  // Some models add a second layer of JSON quoting; others leave the
  // backslashes from an escaped object string literally in the array.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const parsed: unknown = JSON.parse(source);
      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed !== 'string' || parsed.length > 100_000 || parsed === source) return null;
      source = parsed.trim();
    } catch {
      // Repair only the quoting, and only for a string shaped like a JSON array.
      // Invalid syntax stays invalid; no commands are executed.
      if (!source.startsWith('[')) return null;
      const unescaped = source.replace(/\\+"/g, '"');
      if (unescaped === source) return null;
      source = unescaped;
    }
  }
  return null;
}

function faceSelection(value: unknown): boolean {
  return typeof value === 'string' ||
    (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' || typeof v === 'string'));
}

/** Split two coordinate expressions only at a top-level comma (not inside max(a,b)). */
function coordinatePair(value: unknown): unknown {
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string') return value;
  const source = value[0];
  let depth = 0;
  let separator = -1;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth < 0) return value;
    } else if (char === ',' && depth === 0) {
      if (separator >= 0) return value;
      separator = i;
    }
  }
  if (depth !== 0 || separator < 0) return value;
  const left = source.slice(0, separator).trim();
  const right = source.slice(separator + 1).trim();
  return left && right ? [left, right] : value;
}

function commandParams(command: string, params: Record<string, unknown>): Record<string, unknown> {
  if (command === 'solid.shell' && typeof params.faces === 'string') {
    const faces = jsonArray(params.faces);
    return faces?.every(faceSelection) ? { ...params, faces } : params;
  }
  if (command === 'sketch.rectangle.two_point') {
    const p0 = coordinatePair(params.p0);
    const p1 = coordinatePair(params.p1);
    return p0 === params.p0 && p1 === params.p1 ? params : { ...params, p0, p1 };
  }
  return params;
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
      return `${description}\nPartBuddy: "commands" MUST be an actual JSON array of {command, params} objects, never quoted or escaped JSON text. For sketch.rectangle.two_point, p0 and p1 each need TWO separate coordinates, e.g. ["L/2", "W/2"], not ["L/2, W/2"]. Use small batches and check failures before claiming success.`;
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
