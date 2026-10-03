export type DevnetManualRuntime = {
  schema: 'neal.devnet-manual-runtime/v1';
  mode: 'isolated-devnet-manual';
  sourceCommit: string;
  generatedAt: string;
  expiresAt: string;
  chainId: 'solana:devnet';
  verification: { mode: 'quorum-2-of-3'; providerCount: 3; threshold: 2 };
  browserWallet: string;
  programId: string;
  programDataAddress: string;
  programSha256: string;
  configAddress: string;
  configRevision: string;
  issuerAuthority: string;
  mint: string;
  terms: {
    requiredAtomicAmount: '69000000000';
    minimumLockSeconds: 120;
    tokenDecimals: 6;
    mintedAtomicAmount: '69001000000';
  };
  matrix: {
    serverName: 'rehearsal.neal.invalid';
    baseUrl: 'https://localhost:4280';
    roomId: string;
    roomAlias: '#neal-gc:rehearsal.neal.invalid';
    viaServers: ['rehearsal.neal.invalid'];
  };
};

let runtime: DevnetManualRuntime | null = null;

const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).sort().join() === [...keys].sort().join();
};

const publicKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(value);

const validRuntime = (value: unknown): value is DevnetManualRuntime => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!exact(candidate, [
    'schema', 'mode', 'sourceCommit', 'generatedAt', 'expiresAt', 'chainId', 'verification',
    'browserWallet', 'programId', 'programDataAddress', 'programSha256', 'configAddress',
    'configRevision', 'issuerAuthority', 'mint', 'terms', 'matrix',
  ])) return false;
  const verification = candidate.verification as Record<string, unknown> | undefined;
  const terms = candidate.terms as Record<string, unknown> | undefined;
  const matrix = candidate.matrix as Record<string, unknown> | undefined;
  const generatedAt = typeof candidate.generatedAt === 'string' ? Date.parse(candidate.generatedAt) : Number.NaN;
  const expiresAt = typeof candidate.expiresAt === 'string' ? Date.parse(candidate.expiresAt) : Number.NaN;
  return candidate.schema === 'neal.devnet-manual-runtime/v1'
    && candidate.mode === 'isolated-devnet-manual'
    && candidate.chainId === 'solana:devnet'
    && typeof candidate.sourceCommit === 'string'
    && /^[0-9a-f]{40}$/u.test(candidate.sourceCommit)
    && typeof candidate.generatedAt === 'string'
    && Number.isFinite(generatedAt)
    && typeof candidate.expiresAt === 'string'
    && expiresAt > Date.now()
    && expiresAt > generatedAt
    && expiresAt - generatedAt <= 4 * 60 * 60 * 1000
    && publicKey(candidate.browserWallet)
    && publicKey(candidate.programId)
    && publicKey(candidate.programDataAddress)
    && typeof candidate.programSha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(candidate.programSha256)
    && publicKey(candidate.configAddress)
    && typeof candidate.configRevision === 'string'
    && /^(0|[1-9][0-9]*)$/u.test(candidate.configRevision)
    && publicKey(candidate.issuerAuthority)
    && publicKey(candidate.mint)
    && verification !== undefined
    && exact(verification, ['mode', 'providerCount', 'threshold'])
    && verification.mode === 'quorum-2-of-3'
    && verification.providerCount === 3
    && verification.threshold === 2
    && terms !== undefined
    && exact(terms, ['requiredAtomicAmount', 'minimumLockSeconds', 'tokenDecimals', 'mintedAtomicAmount'])
    && terms.requiredAtomicAmount === '69000000000'
    && terms.minimumLockSeconds === 120
    && terms.tokenDecimals === 6
    && terms.mintedAtomicAmount === '69001000000'
    && matrix !== undefined
    && exact(matrix, ['serverName', 'baseUrl', 'roomId', 'roomAlias', 'viaServers'])
    && matrix.serverName === 'rehearsal.neal.invalid'
    && matrix.baseUrl === 'https://localhost:4280'
    && typeof matrix.roomId === 'string'
    && matrix.roomId.endsWith(':rehearsal.neal.invalid')
    && matrix.roomAlias === '#neal-gc:rehearsal.neal.invalid'
    && Array.isArray(matrix.viaServers)
    && matrix.viaServers.length === 1
    && matrix.viaServers[0] === 'rehearsal.neal.invalid';
};

export async function loadRuntimeConfig(): Promise<void> {
  if (window.location.protocol !== 'https:' || !['localhost', '127.0.0.1'].includes(window.location.hostname)) return;
  const response = await fetch('/_neal/devnet/runtime', { cache: 'no-store' });
  if (response.status === 404 || !response.headers.get('content-type')?.includes('application/json')) return;
  if (!response.ok) throw new Error('The isolated devnet runtime is unavailable.');
  const value: unknown = await response.json();
  if (!validRuntime(value)) throw new Error('The isolated devnet runtime failed validation.');
  runtime = value;
};

export const getRuntimeConfig = (): DevnetManualRuntime | null => runtime;
