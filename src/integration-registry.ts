// The optional integrations this router knows (plan
// 2026-11-08-optional-integrations-config.md). A config name that is not in
// here is reported as unknown, never silently ignored. Kept out of
// integration.ts: that module must not depend on the Laya classifier.
import type { IntegrationSpec } from './integration.ts';
import { LAYA_SPEC } from './laya-classifier.ts';

export const INTEGRATION_SPECS: Readonly<Record<string, IntegrationSpec>> = {
  [LAYA_SPEC.name]: LAYA_SPEC,
};
