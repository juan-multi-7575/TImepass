import { describe, it, expect } from 'vitest';
import { ComponentRegistry } from './registry.js';
import { PromptInputHandler } from './prompt-input.js';
import { SendButtonHandler } from './send-button.js';

describe('ComponentRegistry', () => {
  it('should register and retrieve component handlers', () => {
    const registry = new ComponentRegistry();
    const promptHandler = new PromptInputHandler();
    const sendHandler = new SendButtonHandler();

    registry.register(promptHandler);
    registry.register(sendHandler);

    expect(registry.has('promptInput')).toBe(true);
    expect(registry.has('sendButton')).toBe(true);
    expect(registry.get('promptInput')).toBe(promptHandler);
    expect(registry.list()).toEqual(['promptInput', 'sendButton']);
  });
});
