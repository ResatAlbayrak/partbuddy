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
 * Some local models serialize a batch's commands array into a JSON string.
 * Only repair this one unambiguous encoding mistake. Policy checks run AFTER normalization.
 */
export function normalizeToolArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name !== 'batch' || typeof args.commands !== 'string' || args.commands.length > 100_000) return args;
  try {
    const parsed: unknown = JSON.parse(args.commands);
    if (Array.isArray(parsed) && parsed.every(commandStep)) return { ...args, commands: parsed };
  } catch {
    // Leave malformed input intact: the policy rejects it rather than forwarding it.
  }
  return args;
}

/** Place the most common SolidCraft traps beside the actual tool descriptions. */
export function cadToolDescription(name: string, description: string): string {
  switch (name) {
    case 'batch':
      return `${description}\nPartBuddy: "commands" MUST be a JSON array of {command, params} objects, never a quoted JSON string. Use small batches. A failed batch is not proof that any feature was created.`;
    case 'execute':
      return `${description}\nPartBuddy: Check unknown commands with describe_command before using them. For solid.fillet use a point on the edge, preferably its midpoint from current body_topology, NOT a vertex where multiple edges meet.`;
    case 'set_parameter':
      return `${description}\nPartBuddy: Parameter names must not be expression function names such as "floor"; use "floorThickness" instead.`;
    case 'body_topology':
      return `${description}\nPartBuddy: Use the exact body name returned by inspect_design; do not invent a name from the requested feature.`;
    default:
      return description;
  }
}
