import { cpSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const libs = resolve(root, 'node_modules/three/examples/jsm/libs');

const copies = [
  [resolve(libs, 'draco'), resolve(root, 'public/draco')],
  [resolve(libs, 'basis'), resolve(root, 'public/basis')],
];

for (const [src, dest] of copies) {
  try {
    if (!existsSync(src)) {
      console.warn(`copy-decoders: source not found, skipping: ${src}`);
      continue;
    }
    cpSync(src, dest, { recursive: true, force: true });
  } catch (err) {
    console.warn(`copy-decoders: failed to copy ${src}: ${err.message}`);
  }
}
