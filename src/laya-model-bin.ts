#!/usr/bin/env node
// src/laya-model-bin.ts — entry of the pi-laya-model command (package.json
// `bin`, bundled to dist/laya-model-install.js). All logic and its tests live
// in laya-model-install.ts; this file only wires the process to it.

import { main } from './laya-model-install.ts';

process.exitCode = await main(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  isTTY: process.stderr.isTTY,
});
