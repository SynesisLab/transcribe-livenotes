// Flip a Windows PE's optional-header Subsystem field from console (3) to
// GUI (2). A GUI-subsystem exe launched by double-click gets no console
// window — the packaged LiveNotes.exe starts fully hidden this way.
//
// Note: this (like the postject injection before it) invalidates any
// Authenticode signature on the binary — expected and fine for a locally
// built, unsigned exe.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const SUBSYSTEMS = { 2: 'GUI', 3: 'console' };

/** Read the Subsystem field (2 = GUI, 3 = console). */
export function subsystemOf(exePath) {
  const buf = fs.readFileSync(exePath);
  const peOffset = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOffset) !== 0x00004550) throw new Error('not a PE image (missing PE signature)');
  const optionalHeader = peOffset + 24; // skip the 4-byte PE sig + 20-byte COFF header
  const magic = buf.readUInt16LE(optionalHeader);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`unexpected optional-header magic 0x${magic.toString(16)}`);
  // Subsystem sits at offset 68 in the optional header for both PE32 and PE32+
  return buf.readUInt16LE(optionalHeader + 68);
}

/** Flip console → GUI in place; returns { from, to }. */
export function flipSubsystem(exePath) {
  const buf = fs.readFileSync(exePath);
  const peOffset = buf.readUInt32LE(0x3c);
  const optionalHeader = peOffset + 24;
  const offset = optionalHeader + 68;
  const from = buf.readUInt16LE(offset);
  if (!(from in SUBSYSTEMS)) throw new Error(`unknown subsystem value ${from}`);
  if (from === 2) return { from, to: 2 }; // already GUI — nothing to do
  if (from !== 3) throw new Error(`expected console subsystem (3), found ${from}`);
  buf.writeUInt16LE(2, offset);
  fs.writeFileSync(exePath, buf);
  const check = subsystemOf(exePath);
  if (check !== 2) throw new Error(`subsystem flip did not stick (still ${check})`);
  return { from, to: check };
}

// CLI: node scripts/make-windowless.mjs <exe>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exe = process.argv[2];
  if (!exe) {
    console.error('usage: node scripts/make-windowless.mjs <exe>');
    process.exit(1);
  }
  const { from, to } = flipSubsystem(exe);
  console.log(`subsystem: ${SUBSYSTEMS[from]} (${from}) -> ${SUBSYSTEMS[to]} (${to})`);
}