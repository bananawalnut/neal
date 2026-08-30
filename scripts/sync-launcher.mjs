import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDirectory = resolve(root, 'apps/launcher/public');

await mkdir(publicDirectory, { recursive: true });
await copyFile(resolve(root, 'launch-config.json'), resolve(publicDirectory, 'launch-config.json'));
await copyFile(resolve(root, 'assets/final/neal-token.png'), resolve(publicDirectory, 'neal-token.png'));

