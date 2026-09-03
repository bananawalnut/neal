import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDirectory = resolve(root, 'apps/launcher/public');

await mkdir(publicDirectory, { recursive: true });
const configPath = resolve(root, 'launch-config.json');
const imagePath = resolve(root, 'assets/final/neal-token.png');
const [configBytes, imageBytes] = await Promise.all([readFile(configPath), readFile(imagePath)]);
const config = JSON.parse(configBytes.toString('utf8'));
const website = String(config.token.website ?? '').replace(/\/$/u, '');
const imageUrl = `${website}/neal-token.png`;
const metadataUri = config.token.metadataUri ?? `${website}/token-metadata.json`;
const socialLink = (platform) => config.token.socialLinks
  .find((link) => link && typeof link === 'object' && link.platform === platform)?.url;
const metadata = {
  name: config.token.name,
  symbol: config.token.symbol,
  description: config.token.description,
  image: imageUrl,
  external_url: config.token.website,
  showName: true,
  createdOn: 'https://pump.fun',
  website: config.token.website,
  ...(socialLink('github') ? { github: socialLink('github') } : {}),
  ...(config.token.bannerUrl ? { banner: config.token.bannerUrl } : {}),
  attributes: [
    { trait_type: 'Origin', value: 'Tasmania' },
    { trait_type: 'Launch', value: 'Pump.fun on Solana' },
    { trait_type: 'Mayhem', value: 'Off' },
  ],
  properties: {
    category: 'image',
    files: [{ uri: imageUrl, type: 'image/png' }],
  },
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bannerBytes = config.token.bannerPath
  ? await readFile(resolve(root, config.token.bannerPath))
  : null;

const syncTasks = [
  copyFile(configPath, resolve(publicDirectory, 'launch-config.json')),
  copyFile(imagePath, resolve(publicDirectory, 'neal-token.png')),
  writeFile(resolve(publicDirectory, 'token-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8'),
  writeFile(
    resolve(publicDirectory, 'asset-manifest.json'),
    `${JSON.stringify({
      schema: 'neal.launch-assets/v1',
      generatedAt: new Date().toISOString(),
      metadataUri,
      image: { path: config.token.imagePath, sha256: sha256(imageBytes), bytes: imageBytes.length },
      banner: bannerBytes
        ? { path: config.token.bannerPath, url: config.token.bannerUrl, sha256: sha256(bannerBytes), bytes: bannerBytes.length }
        : null,
      launchConfig: { sha256: sha256(configBytes), bytes: configBytes.length },
    }, null, 2)}\n`,
    'utf8',
  ),
];
if (bannerBytes) {
  syncTasks.push(copyFile(resolve(root, config.token.bannerPath), resolve(publicDirectory, 'neal-banner.jpg')));
}
await Promise.all(syncTasks);
