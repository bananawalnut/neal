import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(root, 'launch-config.json'), 'utf8'));
const localImage = await readFile(resolve(root, config.token.imagePath));
const localBanner = config.token.bannerPath
  ? await readFile(resolve(root, config.token.bannerPath))
  : null;
const website = String(config.token.website ?? '').replace(/\/$/u, '');
if (!website.startsWith('https://')) throw new Error('token.website must use HTTPS');

const metadataUrl = `${website}/token-metadata.json`;
const expectedImageUrl = `${website}/neal-token.png`;
const expectedMetadata = {
  name: config.token.name,
  symbol: config.token.symbol,
  description: config.token.description,
  image: expectedImageUrl,
  external_url: config.token.website,
  showName: true,
  createdOn: 'https://pump.fun',
  website: config.token.website,
  github: config.token.socialLinks.find((link) => link?.platform === 'github')?.url,
  banner: config.token.bannerUrl,
};

const bannerResponsePromise = config.token.bannerUrl ? fetch(config.token.bannerUrl) : Promise.resolve(null);
const [metadataResponse, imageResponse, bannerResponse] = await Promise.all([
  fetch(metadataUrl),
  fetch(expectedImageUrl),
  bannerResponsePromise,
]);
if (!metadataResponse.ok) throw new Error(`${metadataUrl} returned HTTP ${metadataResponse.status}`);
if (!imageResponse.ok) throw new Error(`${expectedImageUrl} returned HTTP ${imageResponse.status}`);
if (bannerResponse && !bannerResponse.ok) throw new Error(`${config.token.bannerUrl} returned HTTP ${bannerResponse.status}`);

const metadata = await metadataResponse.json();
if (typeof metadata.twitter === 'string' && metadata.twitter.trim()) {
  throw new Error('remote metadata unexpectedly includes an X/Twitter URL');
}
for (const [field, expected] of Object.entries(expectedMetadata)) {
  if (metadata[field] !== expected) throw new Error(`remote metadata ${field} does not match launch-config.json`);
}
const remoteImage = Buffer.from(await imageResponse.arrayBuffer());
const remoteBanner = bannerResponse ? Buffer.from(await bannerResponse.arrayBuffer()) : null;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const localDigest = sha256(localImage);
const remoteDigest = sha256(remoteImage);
if (localDigest !== remoteDigest) throw new Error(`remote image hash ${remoteDigest} does not match ${localDigest}`);
const localBannerDigest = localBanner ? sha256(localBanner) : null;
const remoteBannerDigest = remoteBanner ? sha256(remoteBanner) : null;
if (localBannerDigest !== remoteBannerDigest) {
  throw new Error(`remote banner hash ${remoteBannerDigest} does not match ${localBannerDigest}`);
}

console.log(JSON.stringify({
  schema: 'neal.remote-assets-verification/v1',
  verifiedAt: new Date().toISOString(),
  metadataUrl,
  imageUrl: expectedImageUrl,
  imageSha256: remoteDigest,
  bannerUrl: config.token.bannerUrl ?? null,
  bannerSha256: remoteBannerDigest,
  metadataMatches: true,
}, null, 2));
