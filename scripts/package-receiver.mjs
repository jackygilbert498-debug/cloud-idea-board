/** Deterministic, dependency-free ZIP with an explicit secret-free source allowlist. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowlist = ['receiver.py', 'receiver_core.py', 'codex_executor.py', 'codex_policy.py', 'receiver_install.py', 'test_receiver.py', 'README.md'];
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output')) {
  throw new Error('Usage: node scripts/package-receiver.mjs [--output ABSOLUTE_ZIP_PATH]');
}
const output = args.length ? path.resolve(args[1]) : path.join(root, 'runner', 'dist', 'codex-receiver.zip');
if (!output.endsWith('.zip')) throw new Error('Package output must end in .zip');
if (allowlist.some((name) => output === path.join(root, 'runner', name))) throw new Error('Output cannot replace a source file');

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const entries = [];
const locals = [];
const centrals = [];
let offset = 0;
// ZIP's fixed DOS timestamp makes a repeated build from identical sources byte-identical.
const dosDate = ((2026 - 1980) << 9) | (10 << 5) | 25;
for (const source of allowlist) {
  const name = source === 'README.md' ? 'codex-receiver/README.md' : `codex-receiver/runner/${source}`;
  const filename = Buffer.from(name, 'utf8');
  const data = await readFile(path.join(root, 'runner', source));
  const crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(filename.length, 26);
  locals.push(header, filename, data);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, filename);
  offset += header.length + filename.length + data.length;
  entries.push({ name, bytes: data.length });
}
const centralSize = centrals.reduce((total, value) => total + value.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...locals, ...centrals, end]);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, archive);
console.log(JSON.stringify({ output, bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex'), entries }, null, 2));
