import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsDirectory, '..');
const sourcePath = resolve(projectRoot, 'launch-config.json');
const destinationPath = resolve(projectRoot, 'apps/site/public/launch-record.json');
const yahooLeaderboardPath = resolve(projectRoot, 'apps/site/public/yahoo-leaderboard.json');
const tokenMetadataPath = resolve(projectRoot, 'apps/site/public/token-metadata.json');
const bountyContractSourcePath = resolve(projectRoot, 'programs/bounty-factory/CONTRACT.md');
const bountyTestingSourcePath = resolve(projectRoot, 'programs/bounty-factory/TESTING.md');
const bountyContractPath = resolve(projectRoot, 'apps/site/public/bounty-contract.txt');
const bountyTestingPath = resolve(projectRoot, 'apps/site/public/bounty-testing.txt');

const source = JSON.parse(await readFile(sourcePath, 'utf8'));
const [bountyContract, bountyTesting] = await Promise.all([
  readFile(bountyContractSourcePath, 'utf8'),
  readFile(bountyTestingSourcePath, 'utf8'),
]);
const mintAddress = source.execution?.mintAddress ?? null;
const creationTransaction = source.execution?.creationTransaction ?? null;

if (Boolean(mintAddress) !== Boolean(creationTransaction)) {
  throw new Error('mintAddress and creationTransaction must be populated together');
}

const launched = Boolean(mintAddress && creationTransaction);
const publicRecord = {
  schema: 'neal.public-record/v1',
  sourceSchema: source.schema,
  status: launched ? 'launched' : 'pre_launch',
  token: {
    name: source.token.name,
    symbol: source.token.symbol,
    metadataUri: source.token.metadataUri ?? null,
    bannerUrl: source.token.bannerUrl ?? null,
    description: source.token.description,
    website: source.token.website,
    socialLinks: source.token.socialLinks,
  },
  launch: {
    network: source.network,
    canonicalRoute: source.canonicalRoute,
    quoteAsset: source.pumpfun.quoteAsset,
    mayhemMode: source.pumpfun.mayhemMode,
  },
  execution: {
    mintAddress,
    creationTransaction,
  },
  programs: {
    genesisAllocationAvailable: source.programs.genesisAllocationAvailable,
    economics: source.programs.economics,
    communitySuggestions: source.programs.communitySuggestions ?? null,
    yahoos: source.programs.yahoos ?? null,
    fundingMethod: source.programs.fundingMethod,
    fundedInventory: source.programs.fundedInventory,
  },
  secondaryLiquidity: {
    enabledAtLaunch: source.secondaryLiquidity.enabledAtLaunch,
    plannedQuoteSymbol: source.secondaryLiquidity.plannedQuoteSymbol,
    quoteMint: source.secondaryLiquidity.quoteMint,
    status: source.secondaryLiquidity.status,
  },
};

const yahooLeaderboardRecord = {
  schema: 'neal.yahoo-leaderboard/v1',
  mode: source.programs.yahoos?.localMode?.enabled ? 'local_free' : 'on_chain',
  scope: source.programs.yahoos?.localMode?.rankingScope ?? 'global',
  futureOnChainPolicyStatus: source.programs.yahoos?.futureOnChainPolicyStatus ?? null,
  status: source.programs.yahoos?.localMode?.enabled ? 'active' : (source.programs.yahoos?.status ?? 'unavailable'),
  programId: source.programs.yahoos?.programId ?? null,
  asOfSlot: null,
  fastestConsecutiveCount: source.programs.yahoos?.fastestConsecutiveCount ?? 3,
  peakRateWindowSeconds: source.programs.yahoos?.peakRateWindowSeconds ?? 60,
  totalYahoos: [],
  fastestConsecutiveYahoos: [],
  peakYahooRate: [],
};

const website = String(source.token.website ?? '').replace(/\/$/u, '');
const imageUrl = `${website}/neal-token.png`;
const socialLink = (platform) => source.token.socialLinks
  .find((link) => link && typeof link === 'object' && link.platform === platform)?.url;
const tokenMetadata = {
  name: source.token.name,
  symbol: source.token.symbol,
  description: source.token.description,
  image: imageUrl,
  external_url: source.token.website,
  showName: true,
  createdOn: 'https://pump.fun',
  website: source.token.website,
  ...(socialLink('github') ? { github: socialLink('github') } : {}),
  ...(source.token.bannerUrl ? { banner: source.token.bannerUrl } : {}),
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

await Promise.all([
  writeFile(destinationPath, `${JSON.stringify(publicRecord, null, 2)}\n`, 'utf8'),
  writeFile(yahooLeaderboardPath, `${JSON.stringify(yahooLeaderboardRecord, null, 2)}\n`, 'utf8'),
  writeFile(tokenMetadataPath, `${JSON.stringify(tokenMetadata, null, 2)}\n`, 'utf8'),
  writeFile(bountyContractPath, bountyContract, 'utf8'),
  writeFile(bountyTestingPath, bountyTesting, 'utf8'),
]);
