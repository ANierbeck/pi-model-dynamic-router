/**
 * stripHintHead removes the HINT head of a pinned prompt so the classifier
 * sees only the turn's content (see groupStream / classifyBehindPin). Each
 * head shape detectHintDirectly accepts must be stripped; anything else must
 * pass through untouched.
 */
import { describe, it, expect } from 'vitest';
import { stripHintHead, detectHintDirectly } from '../src/content-classifier.ts';

describe('stripHintHead', () => {
  it.each([
    ['HINT: opus refactor the rate limiter', 'refactor the rate limiter'],
    ['HINT: use mistral/glm refactor the rate limiter', 'refactor the rate limiter'],
    ['HINT use mistral/glm refactor the rate limiter', 'refactor the rate limiter'],
    ['HINT: nutze claude-bridge/opus refactor it', 'refactor it'],
    ['HINT: benutze modell mistral/glm refactor it', 'refactor it'],
    ['MHINT: mistral/m do the thing', 'do the thing'],
    ['MODEL-HINT: mistral/m do the thing', 'do the thing'],
    ['HINT: use group planning\nfix the typo', 'fix the typo'],
    ['HINT: verwende gruppe planning\nbitte prüfen', 'bitte prüfen'],
  ])('strips the head of %j', (prompt, content) => {
    expect(stripHintHead(prompt)).toBe(content);
  });

  it('leaves a prompt without a HINT head untouched', () => {
    expect(stripHintHead('please refactor the HINT parser')).toBe(
      'please refactor the HINT parser'
    );
  });

  it('a head that is only a pin leaves nothing to classify', () => {
    expect(stripHintHead('HINT: claude-bridge/opus')).toBe('');
  });

  it('agrees with detectHintDirectly on every shape it strips', () => {
    for (const prompt of ['HINT: use group planning\nx', 'HINT use mistral/glm x', 'MHINT: m x']) {
      expect(detectHintDirectly(prompt)).not.toBeNull();
      expect(stripHintHead(prompt)).toBe('x');
    }
  });
});
