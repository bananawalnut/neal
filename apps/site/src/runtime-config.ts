export type DevnetManualRuntime = {
  schema: 'neal.devnet-manual-runtime/v1';
  mode: 'isolated-devnet-manual';
  sourceCommit: string;
  generatedAt: string;
  expiresAt: string;
  chainId: 'solana:devnet';
  verification: { mode: 'quorum-2-of-3'; providerCount: 3; threshold: 2 };
  requestNonce: string;
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

export type DevnetManualReadiness = {
  schema: 'neal.devnet-manual-readiness/v1';
  status: 'ready' | 'unavailable';
  ready: boolean;
  checkedAt: string;
  sourceCommit: string | null;
  expiresAt: string | null;
  verification: {
    mode: 'quorum-2-of-3';
    providerCount: 3;
    threshold: 2;
    finalizedAgreementSlot: number | null;
  };
  checks: Record<'lease' | 'browserCommit' | 'site' | 'issuer' | 'matrix' | 'rpcQuorum' | 'walletPolicy', 'ok' | 'failed'>;
};

export type LocalSurfaceMode = 'production' | 'local-preview' | 'manual-devnet' | 'blocked';

let runtime: DevnetManualRuntime | null = null;
let readiness: DevnetManualReadiness | null = null;

const localHostname = (): boolean => ['localhost', '127.0.0.1'].includes(window.location.hostname);

const detectSurfaceMode = (): LocalSurfaceMode => {
  const port = window.location.port;
  if (['4280', '4281', '4282'].includes(port)) {
    if (port === '4280' && localHostname()) return 'manual-devnet';
    if (port === '4282' && localHostname()) return 'local-preview';
    return 'blocked';
  }
  return localHostname() ? 'local-preview' : 'production';
};

const surfaceMode = detectSurfaceMode();

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
    'requestNonce', 'browserWallet', 'programId', 'programDataAddress', 'programSha256', 'configAddress',
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
    && typeof candidate.requestNonce === 'string'
    && /^[0-9a-f]{64}$/u.test(candidate.requestNonce)
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

const READINESS_CHECKS = ['lease', 'browserCommit', 'site', 'issuer', 'matrix', 'rpcQuorum', 'walletPolicy'] as const;

const validReadiness = (value: unknown, expectedCommit: string): value is DevnetManualReadiness => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const verification = candidate.verification as Record<string, unknown> | undefined;
  const checks = candidate.checks as Record<string, unknown> | undefined;
  return exact(candidate, ['schema', 'status', 'ready', 'checkedAt', 'sourceCommit', 'expiresAt', 'verification', 'checks'])
    && candidate.schema === 'neal.devnet-manual-readiness/v1'
    && candidate.status === 'ready'
    && candidate.ready === true
    && typeof candidate.checkedAt === 'string'
    && Number.isFinite(Date.parse(candidate.checkedAt))
    && candidate.sourceCommit === expectedCommit
    && typeof candidate.expiresAt === 'string'
    && Date.parse(candidate.expiresAt) > Date.now()
    && verification !== undefined
    && exact(verification, ['mode', 'providerCount', 'threshold', 'finalizedAgreementSlot'])
    && verification.mode === 'quorum-2-of-3'
    && verification.providerCount === 3
    && verification.threshold === 2
    && Number.isSafeInteger(verification.finalizedAgreementSlot)
    && Number(verification.finalizedAgreementSlot) > 0
    && checks !== undefined
    && exact(checks, READINESS_CHECKS)
    && READINESS_CHECKS.every((name) => checks[name] === 'ok');
};

export async function loadRuntimeConfig(): Promise<void> {
  if (surfaceMode === 'blocked') {
    throw new Error('This local port and hostname combination is not an authorized NEAL surface.');
  }
  if (surfaceMode !== 'manual-devnet') return;
  if (window.location.protocol !== 'https:') {
    throw new Error('Manual acceptance requires HTTPS on localhost port 4280.');
  }
  const response = await fetch('/_neal/devnet/runtime', { cache: 'no-store' });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('The isolated devnet runtime is unavailable.');
  }
  const value: unknown = await response.json();
  if (!validRuntime(value)) throw new Error('The isolated devnet runtime failed validation.');
  const browserCommit = import.meta.env.VITE_NEAL_SOURCE_COMMIT ?? '';
  if (!/^[0-9a-f]{40}$/u.test(browserCommit) || browserCommit !== value.sourceCommit) {
    throw new Error('The browser build does not match the prepared devnet runtime.');
  }
  const readyResponse = await fetch('/_neal/devnet/ready', { cache: 'no-store' });
  const readyValue: unknown = readyResponse.headers.get('content-type')?.includes('application/json')
    ? await readyResponse.json()
    : null;
  if (!readyResponse.ok || !validReadiness(readyValue, value.sourceCommit)) {
    throw new Error('The isolated devnet dependencies are not ready.');
  }
  runtime = value;
  readiness = readyValue;
};

export const getRuntimeConfig = (): DevnetManualRuntime | null => runtime;
export const getRuntimeReadiness = (): DevnetManualReadiness | null => readiness;
export const getLocalSurfaceMode = (): LocalSurfaceMode => surfaceMode;

export const manualRequestHeaders = (): Record<string, string> => (
  runtime ? { 'X-Neal-Request-Nonce': runtime.requestNonce } : {}
);

export async function refreshRuntimeReadiness(): Promise<DevnetManualReadiness | null> {
  if (surfaceMode !== 'manual-devnet' || !runtime) return null;
  const response = await fetch('/_neal/devnet/ready', { cache: 'no-store' });
  const value: unknown = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : null;
  if (!response.ok || !validReadiness(value, runtime.sourceCommit)) {
    throw new Error('The isolated devnet dependencies are not ready. No transaction was constructed.');
  }
  readiness = value;
  return value;
}
