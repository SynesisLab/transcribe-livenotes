// Build the double-clickable LiveNotes.exe (Windows x64) with Node's
// Single Executable Application machinery:
//
//   vite build            → dist/ (the UI)
//   esbuild bundle        → server sources + express/ws/marked into one CJS file
//   sea config + blob     → bundle + assets (dist/, bin/, models/) embedded
//   node.exe + postject   → blob injected into a copy of the node binary
//   PE subsystem flip     → console (3) → GUI (2) so double-click opens no console
//
// Output: build/LiveNotes.exe (~190 MB). Fully portable — run it anywhere
// and it extracts bin/, models/ and dist/ next to itself on first launch;
// data/ (the notes) lives there too.
//
// Requires: npm run setup done first (bin/ + models/ present), Node >= 22.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { flipSubsystem, subsystemOf } from './make-windowless.mjs';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const SEA = path.join(BUILD, 'sea');
const OUT_EXE = path.join(BUILD, 'LiveNotes.exe');

const die = (msg) => {
  console.error(`\x1b[31m[package] ✗ ${msg}\x1b[0m`);
  process.exit(1);
};
const step = (msg) => console.log(`\x1b[1m[package]\x1b[0m ${msg}`);

const walkFiles = (dir, prefix = '') =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walkFiles(path.join(dir, e.name), path.join(prefix, e.name)) : [path.join(prefix, e.name)]
    );

function main() {
  // ------------------------------------------------------------- preflight
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    die(`this script targets Windows x64 (found ${process.platform}/${process.arch})`);
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) die(`Node >= 22 required to build (embedded SEA assets); found v${process.versions.node}`);
  try {
    require_.resolve('postject/package.json');
  } catch {
    die('postject is not installed — run: npm install');
  }
  if (!fs.existsSync(path.join(ROOT, 'bin', 'whisper-server.exe')) || !fs.existsSync(path.join(ROOT, 'models'))) {
    die('bin/whisper-server.exe or models/ missing — run: npm run setup');
  }

  // --------------------------------------------------------------- UI build
  step('vite build (dist/)');
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) die('vite build did not produce dist/index.html');

  // ---------------------------------------------------------- server bundle
  fs.rmSync(SEA, { recursive: true, force: true });
  fs.mkdirSync(SEA, { recursive: true });
  step('esbuild bundle (server -> CJS)');
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'server', 'index.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(SEA, 'server.cjs'),
    external: ['bufferutil', 'utf-8-validate'], // ws's optional native deps — not installed
    logLevel: 'warning',
    legalComments: 'none',
  });

  // ---------------------------------------------------------------- assets
  step('collecting assets (dist/, bin/, models/)');
  const assets = {};
  const files = {};
  const add = (absPath, key) => {
    const size = fs.statSync(absPath).size;
    assets[key] = absPath;
    files[key] = size;
  };
  for (const rel of walkFiles(path.join(ROOT, 'dist'))) add(path.join(ROOT, 'dist', rel), `dist/${rel.replaceAll('\\', '/')}`);
  add(path.join(ROOT, 'bin', 'whisper-server.exe'), 'bin/whisper-server.exe');
  const dlls = fs
    .readdirSync(path.join(ROOT, 'bin'))
    .filter((f) => f.toLowerCase().endsWith('.dll'))
    .sort();
  if (!dlls.length) die('no DLLs found in bin/ — whisper-server.exe would not run; re-run npm run setup');
  for (const dll of dlls) add(path.join(ROOT, 'bin', dll), `bin/${dll}`);
  const models = fs
    .readdirSync(path.join(ROOT, 'models'))
    .filter((f) => f.endsWith('.bin'))
    .map((f) => ({ f, size: fs.statSync(path.join(ROOT, 'models', f)).size }))
    .filter((m) => m.size > 1024);
  if (!models.length) die('no model files found in models/ — run: npm run setup');
  for (const m of models) add(path.join(ROOT, 'models', m.f), `models/${m.f}`);
  if (!fs.existsSync(path.join(ROOT, 'server', 'tray.ps1')))
    die('server/tray.ps1 missing — the packaged build would have no tray icon');
  add(path.join(ROOT, 'server', 'tray.ps1'), 'server/tray.ps1');
  if (!fs.existsSync(path.join(ROOT, 'server', 'public', 'logs.html')))
    die('server/public/logs.html missing — the packaged build would have no log viewer');
  add(path.join(ROOT, 'server', 'public', 'logs.html'), 'server/public/logs.html');

  const manifest = { files };
  const manifestPath = path.join(SEA, '_manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assets['_manifest'] = manifestPath;
  const totalMB = Object.values(files).reduce((a, b) => a + b, 0) / 1024 / 1024;
  step(`assets: ${Object.keys(files).length} files, ${totalMB.toFixed(1)} MB`);

  // ------------------------------------------------------------ blob + exe
  fs.writeFileSync(
    path.join(SEA, 'sea-config.json'),
    JSON.stringify({ main: path.join(SEA, 'server.cjs'), output: path.join(SEA, 'sea-prep.blob'), disableExperimentalSEAWarning: true, assets }, null, 2)
  );
  step('node --experimental-sea-config (blob)');
  execSync(`"${process.execPath}" --experimental-sea-config sea-config.json`, { cwd: SEA, stdio: 'inherit' });

  step('injecting blob into node binary');
  fs.rmSync(OUT_EXE, { force: true });
  fs.copyFileSync(process.execPath, OUT_EXE); // the running node.exe is the base
  execSync(
    `npx postject "${OUT_EXE}" NODE_SEA_BLOB "${path.join(SEA, 'sea-prep.blob')}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
    { cwd: BUILD, stdio: 'inherit' }
  );

  // -------------------------------------------------------------- GUI flip
  step('flipping PE subsystem console -> GUI');
  flipSubsystem(OUT_EXE);
  if (subsystemOf(OUT_EXE) !== 2) die('subsystem verification failed');

  const sizeMB = fs.statSync(OUT_EXE).size / 1024 / 1024;
  console.log('');
  console.log(`\x1b[32m✓ build/LiveNotes.exe ready (${sizeMB.toFixed(0)} MB)\x1b[0m`);
  console.log('  Double-click it to launch: server starts hidden, browser opens automatically,');
  console.log('  and a tray icon appears under the hidden-icons chevron (^) — right-click it');
  console.log('  to reopen the app or quit.');
  console.log('  Notes live in data/ next to the exe; copy exe + data/ together to move them.');
  console.log('  Stop: right-click the tray icon → Quit (or taskkill /IM LiveNotes.exe /F).');
}

main();