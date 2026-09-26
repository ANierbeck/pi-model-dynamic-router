// test/config-classifier-model.test.ts
// ADR-0009: the bundled dynamic.classifier_model overrides DEFAULT_MODEL in
// content-classifier.ts, so it must itself be schema-capable. Ollama's MLX
// backend rejects every JSON-schema call with HTTP 501 (live 2026-09-26).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoCfg = JSON.parse(readFileSync(join(repoRoot, 'router-config.json'), 'utf-8'));

describe('bundled classifier model config', () => {
  it('does not configure an MLX-backend model as classifier primary', () => {
    const primary: string = repoCfg.model_groups.dynamic.classifier_model;
    expect(primary).toBeTruthy();
    expect(primary).not.toMatch(/-mlx\b/i);
  });

  it('matches the DEFAULT_MODEL in content-classifier.ts', () => {
    const src = readFileSync(join(repoRoot, 'src/content-classifier.ts'), 'utf-8');
    const def = src.match(/const DEFAULT_MODEL = '([^']+)'/)?.[1];
    expect(def).toBeTruthy();
    expect(repoCfg.model_groups.dynamic.classifier_model).toBe(`ollama/${def}`);
  });
});
