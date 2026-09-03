import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const purchaseSol = process.argv[2];
const launchAtInput = process.argv[3];
if (!purchaseSol || !launchAtInput) {
  throw new Error('usage: npm run launcher:stage -- <maximum-purchase-sol> <launch-time-iso>');
}

const match = /^(0|[1-9]\d*)(?:\.(\d{1,9}))?$/u.exec(purchaseSol);
if (!match) throw new Error('maximum-purchase-sol must be a non-negative decimal with at most 9 places');
const whole = match[1];
const fraction = match[2] ?? '';
const lamports = `${whole}${fraction.padEnd(9, '0')}`.replace(/^0+(?=\d)/u, '');
BigInt(lamports);

const launchAt = new Date(launchAtInput);
if (Number.isNaN(launchAt.valueOf())) throw new Error('launch-time-iso must be a valid date/time');
if (launchAt.valueOf() <= Date.now()) throw new Error('launch time must be in the future');

const configPath = resolve(root, 'launch-config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const website = String(config.token.website ?? '').replace(/\/$/u, '');
if (!website.startsWith('https://')) throw new Error('token website must use HTTPS');
config.token.metadataUri = `${website}/token-metadata.json`;
config.pumpfun.initialCreatorPurchaseLamports = lamports;
config.pumpfun.initialCreatorPurchaseSol = null;
config.pumpfun.launchAt = launchAt.toISOString();
config.status = 'assets_frozen';

const temporaryPath = `${configPath}.staged`;
await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
await rename(temporaryPath, configPath);
console.log(JSON.stringify({ staged: true, metadataUri: config.token.metadataUri, maximumPurchaseLamports: lamports, maximumPurchaseSol: purchaseSol, launchAt: config.pumpfun.launchAt }, null, 2));
