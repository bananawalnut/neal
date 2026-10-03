import fs from 'node:fs/promises';
import path from 'node:path';

import { DEVNET_GENESIS } from './access-stake-contracts.mjs';

export const RPC_SET_SCHEMA = 'neal.solana-rpc-set/v1';
export const RPC_QUORUM_MODE = 'quorum-2-of-3';
export const RPC_TIMEOUT_MS = 5_000;
export const RPC_RESPONSE_LIMIT = 1024 * 1024;

const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const extras = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (extras.length || missing.length) throw new Error(`${label} has unsupported fields`);
};

const normalizedHost = (url, label) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} must be an HTTPS URL`);
  }
  if (
    parsed.protocol !== 'https:'
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.hash
  ) throw new Error(`${label} must be a credential-safe HTTPS URL`);
  return parsed.hostname.toLowerCase().replace(/\.$/u, '');
};

const registrableDomain = (host) => {
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((label) => !label)) throw new Error('RPC host must be globally qualified');
  return labels.slice(-2).join('.');
};

const REQUIRED_DEVNET_PROVIDERS = [
  { name: 'Helius', id: /^helius(?:-|$)/u, trustDomain: 'helius.xyz', host: /(?:^|\.)helius-rpc\.com$/u },
  { name: 'QuickNode', id: /^quicknode(?:-|$)/u, trustDomain: 'quicknode.com', host: /(?:^|\.)quiknode\.pro$/u },
  { name: 'Alchemy', id: /^alchemy(?:-|$)/u, trustDomain: 'alchemy.com', host: /(?:^|\.)alchemy\.com$/u },
];

export function validateRpcSetCredential(value) {
  exactKeys(value, ['schema', 'mode', 'threshold', 'endpoints'], 'RPC set');
  if (value.schema !== RPC_SET_SCHEMA) throw new Error('RPC set schema is unsupported');
  if (value.mode !== RPC_QUORUM_MODE || value.threshold !== 2) {
    throw new Error('Manual and formal devnet execution requires strict 2-of-3 quorum');
  }
  if (!Array.isArray(value.endpoints) || value.endpoints.length !== 3) {
    throw new Error('RPC quorum requires exactly three endpoints');
  }
  const endpoints = value.endpoints.map((endpoint, index) => {
    exactKeys(endpoint, ['id', 'trustDomain', 'url'], `RPC endpoint ${index + 1}`);
    if (typeof endpoint.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(endpoint.id)) {
      throw new Error('RPC endpoint ID is invalid');
    }
    if (typeof endpoint.trustDomain !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,126}$/u.test(endpoint.trustDomain)) {
      throw new Error('RPC trust domain is invalid');
    }
    if (typeof endpoint.url !== 'string' || endpoint.url.length > 4096) throw new Error('RPC endpoint URL is invalid');
    const host = normalizedHost(endpoint.url, `RPC endpoint ${endpoint.id}`);
    return { ...endpoint, host, registrableDomain: registrableDomain(host) };
  });
  for (const [label, values] of [
    ['IDs', endpoints.map((endpoint) => endpoint.id)],
    ['hosts', endpoints.map((endpoint) => endpoint.host)],
    ['registrable domains', endpoints.map((endpoint) => endpoint.registrableDomain)],
    ['trust domains', endpoints.map((endpoint) => endpoint.trustDomain)],
  ]) {
    if (new Set(values).size !== 3) throw new Error(`RPC provider ${label} must be distinct`);
  }
  for (const provider of REQUIRED_DEVNET_PROVIDERS) {
    const matches = endpoints.filter((endpoint) => (
      provider.id.test(endpoint.id)
      && endpoint.trustDomain === provider.trustDomain
      && provider.host.test(endpoint.host)
    ));
    if (matches.length !== 1) {
      throw new Error(`RPC set must contain exactly one recognized ${provider.name} devnet endpoint`);
    }
  }
  return { schema: value.schema, mode: value.mode, threshold: value.threshold, endpoints };
}

export async function loadRpcSetCredential(file, { requirePrivateMode = true } = {}) {
  const absolute = path.resolve(file);
  const metadata = await fs.lstat(absolute).catch(() => null);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 64 * 1024) {
    throw new Error('RPC set credential is unavailable or unsafe');
  }
  if (requirePrivateMode && (metadata.mode & 0o077) !== 0) throw new Error('RPC set credential must use mode 0600');
  let value;
  try {
    value = JSON.parse(await fs.readFile(absolute, 'utf8'));
  } catch {
    throw new Error('RPC set credential contains invalid JSON');
  }
  return { file: absolute, ...validateRpcSetCredential(value) };
}

const cappedJson = async (response, controller) => {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > RPC_RESPONSE_LIMIT) {
    controller.abort();
    throw new Error('RPC response exceeds one MiB');
  }
  if (!response.body) throw new Error('RPC returned no response body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RPC_RESPONSE_LIMIT) {
      controller.abort();
      throw new Error('RPC response exceeds one MiB');
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('RPC returned malformed JSON');
  }
};

export async function rpcCall(endpoint, method, params = [], timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    if (response.redirected) throw new Error('RPC redirects are forbidden');
    if (!response.ok) throw new Error('RPC returned a non-success status');
    const payload = await cappedJson(response, controller);
    if (!payload || payload.jsonrpc !== '2.0' || payload.error || !('result' in payload)) {
      throw new Error('RPC returned an invalid JSON-RPC envelope');
    }
    return payload.result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('RPC request timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const settled = async (endpoints, operation) => Promise.all(endpoints.map(async (endpoint) => {
  try {
    return { endpoint, value: await operation(endpoint) };
  } catch {
    return { endpoint, value: null };
  }
}));

export async function establishDevnetAgreement(rpcSet) {
  const genesisResults = await settled(rpcSet.endpoints, (endpoint) => rpcCall(endpoint, 'getGenesisHash'));
  const canonical = genesisResults.filter((entry) => entry.value === DEVNET_GENESIS).map((entry) => entry.endpoint);
  if (canonical.length < rpcSet.threshold) throw new Error('Independent RPC devnet genesis agreement failed');
  const slotResults = await settled(canonical, (endpoint) => rpcCall(endpoint, 'getSlot', [{ commitment: 'finalized' }]));
  const healthy = slotResults.filter((entry) => Number.isSafeInteger(entry.value) && entry.value > 0);
  if (healthy.length < rpcSet.threshold) throw new Error('Independent RPC finalized-slot agreement failed');
  const baseSlot = Math.min(...healthy.map((entry) => entry.value));
  for (let offset = 0; offset < 64; offset += 1) {
    const slot = baseSlot - offset;
    if (slot <= 0) break;
    const blocks = await settled(healthy.map((entry) => entry.endpoint), (endpoint) => rpcCall(endpoint, 'getBlock', [slot, {
      commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0,
    }]));
    const groups = new Map();
    for (const entry of blocks) {
      if (!entry.value || typeof entry.value.blockhash !== 'string' || typeof entry.value.previousBlockhash !== 'string') continue;
      const identity = `${entry.value.blockhash}:${entry.value.previousBlockhash}`;
      const group = groups.get(identity) ?? [];
      group.push(entry.endpoint.id);
      groups.set(identity, group);
    }
    const agreement = [...groups.values()].find((group) => group.length >= rpcSet.threshold);
    if (agreement) return { genesisHash: DEVNET_GENESIS, slot, agreeingProviderIds: agreement.sort() };
  }
  throw new Error('Independent RPCs could not establish 2-of-3 finalized agreement');
}

export function selectHeliusEndpoint(rpcSet) {
  const candidates = rpcSet.endpoints.filter((endpoint) => (
    /^helius(?:-|$)/u.test(endpoint.id)
    || endpoint.trustDomain === 'helius.xyz'
    || endpoint.host.endsWith('.helius-rpc.com')
  ));
  if (candidates.length !== 1) throw new Error('RPC set must contain exactly one Helius endpoint for the browser proxy');
  return candidates[0];
}
