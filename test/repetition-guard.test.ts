import { describe, it, expect } from 'vitest';
import {
  detectDegenerateRepetition,
  REPETITION_MIN_TOTAL_LEN,
  REPETITION_MIN_REPEATS,
} from '../src/repetition-guard.ts';

describe('detectDegenerateRepetition', () => {
  it('does not flag normal prose', () => {
    const text =
      'This is a perfectly normal response about how the router selects models. ' +
      'It explains the GDPval scoring pipeline, the fallback cascade, and how rate limits ' +
      'are handled across providers, without ever repeating itself verbatim in a loop. ' +
      'Each provider is scanned on startup, pricing is cached, and GDPval scores are ' +
      'scraped once and reused across sessions unless a manual rescan is requested by name, ' +
      'and the cache is invalidated automatically after the configured expiry window elapses.';
    expect(text.length).toBeGreaterThan(REPETITION_MIN_TOTAL_LEN);
    expect(detectDegenerateRepetition(text)).toEqual({ detected: false });
  });

  it('flags a sentence repeated 6+ times consecutively', () => {
    const sentence = 'Ich möchte jetzt die Datei bearbeiten und speichern. ';
    const text = sentence.repeat(REPETITION_MIN_REPEATS + 2);
    const result = detectDegenerateRepetition(text);
    expect(result.detected).toBe(true);
    expect(result.repeats).toBeGreaterThanOrEqual(REPETITION_MIN_REPEATS);
    expect(result.unit?.trim()).toContain('Datei bearbeiten');
  });

  it('does not flag text shorter than the minimum total length, even if repetitive', () => {
    const sentence = 'Same short phrase here. ';
    const text = sentence.repeat(4); // well under REPETITION_MIN_TOTAL_LEN
    expect(text.length).toBeLessThan(REPETITION_MIN_TOTAL_LEN);
    expect(detectDegenerateRepetition(text)).toEqual({ detected: false });
  });

  it('requires at least REPETITION_MIN_REPEATS consecutive repeats', () => {
    const sentence = 'This exact phrase keeps coming back for no good reason. ';
    const almostEnough = sentence.repeat(REPETITION_MIN_REPEATS - 1);
    const padded = almostEnough.padStart(REPETITION_MIN_TOTAL_LEN + 20, 'x');
    expect(detectDegenerateRepetition(padded).detected).toBe(false);
  });

  it('ignores a mid-stream loop that the model recovered from', () => {
    const loop = 'Repeating this line over and over again right now. '.repeat(REPETITION_MIN_REPEATS + 2);
    const recovered =
      'Sorry, let me restart. Here is the actual unique answer to your question, ' +
      'written out in full without repeating any earlier sentence verbatim at all.';
    const text = loop + recovered;
    // Detection only looks at the tail — the loop is history, not current state.
    expect(detectDegenerateRepetition(text).detected).toBe(false);
  });

  it('does not flag repeated markdown table separators (low letter content)', () => {
    const row = '|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|';
    const text = row.repeat(10);
    expect(detectDegenerateRepetition(text).detected).toBe(false);
  });

  it('does not flag varying numbered list items', () => {
    const items = [
      '1. Buy milk and bread from the store today.',
      '2. Pick up the dry cleaning before it closes.',
      '3. Call the dentist to reschedule the appointment.',
      '4. Water the plants on the back porch.',
      '5. Finish reading the chapter for book club.',
      '6. Reply to the pending emails from work.',
      '7. Pay the electricity bill before it is due.',
      '8. Take the car in for its scheduled service.',
    ];
    const text = items.join('\n').repeat(3);
    expect(detectDegenerateRepetition(text).detected).toBe(false);
  });
});
