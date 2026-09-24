// Single source of truth for the app's root directory — the parent of the
// server/ sources in a checkout, the exe's own folder in a packaged build.
// Everything on disk (data/, dist/, bin/, models/) is resolved from here, so
// the packaged exe simply lays the same tree down next to itself and the rest
// of the server code stays untouched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Base the require on the executable path rather than import.meta.url: the
// CJS bundle esbuild produces for the packaged exe has no import.meta.
const require_ = createRequire(process.execPath);

// node:sea exists on Node >= 20.12; older runtimes just aren't a packaged
// build, so the failed lookup falls through to the checkout layout.
let seaModule = null;
try {
  seaModule = require_('node:sea');
} catch {
  /* not available — running as a plain checkout */
}

export const IS_SEA = seaModule ? seaModule.isSea() : false;

/** Can we create files in this directory? (probe write, then clean up) */
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.liveln-root-probe');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

// Portable first: assets + data live next to the exe. If it was copied
// somewhere read-only (e.g. Program Files), fall back to per-user app data.
export const ROOT_DIR = IS_SEA
  ? writable(path.dirname(process.execPath))
    ? path.dirname(process.execPath)
    : path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'LiveNotes')
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');