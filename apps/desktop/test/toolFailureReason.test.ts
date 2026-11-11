import { describe, expect, it } from 'vitest';

import { toolFailureReason } from '../src/main/agents/loop';

describe('SolidCraft tool error diagnostics', () => {
  it('extracts the failed command error from a JSON reply', () => {
    expect(toolFailureReason({
      isError: true,
      content: [{ type: 'text', text: '{"failed":{"command":"solid.fillet","error":"No edge at that point"}}' }],
    })).toBe('No edge at that point');
  });

  it('preserves plain-text errors and truncates them for the UI', () => {
    expect(toolFailureReason({ isError: true, content: [{ type: 'text', text: 'Invalid thickness' }] })).toBe('Invalid thickness');
    expect(toolFailureReason({ isError: true, content: [{ type: 'text', text: 'x'.repeat(600) }] })?.length).toBe(500);
  });

  it('does not expose successful tool results as errors', () => {
    expect(toolFailureReason({ isError: false, content: [{ type: 'text', text: 'ok' }] })).toBeUndefined();
  });
});
