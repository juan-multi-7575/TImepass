import { describe, expect, it } from 'vitest';
import {
  isCompletedAnswer,
  type CompletedAnswerEnvelope,
  type LegacyRecoveredEnvelope,
} from './types.js';

/**
 * The predicate every completed-answer check funnels through.
 *
 * It is the runtime half of issue #5's shared envelope: the types say what a
 * producer must send, this decides what the host accepts, and the two must not
 * drift into disagreeing about the same payload.
 */
describe('isCompletedAnswer', () => {
  it('accepts the canonical envelope', () => {
    const envelope: CompletedAnswerEnvelope = { success: true, turnComplete: true, text: 'Tokyo' };
    expect(isCompletedAnswer(envelope)).toBe(true);
  });

  it('accepts a canonical envelope with no text, because Gemini returned nothing', () => {
    expect(isCompletedAnswer({ success: true, turnComplete: true, text: '' })).toBe(true);
  });

  it('accepts the legacy recovered envelope that omits turnComplete', () => {
    const envelope: LegacyRecoveredEnvelope = { success: true, recovered: true, text: 'Blue' };
    expect(isCompletedAnswer(envelope)).toBe(true);
  });

  it('rejects a turn that is still generating', () => {
    expect(isCompletedAnswer({ success: true, turnComplete: false, text: 'half an ans' })).toBe(false);
  });

  it('rejects a success envelope that says nothing about completion', () => {
    // No turnComplete and no recovered flag is not evidence of a finished turn.
    expect(isCompletedAnswer({ success: true, text: 'who knows' })).toBe(false);
  });

  it('rejects a recovered envelope with no answer in it', () => {
    expect(isCompletedAnswer({ success: true, recovered: true, text: '' })).toBe(false);
    expect(isCompletedAnswer({ success: true, recovered: true })).toBe(false);
  });

  it('rejects a failure envelope even when it carries text', () => {
    expect(isCompletedAnswer({ success: false, turnComplete: true, text: 'Tokyo' })).toBe(false);
    expect(isCompletedAnswer({ success: false, recovered: true, text: 'Blue' })).toBe(false);
  });

  it('rejects everything that is not a reply envelope at all', () => {
    for (const value of [null, undefined, '', 'Blue', 42, [], true]) {
      expect(isCompletedAnswer(value)).toBe(false);
    }
  });
});