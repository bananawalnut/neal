import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BROWSER_BUNDLE_SCHEMA = 'neal.devnet-browser-bundle/v1';
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...keys].sort().join();

const safeRelativePath = (value) => {
  if (
    typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || path.posix.isAbsolute(value) || value.split('/').some((part) => !part || part === '.' || part === '..')
  ) throw new Error('Browser bundle contains an unsafe path');
  return value;
};

export const validateManualBrowserBundle = async (bundleFile, expectedCommit, expectedLockFile = path.join(ROOT, 'package-lock.json')) => {
  const absolute = path.resolve(bundleFile);
  const metadata = await fs.lstat(absolute).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_BUNDLE_BYTES) {
    throw new Error('Manual browser bundle is unavailable or unsafe');
  }
  const value = JSON.parse(await fs.readFile(absolute, 'utf8'));
  if (!exact(value, ['schema', 'sourceCommit', 'toolchain', 'packageLockSha256', 'files'])) {
    throw new Error('Manual browser bundle contract is invalid');
  }
  if (value.schema !== BROWSER_BUNDLE_SCHEMA || value.sourceCommit !== expectedCommit) {
    throw new Error('Manual browser bundle does not bind the exact source commit');
  }
  if (!exact(value.toolchain, ['nodeVersion', 'platform', 'architecture'])
    || !/^v24\.[0-9]+\.[0-9]+$/u.test(value.toolchain.nodeVersion)
    || value.toolchain.platform !== 'linux' || value.toolchain.architecture !== 'x64') {
    throw new Error('Manual browser bundle toolchain is unsupported');
  }
  const expectedLockSha256 = sha256(await fs.readFile(expectedLockFile));
  if (value.packageLockSha256 !== expectedLockSha256) {
    throw new Error('Manual browser bundle package lock does not match the exact checkout');
  }
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 10_000) {
    throw new Error('Manual browser bundle file list is invalid');
  }
  const seen = new Set();
  for (const file of value.files) {
    if (!exact(file, ['path', 'mode', 'size', 'sha256', 'dataBase64'])) {
      throw new Error('Manual browser bundle file contract is invalid');
    }
    const relative = safeRelativePath(file.path);
    if (seen.has(relative)) throw new Error('Manual browser bundle contains a duplicate path');
    seen.add(relative);
    if (![0o644, 0o755].includes(file.mode) || !Number.isSafeInteger(file.size) || file.size < 0
      || !/^[0-9a-f]{64}$/u.test(file.sha256) || typeof file.dataBase64 !== 'string') {
      throw new Error('Manual browser bundle file metadata is invalid');
    }
    const data = Buffer.from(file.dataBase64, 'base64');
    if (data.toString('base64') !== file.dataBase64 || data.length !== file.size || sha256(data) !== file.sha256) {
      throw new Error('Manual browser bundle file hash is invalid');
    }
  }
  const marker = value.files.find((file) => file.path === '_neal-build.json');
  if (!marker) throw new Error('Manual browser bundle is missing its commit marker');
  const markerValue = JSON.parse(Buffer.from(marker.dataBase64, 'base64').toString('utf8'));
  if (!exact(markerValue, ['schema', 'sourceCommit'])
    || markerValue.schema !== 'neal.devnet-browser-build/v1' || markerValue.sourceCommit !== expectedCommit) {
    throw new Error('Manual browser bundle commit marker is invalid');
  }
  return { value, file: absolute, sha256: sha256(await fs.readFile(absolute)) };
};

export const createManualBrowserBundle = async ({ dist, output, sourceCommit }) => {
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error('A full source commit is required');
  if (process.platform !== 'linux' || process.arch !== 'x64' || !/^v24\./u.test(process.version)) {
    throw new Error('Manual browser bundles must be created with Node 24 on Linux x86-64');
  }
  const root = path.resolve(dist);
  await fs.writeFile(path.join(root, '_neal-build.json'), `${JSON.stringify({
    schema: 'neal.devnet-browser-build/v1', sourceCommit,
  })}\n`, { mode: 0o644 });
  const files = [];
  const visit = async (directory) => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const metadata = await fs.lstat(absolute);
        if (metadata.isSymbolicLink()) throw new Error('Browser dist may not contain symlinks');
        const data = await fs.readFile(absolute);
        files.push({
          path: path.relative(root, absolute).split(path.sep).join('/'),
          mode: metadata.mode & 0o111 ? 0o755 : 0o644,
          size: data.length,
          sha256: sha256(data),
          dataBase64: data.toString('base64'),
        });
      } else throw new Error('Browser dist contains an unsupported entry');
    }
  };
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const bundle = {
    schema: BROWSER_BUNDLE_SCHEMA,
    sourceCommit,
    toolchain: { nodeVersion: process.version, platform: process.platform, architecture: process.arch },
    packageLockSha256: sha256(await fs.readFile(path.join(ROOT, 'package-lock.json'))),
    files,
  };
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(path.resolve(output), `${JSON.stringify(bundle)}\n`, { mode: 0o644 });
  return validateManualBrowserBundle(output, sourceCommit);
};

export const extractManualBrowserBundle = async (validated, destination) => {
  const target = path.resolve(destination);
  await fs.mkdir(target, { mode: 0o700 });
  for (const file of validated.value.files) {
    const relative = safeRelativePath(file.path);
    const absolute = path.resolve(target, ...relative.split('/'));
    if (!absolute.startsWith(`${target}${path.sep}`)) throw new Error('Browser bundle path escaped its destination');
    await fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
    await fs.writeFile(absolute, Buffer.from(file.dataBase64, 'base64'), { mode: file.mode, flag: 'wx' });
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    if (!name?.startsWith('--') || !process.argv[index + 1]) throw new Error('Expected --name value arguments');
    options[name.slice(2)] = process.argv[index + 1];
  }
  const result = await createManualBrowserBundle({
    dist: options.dist,
    output: options.output,
    sourceCommit: options.commit,
  });
  console.log(JSON.stringify({ schema: BROWSER_BUNDLE_SCHEMA, sourceCommit: result.value.sourceCommit, sha256: result.sha256 }));
}
