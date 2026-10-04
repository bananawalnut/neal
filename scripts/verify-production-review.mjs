import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_REVIEW_SCHEMA = 'neal.production-review/v2';

const sha256File = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const sha = (value, label) => {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(label + ' must be a lowercase SHA-256');
};

export function validateProductionReview(value, expected) {
  const fields = [
    'schema', 'sourceCommit', 'reviewedAt', 'reviewerIdentity', 'releaseManifestSha256',
    'sbfSha256', 'issuerBundleSha256', 'findings', 'signatureType',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Production review must be an object');
  if (Object.keys(value).sort().join() !== fields.sort().join()) throw new Error('Production review fields are unsupported');
  if (value.schema !== PRODUCTION_REVIEW_SCHEMA) throw new Error('Production review schema is unsupported');
  if (!/^[0-9a-f]{40}$/u.test(value.sourceCommit) || value.sourceCommit !== expected.sourceCommit) {
    throw new Error('Production review does not bind the exact source commit');
  }
  if (typeof value.reviewedAt !== 'string' || Number.isNaN(Date.parse(value.reviewedAt)) || !value.reviewedAt.endsWith('Z')) {
    throw new Error('Production review timestamp is invalid');
  }
  if (value.reviewerIdentity !== expected.reviewerIdentity || value.signatureType !== 'sigstore-keyless') {
    throw new Error('Production review signer identity is not approved');
  }
  for (const name of ['releaseManifestSha256', 'sbfSha256', 'issuerBundleSha256']) {
    sha(value[name], name);
    if (value[name] !== expected[name]) throw new Error('Production review does not bind ' + name);
  }
  if (
    !value.findings
    || Object.keys(value.findings).sort().join() !== ['p0', 'p1', 'p2', 'p3'].join()
    || !['p0', 'p1', 'p2', 'p3'].every((name) => Number.isSafeInteger(value.findings[name]) && value.findings[name] >= 0)
    || value.findings.p0 !== 0
    || value.findings.p1 !== 0
    || value.findings.p2 !== 0
  ) throw new Error('Production review has unresolved P0-P2 findings');
  return value;
}

const runCosign = (reviewFile, bundleFile, identity, issuer) => new Promise((resolve, reject) => {
  const child = spawn('cosign', [
    'verify-blob',
    reviewFile,
    '--bundle', bundleFile,
    '--certificate-identity', identity,
    '--certificate-oidc-issuer', issuer,
  ], { stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('Sigstore keyless verification failed')));
});

const parseCli = (argv) => {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error('Unexpected argument: ' + argument);
    values[argument.slice(2)] = argv[++index];
  }
  for (const name of [
    'review', 'sigstore-bundle', 'release-manifest', 'sbf', 'issuer-bundle',
    'source-commit', 'expected-identity', 'expected-issuer',
  ]) if (!values[name]) throw new Error('Missing --' + name);
  return values;
};

async function main() {
  const options = parseCli(process.argv.slice(2));
  const files = Object.fromEntries(
    ['review', 'sigstore-bundle', 'release-manifest', 'sbf', 'issuer-bundle']
      .map((name) => [name, path.resolve(options[name])]),
  );
  const expected = {
    sourceCommit: options['source-commit'],
    reviewerIdentity: options['expected-identity'],
    releaseManifestSha256: await sha256File(files['release-manifest']),
    sbfSha256: await sha256File(files.sbf),
    issuerBundleSha256: await sha256File(files['issuer-bundle']),
  };
  const review = validateProductionReview(JSON.parse(await fs.readFile(files.review, 'utf8')), expected);
  await runCosign(files.review, files['sigstore-bundle'], options['expected-identity'], options['expected-issuer']);
  console.log(JSON.stringify({
    schema: 'neal.production-review-verification/v1',
    sourceCommit: review.sourceCommit,
    reviewerIdentity: review.reviewerIdentity,
    artifacts: expected,
    signatureVerified: true,
  }, null, 2));
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('Production review verification failed: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
