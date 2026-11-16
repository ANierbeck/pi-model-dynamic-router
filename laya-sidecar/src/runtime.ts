// Where the ONNX runtime comes from (plan docs/plans/2026-11-16-laya-sidecar-in-router-tarball.md).
// The shipped sidecar has no dependency tree: `onnxruntime-node` is installed on demand into a
// runtime directory (`pi-laya-model runtime install`). The vendored laya code imports it by its
// bare name, which Node resolves next to the importing file, so the name is anchored at the
// runtime directory with a resolve hook instead of changing the vendored code.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RUNTIME_PACKAGE = 'onnxruntime-node';

/**
 * Makes `import('onnxruntime-node')` resolve from `<runtimeDir>/node_modules`. Throws, naming the
 * install command, when the runtime is not there. Call once, before the model is opened.
 */
export function useRuntime(runtimeDir: string): void {
  if (!existsSync(join(runtimeDir, 'node_modules', RUNTIME_PACKAGE, 'package.json'))) {
    throw new Error(
      `ONNX runtime not found in ${runtimeDir}; install it with: pi-laya-model runtime install`
    );
  }
  const anchor = pathToFileURL(join(runtimeDir, 'package.json')).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === RUNTIME_PACKAGE
        ? nextResolve(specifier, { ...context, parentURL: anchor })
        : nextResolve(specifier, context);
    },
  });
}
