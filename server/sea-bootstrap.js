// Packaged-build bootstrap. A no-op outside a Node single-executable build
// (plain `node server/index.js` runs exactly as before); when the code runs
// from LiveNotes.exe it:
//
//   1. tees console output into data/log.txt (a GUI-subsystem exe has no
//      console — the /logs page shows it live; runs in dev too)
//   2. reaps whisper-server.exe processes orphaned by a previous Task-Manager
//      kill of the exe (they hold the model in RAM and lock their files,
//      which would also block asset re-extraction)
//   3. extracts the embedded dist/, bin/ and models/ assets to disk next to
//      the exe — whisper-server.exe and its DLLs must be real files
//   4. provides the launch flow helpers: single-instance probe, browser
//      open, tray icon (right-click → Open / Show Logs / Quit)
//
// This module is imported FIRST by index.js so its module body (extraction)
// finishes before store.js initializes the data directory.
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { IS_SEA, ROOT_DIR } from './paths.js';

// Base the require on the executable path rather than import.meta.url: the
// CJS bundle esbuild produces for the packaged exe has no import.meta.
const require_ = createRequire(process.execPath);
let sea = null;
try {
  sea = require_('node:sea');
} catch {
  /* pre-20.12 Node — dev checkout */
}

const STAMP_FILE = path.join(ROOT_DIR, '.liveln-assets');
export const LOG_FILE = path.join(ROOT_DIR, 'data', 'log.txt');
const MAX_LOG_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// 1. Logging — a GUI-subsystem exe has no stdout, so everything goes to a
// tail-capped file (shown live by the /logs page). Runs in the dev checkout
// too, so /logs works there as well; data/ is gitignored.
function setupLogging() {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size > MAX_LOG_BYTES) {
        fs.writeFileSync(LOG_FILE, fs.readFileSync(LOG_FILE).subarray(-MAX_LOG_BYTES / 2));
      }
    } catch {
      /* no log yet */
    }
    const stamp = () => new Date().toTimeString().slice(0, 8);
    for (const name of ['log', 'warn', 'error', 'info']) {
      const orig = console[name].bind(console);
      console[name] = (...args) => {
        try {
          fs.appendFileSync(LOG_FILE, `[${stamp()}] ${util.format(...args)}\n`);
        } catch {
          /* read-only volume etc. — console still gets the line */
        }
        try {
          orig(...args);
        } catch {
          /* no console handle in a windowed exe */
        }
      };
    }
    process.on('uncaughtException', (e) => {
      console.error(`uncaught exception: ${e.stack || e}`);
      process.exit(1);
    });
    process.on('unhandledRejection', (e) => {
      console.error(`unhandled rejection: ${e?.stack || e}`);
    });
  } catch {
    /* never let logging setup break the app */
  }
}

// ---------------------------------------------------------------------------
// 2. Orphan reaping. Fast path asks tasklist (~0.1 s); only when a stale
// whisper-server.exe actually exists do we pay for the PowerShell CIM query.
const alive = (pid) => {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
};

function cleanupWhisperOrphans() {
  let listed;
  try {
    listed = execSync('tasklist /FI "IMAGENAME eq whisper-server.exe" /FO CSV /NH', {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch {
    return; // no matches (or tasklist unavailable) — nothing to reap
  }
  if (!listed.includes('whisper-server.exe')) return;
  try {
    const csv = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='whisper-server.exe'\\" | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation"`,
      { encoding: 'utf8', windowsHide: true }
    );
    for (const m of csv.matchAll(/"(\d+)","(\d+)"/g)) {
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      if (alive(ppid)) continue; // parent still exists (maybe another instance) — hands off
      console.log(`reaping orphaned whisper-server.exe (pid ${pid})`);
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
  } catch (e) {
    console.warn(`orphan sweep failed (continuing): ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Asset extraction — keys are the files' paths relative to the root.
function extractAssets() {
  if (!sea || typeof sea.getRawAsset !== 'function') return;
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(sea.getRawAsset('_manifest')));
  } catch {
    console.warn('no embedded asset manifest — packaged build is missing its assets');
    return;
  }
  const stamp = JSON.stringify(manifest);
  let fresh = false;
  try {
    fresh = fs.readFileSync(STAMP_FILE, 'utf8') === stamp;
  } catch {
    /* first run */
  }
  if (fresh) {
    // stamp matches, but a user-deleted file still forces a re-extract
    fresh = Object.keys(manifest.files).every((key) => fs.existsSync(path.join(ROOT_DIR, ...key.split('/'))));
  }
  if (fresh) return;

  console.log(`extracting ${Object.keys(manifest.files).length} embedded assets to ${ROOT_DIR} ...`);
  const failed = [];
  for (const key of Object.keys(manifest.files)) {
    const dest = path.join(ROOT_DIR, ...key.split('/'));
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(sea.getRawAsset(key)));
    } catch (e) {
      failed.push(`${key}: ${e.message}`);
    }
  }
  if (failed.length) {
    for (const line of failed) console.error(`asset extract failed: ${line}`);
    console.error('some assets could not be extracted (file locked? disk full?) — will retry next launch');
    return; // no stamp update: the next boot retries
  }
  fs.writeFileSync(STAMP_FILE, stamp);
  console.log('assets ready');
}

// ---------------------------------------------------------------------------
setupLogging(); // always — /logs needs the file in the dev checkout too
if (IS_SEA && sea) {
  cleanupWhisperOrphans();
  extractAssets();
}

// ---------------------------------------------------------------------------
// 4. Launch flow (inert outside a packaged build)
/** True when a Live Notes server is already serving this port. */
export async function seaAlreadyRunning(port) {
  if (!IS_SEA) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return (await res.json())?.ok === true;
  } catch {
    return false;
  }
}

/** Open the default browser at the app (double-click behavior). */
export function seaOpenBrowser(port) {
  if (!IS_SEA || process.env.LIVELN_NO_BROWSER) return;
  try {
    spawn('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${port}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } catch {
    /* no default browser — the app is still reachable at the URL */
  }
}

// ---------------------------------------------------------------------------
// 5. Tray icon (packaged build only). node can't own a notification-area
// icon, so the exe runs a tiny PowerShell helper (server/tray.ps1, embedded
// as an asset) that shows one: right-click → Open / Show Logs / Quit,
// left-click → open. Show Logs opens the /logs page in the browser; Quit
// POSTs /api/quit for a clean stop; the helper also dies on its own when
// this process does (crash, Task-Manager kill), so the icon never outlives
// the app.
export function startTray(port) {
  if (!IS_SEA || process.env.LIVELN_NO_TRAY) return;
  const script = path.join(ROOT_DIR, 'server', 'tray.ps1');
  if (!fs.existsSync(script)) {
    console.warn('server/tray.ps1 missing — no tray icon (stop via taskkill /IM LiveNotes.exe /F)');
    return;
  }
  try {
    // No detached:true — powershell.exe exits immediately under
    // DETACHED_PROCESS. stdio 'ignore' + unref already keep it fire-and-forget,
    // and a task-killed exe leaves the helper to notice its parent is gone
    // and exit on its own (it polls the PID).
    spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-Port',
        String(port),
        '-ParentPid',
        String(process.pid),
        '-ProcessName',
        path.basename(process.execPath),
      ],
      { stdio: 'ignore', windowsHide: true }
    ).unref();
    console.log('tray icon running (right-click it to open or quit)');
  } catch (e) {
    console.warn(`tray icon unavailable (continuing): ${e.message}`);
  }
}