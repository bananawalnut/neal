import {
  createHash,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createSchemaValidator } from './schema-validator.mjs';

const WIRE_SCHEMA = JSON.parse(readFileSync(new URL('../schema/bundle.schema.json', import.meta.url), 'utf8'));
const validateWire = createSchemaValidator(WIRE_SCHEMA);

export const RECORD_DOMAIN = 'loom.image-provenance.record/v1';
export const JOURNAL_DOMAIN = 'loom.image-provenance.journal-entry/v1';
export const SIGNATURE_DOMAIN = 'loom.image-provenance.signature/v1';
export const JOURNAL_SIGNATURE_DOMAIN = 'loom.image-provenance.journal-signature/v1';
export const ANCHOR_RECEIPT_DOMAIN = 'loom.image-provenance.anchor-receipt-id/v1';
export const EVIDENCE_ATTACHMENT_DOMAIN = 'loom.image-provenance.evidence-attachment-id/v1';

const SHA256_PATTERN = /^sha256:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/u;
const CANONICAL_BASE64URL_PATTERN = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-][AQgw]|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048])?$/u;
const DECIMAL_INTEGER_PATTERN = /^(?:0|-?[1-9][0-9]*)$/u;
const BODY_SCHEMAS = new Map([
  ['capture', 'loom.image-provenance.capture/v1'],
  ['source', 'loom.image-provenance.source/v1'],
  ['transform', 'loom.image-provenance.transform/v1'],
]);
const PURPOSES = new Map([
  ['capture', 'capture-origin'],
  ['source', 'source-ingest'],
  ['transform', 'transform-executor'],
]);
const RECORD_SIGNATURE_PURPOSES = new Set([...PURPOSES.values(), 'operator-approval']);
const ORIGIN_ASSURANCE = new Map([
  ['self-declared', 0],
  ['app-attested', 1],
  ['os-attested', 2],
  ['sensor-path-attested', 3],
]);
const VERDICT_BLOCKER = Symbol('verdict-blocker');

function assertUnicodeScalarString(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} contains an unpaired high surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} contains an unpaired low surrogate`);
    }
  }
  if (value.normalize('NFC') !== value) {
    throw new TypeError(`${label} must already be Unicode NFC`);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, required, optional = []) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function canonicalBase64UrlByteLength(value) {
  if (typeof value !== 'string'
    || !BASE64URL_PATTERN.test(value)
    || !CANONICAL_BASE64URL_PATTERN.test(value)) return null;
  return Math.floor((value.length * 3) / 4);
}

/**
 * RFC 8785 JSON Canonicalization Scheme for the deliberately number-free v1
 * value space. Strings are validated but never normalized.
 */
export function canonicalize(value, path = '$') {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    throw new TypeError(`${path} uses a JSON number; v1 requires a decimal string or tagged decimal`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(',')}]`;
  }
  if (!isPlainObject(value)) throw new TypeError(`${path} is not a canonical JSON value`);

  if (Object.hasOwn(value, '$type')) {
    const keys = Object.keys(value).sort();
    if (value.$type === 'decimal') {
      if (!sameArray(keys, ['$type', 'coefficient', 'scale'])
        || !DECIMAL_INTEGER_PATTERN.test(value.coefficient ?? '')
        || !DECIMAL_INTEGER_PATTERN.test(value.scale ?? '')) {
        throw new TypeError(`${path} is not a canonical decimal tag`);
      }
    } else if (value.$type === 'bytes') {
      if (!sameArray(keys, ['$type', 'base64url'])) {
        throw new TypeError(`${path} is not a canonical bytes tag`);
      }
      if (canonicalBase64UrlByteLength(value.base64url) === null) {
        throw new TypeError(`${path}.base64url is not canonical base64url`);
      }
    } else {
      throw new TypeError(`${path} uses the reserved $type member`);
    }
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => {
    assertUnicodeScalarString(key, `${path} key`);
    if (value[key] === undefined) throw new TypeError(`${path}.${key} is undefined`);
    return `${JSON.stringify(key)}:${canonicalize(value[key], `${path}.${key}`)}`;
  }).join(',')}}`;
}

export function decodeBase64Url(value, label = 'base64url', maxBytes = Number.MAX_SAFE_INTEGER) {
  const byteLength = canonicalBase64UrlByteLength(value);
  if (byteLength === null) {
    throw new TypeError(`${label} must be unpadded base64url`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || byteLength > maxBytes) {
    throw new RangeError(`${label} exceeds its byte limit`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new TypeError(`${label} is not canonical base64url`);
  return bytes;
}

export function sha256Digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('base64url')}`;
}

export function recordIdFor(body) {
  return sha256Digest(Buffer.concat([
    Buffer.from(RECORD_DOMAIN, 'utf8'),
    Buffer.from([0]),
    Buffer.from(canonicalize(body), 'utf8'),
  ]));
}

export function journalEntryIdFor(body) {
  return sha256Digest(Buffer.concat([
    Buffer.from(JOURNAL_DOMAIN, 'utf8'),
    Buffer.from([0]),
    Buffer.from(canonicalize(body), 'utf8'),
  ]));
}

export function anchorReceiptDigestFor(receipt) {
  return sha256Digest(Buffer.concat([
    Buffer.from(ANCHOR_RECEIPT_DOMAIN, 'utf8'),
    Buffer.from([0]),
    Buffer.from(canonicalize(receipt), 'utf8'),
  ]));
}

export function evidenceAttachmentDigestFor(attachment) {
  return sha256Digest(Buffer.concat([
    Buffer.from(EVIDENCE_ATTACHMENT_DOMAIN, 'utf8'),
    Buffer.from([0]),
    Buffer.from(canonicalize(attachment), 'utf8'),
  ]));
}

export function keyFingerprintFor(publicKey) {
  const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey);
  return sha256Digest(key.export({ type: 'spki', format: 'der' }));
}

export function signatureStatementFor({ recordId, purpose, suite, signerKeyFingerprint }) {
  return {
    domain: SIGNATURE_DOMAIN,
    purpose,
    recordId,
    signerKeyFingerprint,
    suite,
  };
}

function keySupportsSuite(publicKey, suite) {
  if (suite === 'Ed25519') return publicKey.asymmetricKeyType === 'ed25519';
  if (suite === 'ES256') {
    return publicKey.asymmetricKeyType === 'ec'
      && publicKey.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  }
  return false;
}

export function signRecord(body, { privateKey, publicKey, purpose = PURPOSES.get(body.kind), suite = 'Ed25519' }) {
  if (!purpose) throw new TypeError(`No default signature purpose for ${String(body.kind)}`);
  const recordId = recordIdFor(body);
  const signerKeyFingerprint = keyFingerprintFor(publicKey);
  const statement = signatureStatementFor({ recordId, purpose, suite, signerKeyFingerprint });
  const message = Buffer.from(canonicalize(statement), 'utf8');
  const normalizedPublicKey = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey);
  if (!keySupportsSuite(normalizedPublicKey, suite)) {
    throw new TypeError(`The supplied public key is not valid for ${suite}`);
  }
  let signature;
  if (suite === 'Ed25519') {
    signature = cryptoSign(null, message, privateKey);
  } else if (suite === 'ES256') {
    signature = cryptoSign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  } else {
    throw new TypeError(`Unsupported signature suite: ${suite}`);
  }

  return {
    schema: 'loom.image-provenance.record-envelope/v1',
    recordId,
    body,
    signatures: [{
      statement,
      signature: signature.toString('base64url'),
      inlinePublicKey: {
        format: 'spki-der',
        value: normalizedPublicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      },
    }],
  };
}

function blobKey(blob) {
  return `${blob.digest}|${blob.byteLength}|${blob.mediaType}`;
}

function artifactKey(artifact) {
  return canonicalize(artifact);
}

function finding(code, status, message, extra = {}) {
  const { blocksVerdict = false, ...publicFields } = extra;
  const result = { code, status, message, ...publicFields };
  if (blocksVerdict) Object.defineProperty(result, VERDICT_BLOCKER, { value: true });
  return result;
}

function mergeStatus(statuses) {
  if (statuses.includes('invalid')) return 'invalid';
  if (statuses.includes('indeterminate')) return 'indeterminate';
  if (statuses.includes('unsupported')) return 'unsupported';
  if (statuses.includes('valid')) return 'valid';
  return 'not-present';
}

function parseLimit(value, fallback) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function parseBigLimit(value, fallback) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return fallback;
  return BigInt(value);
}

function validateExactBlob(blob, path, findings, recordId) {
  let valid = true;
  if (!isPlainObject(blob) || !SHA256_PATTERN.test(blob.digest ?? '')) {
    findings.push(finding('HASH_MISMATCH', 'invalid', `${path}.digest is not a canonical SHA-256 identifier`, { recordId }));
    valid = false;
  }
  if (!isPlainObject(blob) || !DECIMAL_INTEGER_PATTERN.test(blob.byteLength ?? '') || String(blob.byteLength).startsWith('-')) {
    findings.push(finding('BYTE_LENGTH_MISMATCH', 'invalid', `${path}.byteLength is not a non-negative decimal string`, { recordId }));
    valid = false;
  }
  if (!isPlainObject(blob) || typeof blob.mediaType !== 'string' || !blob.mediaType.includes('/')) {
    findings.push(finding('POLICY_DENIED', 'invalid', `${path}.mediaType is invalid`, { recordId }));
    valid = false;
  }
  return valid;
}

function strictBodyCheck(record, findings, verifiedCriticalExtensions) {
  const { body, recordId } = record;
  const schemaResult = validateWire('#/$defs/recordBody', body);
  if (!hasExactKeys(record, ['schema', 'recordId', 'body', 'signatures'])
    || !Array.isArray(record.signatures)
    || record.schema !== 'loom.image-provenance.record-envelope/v1'
    || !SHA256_PATTERN.test(recordId ?? '')
    || !schemaResult.valid) {
    findings.push(finding('POLICY_DENIED', 'invalid', `Record does not match the strict v1 wire shape: ${schemaResult.errors[0] ?? 'invalid envelope'}`, { recordId }));
    return false;
  }
  if (!isPlainObject(body) || BODY_SCHEMAS.get(body.kind) !== body.schema) {
    findings.push(finding('UNSUPPORTED_VERSION', 'invalid', 'Record kind and schema do not identify a supported v1 body', { recordId }));
    return false;
  }
  if (!Array.isArray(body.inputs) || !Array.isArray(body.outputs) || body.outputs.length === 0) {
    findings.push(finding('POLICY_DENIED', 'invalid', 'Record inputs/outputs are malformed or outputs are empty', { recordId }));
    return false;
  }
  if ((body.kind === 'capture' || body.kind === 'source') && body.inputs.length !== 0) {
    findings.push(finding('POLICY_DENIED', 'invalid', `${body.kind} records must be graph roots`, { recordId }));
    return false;
  }
  if (body.kind === 'transform' && body.inputs.length === 0) {
    findings.push(finding('MISSING_PARENT', 'invalid', 'Transform records require at least one input edge', { recordId }));
    return false;
  }
  const names = new Set();
  for (const [index, output] of body.outputs.entries()) {
    if (!isPlainObject(output) || typeof output.outputName !== 'string' || !output.outputName || names.has(output.outputName)) {
      findings.push(finding('MISSING_OUTPUT', 'invalid', `Output ${index} has an empty or duplicate name`, { recordId }));
      return false;
    }
    names.add(output.outputName);
    if (!validateExactBlob(output.artifact?.blob, `outputs[${index}].artifact.blob`, findings, recordId)) return false;
  }
  const critical = body.criticalExtensions ?? [];
  if (!Array.isArray(critical) || new Set(critical).size !== critical.length) {
    findings.push(finding('UNKNOWN_CRITICAL_EXTENSION', 'invalid', 'Critical extension names must be a duplicate-free array', { recordId, blocksVerdict: true }));
    return false;
  }
  for (const uri of critical) {
    if (!isPlainObject(body.extensions) || !Object.hasOwn(body.extensions, uri)) {
      findings.push(finding('UNKNOWN_CRITICAL_EXTENSION', 'invalid', `Critical extension ${String(uri)} has no matching extension value`, { recordId, blocksVerdict: true }));
      return false;
    }
    if (!verifiedCriticalExtensions.has(uri)) {
      findings.push(finding('UNKNOWN_CRITICAL_EXTENSION', 'unsupported', `Unknown critical extension: ${uri}`, { recordId, blocksVerdict: true }));
    }
  }
  canonicalize(body);
  return true;
}

function resolveSignatureKey(signature, trustedKeys) {
  const trusted = trustedKeys.find((candidate) => candidate.fingerprint === signature.statement?.signerKeyFingerprint);
  if (trusted) return { key: trusted.publicKey, trusted };
  if (signature.inlinePublicKey?.format === 'spki-der') {
    return {
      key: signature.inlinePublicKey,
      trusted: null,
    };
  }
  return { key: null, trusted: null };
}

function trustedKeyUsable(trusted, purpose, verificationTime, findings, context) {
  if (!trusted) return 'indeterminate';
  if (!trusted.purposes?.includes(purpose)) {
    findings.push(finding('SIGNER_UNTRUSTED', 'invalid', `The configured key is not authorized for ${purpose}`, context));
    return 'invalid';
  }
  const temporal = [trusted.notBefore, trusted.notAfter, trusted.revokedAt].filter(Boolean);
  if (temporal.length === 0) return 'valid';
  if (verificationTime === undefined) {
    findings.push(finding('CLOCK_UNTRUSTED', 'indeterminate', 'A verification time is required to evaluate this key validity interval', context));
    return 'indeterminate';
  }
  if (!validateWire('#/$defs/timestamp', verificationTime).valid
    || temporal.some((value) => !validateWire('#/$defs/timestamp', value).valid)) {
    findings.push(finding('CLOCK_UNTRUSTED', 'indeterminate', 'The verification time or configured key interval is not a canonical RFC 3339 timestamp', context));
    return 'indeterminate';
  }
  const evaluatedAt = Date.parse(verificationTime);
  const notBefore = trusted.notBefore === undefined ? null : Date.parse(trusted.notBefore);
  const notAfter = trusted.notAfter === undefined ? null : Date.parse(trusted.notAfter);
  const revokedAt = trusted.revokedAt === undefined ? null : Date.parse(trusted.revokedAt);
  if (![evaluatedAt, notBefore, notAfter, revokedAt].every((value) => value === null || Number.isFinite(value))) {
    findings.push(finding('CLOCK_UNTRUSTED', 'indeterminate', 'The verification time or configured key interval is malformed', context));
    return 'indeterminate';
  }
  if (revokedAt !== null && evaluatedAt >= revokedAt) {
    findings.push(finding('SIGNER_REVOKED', 'invalid', 'The signing key was revoked at the verification time', context));
    return 'invalid';
  }
  if ((notBefore !== null && evaluatedAt < notBefore) || (notAfter !== null && evaluatedAt > notAfter)) {
    findings.push(finding('SIGNER_UNTRUSTED', 'invalid', 'The signing key is outside its configured validity interval', context));
    return 'invalid';
  }
  return 'valid';
}

function verifyRecordSignatures(record, trustedKeys, findings, verificationTime) {
  const expectedPurpose = PURPOSES.get(record.body?.kind);
  let requiredValid = false;
  let requiredTrusted = false;
  let requiredTrustInvalid = false;
  let anyUnsupported = false;

  const proofs = Array.isArray(record.signatures) ? record.signatures : [];
  if (proofs.length === 0) {
    findings.push(finding('SIGNATURE_INVALID', 'invalid', `A ${String(record.body?.kind)} record requires a ${String(expectedPurpose)} signature`, { recordId: record.recordId }));
  }
  for (const proof of proofs) {
    const proofShape = validateWire('#/$defs/recordSignature', proof);
    if (!proofShape.valid) {
      findings.push(finding('SIGNATURE_INVALID', 'invalid', `Signature proof does not match the strict v1 wire shape: ${proofShape.errors[0]}`, { recordId: record.recordId }));
      continue;
    }
    const statement = proof?.statement;
    if (!isPlainObject(statement)
      || statement.domain !== SIGNATURE_DOMAIN
      || statement.recordId !== record.recordId
      || !RECORD_SIGNATURE_PURPOSES.has(statement.purpose)
      || (statement.purpose !== expectedPurpose && statement.purpose !== 'operator-approval')) {
      findings.push(finding('SIGNATURE_INVALID', 'invalid', 'Signature statement has the wrong domain, record, or purpose', { recordId: record.recordId }));
      continue;
    }
    const { key: keyDescriptor, trusted } = resolveSignatureKey(proof, trustedKeys);
    if (!keyDescriptor) {
      findings.push(finding('SIGNER_UNTRUSTED', 'indeterminate', 'No public key is available for this signature', { recordId: record.recordId }));
      continue;
    }
    try {
      const keyBytes = decodeBase64Url(keyDescriptor.value, 'public key');
      const publicKey = createPublicKey({ key: keyBytes, type: 'spki', format: 'der' });
      if (keyFingerprintFor(publicKey) !== statement.signerKeyFingerprint) {
        findings.push(finding('SIGNATURE_INVALID', 'invalid', 'Signer key fingerprint does not match the proof key', { recordId: record.recordId }));
        continue;
      }
      if ((statement.suite === 'Ed25519' || statement.suite === 'ES256')
        && !keySupportsSuite(publicKey, statement.suite)) {
        findings.push(finding('SIGNATURE_INVALID', 'invalid', `Signer key type or curve is not valid for ${statement.suite}`, { recordId: record.recordId }));
        continue;
      }
      const message = Buffer.from(canonicalize(statement), 'utf8');
      const signature = decodeBase64Url(proof.signature, 'signature');
      let valid = false;
      if (statement.suite === 'Ed25519') {
        valid = cryptoVerify(null, message, publicKey, signature);
      } else if (statement.suite === 'ES256') {
        valid = signature.length === 64
          && cryptoVerify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
      } else {
        anyUnsupported = true;
        findings.push(finding('UNSUPPORTED_ALGORITHM', 'unsupported', `Unsupported signature suite: ${String(statement.suite)}`, { recordId: record.recordId }));
        continue;
      }
      if (!valid) {
        findings.push(finding('SIGNATURE_INVALID', 'invalid', 'Signature verification failed', { recordId: record.recordId }));
        continue;
      }
      if (statement.purpose === expectedPurpose) {
        requiredValid = true;
        const trustStatus = trustedKeyUsable(trusted, statement.purpose, verificationTime, findings, { recordId: record.recordId });
        if (trustStatus === 'valid') requiredTrusted = true;
        else if (trustStatus === 'invalid') requiredTrustInvalid = true;
      }
    } catch (error) {
      findings.push(finding('SIGNATURE_INVALID', 'invalid', `Signature proof is malformed: ${error.message}`, { recordId: record.recordId }));
    }
  }

  if (!requiredValid && !anyUnsupported) {
    findings.push(finding('SIGNATURE_INVALID', 'invalid', `No valid ${expectedPurpose} signature is present`, { recordId: record.recordId }));
  }

  return {
    signature: requiredValid ? 'valid' : anyUnsupported ? 'unsupported' : 'invalid',
    signerTrust: requiredTrusted
      ? 'valid'
      : requiredValid && requiredTrustInvalid
        ? 'invalid'
        : requiredValid ? 'indeterminate' : 'invalid',
  };
}

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function isSortedUniqueDigestArray(value) {
  return Array.isArray(value) && value.every((item, index) => (
    typeof item === 'string'
    && SHA256_PATTERN.test(item)
    && (index === 0 || value[index - 1] < item)
  ));
}

function verifyJournalSignatures(entry, trustedKeys, findings, verificationTime) {
  let anyValid = false;
  let anyTrusted = false;
  let anyTrustInvalid = false;
  let anyUnsupported = false;
  const proofs = Array.isArray(entry.signatures) ? entry.signatures : [];
  if (proofs.length === 0) {
    findings.push(finding('SIGNATURE_INVALID', 'invalid', 'A journal entry requires a journal-append signature'));
  }
  for (const proof of proofs) {
    const proofShape = validateWire('#/$defs/journalSignature', proof);
    if (!proofShape.valid) {
      findings.push(finding('SIGNATURE_INVALID', 'invalid', `Journal signature proof does not match the strict v1 wire shape: ${proofShape.errors[0]}`));
      continue;
    }
    const statement = proof?.statement;
    if (!isPlainObject(statement)
      || statement.domain !== JOURNAL_SIGNATURE_DOMAIN
      || statement.entryId !== entry.entryId
      || statement.purpose !== 'journal-append') {
      findings.push(finding('SIGNATURE_INVALID', 'invalid', 'Journal signature statement has the wrong domain, entry, or purpose'));
      continue;
    }
    const { key: keyDescriptor, trusted } = resolveSignatureKey(proof, trustedKeys);
    if (!keyDescriptor) {
      findings.push(finding('SIGNER_UNTRUSTED', 'indeterminate', 'No public key is available for this journal signature'));
      continue;
    }
    try {
      const keyBytes = decodeBase64Url(keyDescriptor.value, 'journal public key');
      const publicKey = createPublicKey({ key: keyBytes, type: 'spki', format: 'der' });
      if (keyFingerprintFor(publicKey) !== statement.signerKeyFingerprint) {
        findings.push(finding('SIGNATURE_INVALID', 'invalid', 'Journal signer key fingerprint does not match the proof key'));
        continue;
      }
      if ((statement.suite === 'Ed25519' || statement.suite === 'ES256')
        && !keySupportsSuite(publicKey, statement.suite)) {
        findings.push(finding('SIGNATURE_INVALID', 'invalid', `Journal signer key type or curve is not valid for ${statement.suite}`));
        continue;
      }
      const message = Buffer.from(canonicalize(statement), 'utf8');
      const signature = decodeBase64Url(proof.signature, 'journal signature');
      let valid = false;
      if (statement.suite === 'Ed25519') {
        valid = cryptoVerify(null, message, publicKey, signature);
      } else if (statement.suite === 'ES256') {
        valid = signature.length === 64
          && cryptoVerify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
      } else {
        anyUnsupported = true;
        findings.push(finding('UNSUPPORTED_ALGORITHM', 'unsupported', `Unsupported journal signature suite: ${String(statement.suite)}`));
        continue;
      }
      if (!valid) {
        findings.push(finding('SIGNATURE_INVALID', 'invalid', 'Journal signature verification failed'));
        continue;
      }
      anyValid = true;
      const trustStatus = trustedKeyUsable(trusted, 'journal-append', verificationTime, findings, {});
      if (trustStatus === 'valid') anyTrusted = true;
      else if (trustStatus === 'invalid') anyTrustInvalid = true;
    } catch (error) {
      findings.push(finding('SIGNATURE_INVALID', 'invalid', `Journal signature proof is malformed: ${error.message}`));
    }
  }
  return {
    signature: anyValid ? 'valid' : anyUnsupported ? 'unsupported' : 'invalid',
    signerTrust: anyTrusted ? 'valid' : anyValid && anyTrustInvalid ? 'invalid' : anyValid ? 'indeterminate' : 'invalid',
  };
}

function verifyJournal({
  bundle,
  recordsById,
  reachableRecordIds,
  trustedKeys,
  verificationTime,
  verifiedAnchorResults,
  acceptedWitnessProfiles,
  policy,
  findings,
}) {
  const entries = Array.isArray(bundle?.journalEntries) ? bundle.journalEntries : [];
  const entriesById = new Map();
  const conflictingEntryIds = new Set();
  for (const entry of entries) {
    const bodyShape = validateWire('#/$defs/journalEntryBody', entry?.body);
    let computedEntryId = null;
    try { computedEntryId = bodyShape.valid ? journalEntryIdFor(entry.body) : null; } catch { /* diagnostic below */ }
    if (!hasExactKeys(entry, ['schema', 'entryId', 'body', 'signatures'])
      || entry.schema !== 'loom.image-provenance.journal-envelope/v1'
      || !Array.isArray(entry.signatures)
      || !SHA256_PATTERN.test(entry.entryId ?? '')
      || !bodyShape.valid
      || computedEntryId !== entry.entryId) {
      findings.push(finding(
        'LOG_CONSISTENCY_INVALID',
        'invalid',
        `Ignored a malformed or ID-mismatched journal envelope${bodyShape.errors[0] ? `: ${bodyShape.errors[0]}` : ''}`,
      ));
      continue;
    }
    if (!entriesById.has(entry.entryId)) {
      entriesById.set(entry.entryId, entry);
      continue;
    }
    const existing = entriesById.get(entry.entryId);
    let sameBody = false;
    try {
      sameBody = existing.schema === entry.schema
        && canonicalize(existing.body) === canonicalize(entry.body);
    } catch {
      sameBody = false;
    }
    if (!sameBody) {
      conflictingEntryIds.add(entry.entryId);
      findings.push(finding('LOG_CONSISTENCY_INVALID', 'invalid', `Two independently ID-valid journal bodies collide at entry ID: ${entry.entryId}`));
      continue;
    }
    const oldSignatures = Array.isArray(existing.signatures) ? existing.signatures : [];
    const newSignatures = Array.isArray(entry.signatures) ? entry.signatures : [];
    const signatureKeys = new Set(oldSignatures.map((signature) => {
      try { return canonicalize(signature); } catch { return null; }
    }));
    const signatures = [...oldSignatures];
    for (const signature of newSignatures) {
      let key = null;
      try { key = canonicalize(signature); } catch { /* verified if selected */ }
      if (!signatureKeys.has(key)) {
        signatureKeys.add(key);
        signatures.push(signature);
      }
    }
    entriesById.set(entry.entryId, { ...existing, signatures });
  }

  const baseResults = new Map();
  const inspectBase = (entry) => {
    if (baseResults.has(entry.entryId)) return baseResults.get(entry.entryId);
    let valid = true;
    const body = entry.body;
    const schemaResult = validateWire('#/$defs/journalEntryBody', body);
    if (!hasExactKeys(entry, ['schema', 'entryId', 'body', 'signatures'])
      || !Array.isArray(entry.signatures)
      || entry.schema !== 'loom.image-provenance.journal-envelope/v1'
      || !isPlainObject(body)
      || !SHA256_PATTERN.test(entry.entryId ?? '')
      || !schemaResult.valid
      || body.schema !== 'loom.image-provenance.journal-entry/v1'
      || typeof body.journalId !== 'string'
      || body.journalId.length === 0
      || !/^(?:0|[1-9][0-9]*)$/u.test(body.sequence ?? '')
      || !(body.previousEntryId === null || SHA256_PATTERN.test(body.previousEntryId ?? ''))
      || !isSortedUniqueDigestArray(body.priorHeads)
      || !isSortedUniqueDigestArray(body.resultingHeads)) {
      valid = false;
      findings.push(finding('LOG_CONSISTENCY_INVALID', 'invalid', `Journal entry ${entry.entryId} has a malformed envelope or body: ${schemaResult.errors[0] ?? 'invalid envelope'}`));
    }
    if (valid) {
      try {
        const computed = journalEntryIdFor(body);
        if (computed !== entry.entryId) {
          valid = false;
          findings.push(finding('LOG_CONSISTENCY_INVALID', 'invalid', `Journal entry ID does not match its canonical body (computed ${computed})`));
        }
      } catch (error) {
        valid = false;
        findings.push(finding('LOG_CONSISTENCY_INVALID', 'invalid', `Journal body is outside the canonical value space: ${error.message}`));
      }
    }
    const event = body?.event;
    if (!isPlainObject(event)
      || (event.kind === 'record-committed'
        ? !SHA256_PATTERN.test(event.recordId ?? '')
        : event.kind === 'heads-checkpoint'
          ? !isSortedUniqueDigestArray(event.headRecordIds)
          : true)) {
      valid = false;
      findings.push(finding('LOG_CONSISTENCY_INVALID', 'invalid', `Journal entry ${entry.entryId} has a malformed event`));
    }
    const signatures = verifyJournalSignatures(entry, trustedKeys, findings, verificationTime);
    const result = { valid, signatures };
    baseResults.set(entry.entryId, result);
    return result;
  };

  const journalBranches = new Map();
  for (const entry of entriesById.values()) {
    const body = entry?.body;
    const base = inspectBase(entry);
    if (!base.valid
      || base.signatures.signature !== 'valid'
      || base.signatures.signerTrust !== 'valid') continue;
    const branchKey = body.previousEntryId === null
      ? `${body.journalId}|<genesis>`
      : `${body.journalId}|${String(body.previousEntryId)}`;
    if (!journalBranches.has(branchKey)) journalBranches.set(branchKey, []);
    journalBranches.get(branchKey).push(entry.entryId);
  }
  const forkedEntryIds = new Set();
  const trustedForkJournalIds = new Set();
  for (const [branchKey, entryIds] of journalBranches) {
    if (entryIds.length <= 1) continue;
    const forkJournalId = entriesById.get(entryIds[0])?.body?.journalId;
    if (typeof forkJournalId === 'string') trustedForkJournalIds.add(forkJournalId);
    for (const entryId of entryIds) forkedEntryIds.add(entryId);
    findings.push(finding('LOG_CONSISTENCY_INVALID', 'invalid', `Trusted journal fork or multiple genesis at ${branchKey}`));
  }

  // V1 reuses the policy's bounded traversal depth for both DAG and journal
  // walks, so neither hostile structure can force an unbounded traversal.
  const maxJournalDepth = parseLimit(policy?.limits?.maxDepth, 10_000);
  const childrenByPrevious = new Map();
  const genesisIds = [];
  for (const entry of entriesById.values()) {
    const previousEntryId = entry?.body?.previousEntryId;
    if (previousEntryId === null) {
      genesisIds.push(entry.entryId);
    } else if (typeof previousEntryId === 'string') {
      if (!childrenByPrevious.has(previousEntryId)) childrenByPrevious.set(previousEntryId, []);
      childrenByPrevious.get(previousEntryId).push(entry.entryId);
    }
  }

  // First resolve predecessor structure iteratively. Journal input order has no
  // meaning, and hostile long chains cannot consume the JavaScript call stack.
  const preliminary = new Map();
  const queue = [...genesisIds];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const entryId = queue[cursor];
    if (preliminary.has(entryId)) continue;
    const entry = entriesById.get(entryId);
    const body = entry?.body;
    const base = inspectBase(entry);
    const previous = body?.previousEntryId === null
      ? null
      : entriesById.get(body?.previousEntryId);
    const prior = previous ? preliminary.get(previous.entryId) : null;
    let valid = base.valid
      && base.signatures.signature === 'valid'
      && !conflictingEntryIds.has(entryId)
      && !forkedEntryIds.has(entryId);
    let failure = conflictingEntryIds.has(entryId)
      ? 'conflict'
      : forkedEntryIds.has(entryId) ? 'fork' : valid ? null : 'invalid-base';
    const depth = previous ? (prior?.depth ?? maxJournalDepth + 1) + 1 : 0;
    if (body?.previousEntryId === null) {
      if (valid && (body.sequence !== '0' || body.priorHeads.length !== 0)) {
        valid = false;
        failure = 'transition';
        findings.push(finding('LOG_CONSISTENCY_INVALID', 'invalid', `Journal genesis ${entryId} has invalid sequence, predecessor, or prior heads`));
      }
    } else if (!previous || !prior) {
      valid = false;
      failure = 'missing-predecessor';
    } else {
      valid = valid
        && prior.valid
        && previous.body.journalId === body.journalId
        && BigInt(body.sequence) === BigInt(previous.body.sequence) + 1n
        && sameArray(body.priorHeads, previous.body.resultingHeads);
      if (!valid && failure === null) failure = prior.failure ?? 'transition';
      if (!valid) {
        findings.push(finding('LOG_CONSISTENCY_INVALID', 'invalid', `Journal predecessor transition is invalid at ${entryId}`));
      }
    }
    if (depth > maxJournalDepth) {
      valid = false;
      failure = 'depth-limit';
      findings.push(finding('LOG_CONSISTENCY_INVALID', 'invalid', `Journal chain exceeds the ${maxJournalDepth} entry depth limit at ${entryId}`));
    }
    preliminary.set(entryId, {
      valid,
      failure,
      depth,
      base,
      previousEntryId: body?.previousEntryId ?? null,
    });
    for (const childId of childrenByPrevious.get(entryId) ?? []) queue.push(childId);
  }

  for (const entry of entriesById.values()) {
    if (preliminary.has(entry.entryId)) continue;
    const previousEntryId = entry?.body?.previousEntryId;
    const missing = typeof previousEntryId === 'string' && !entriesById.has(previousEntryId);
    findings.push(finding(
      'LOG_CONSISTENCY_INVALID',
      missing ? 'indeterminate' : 'invalid',
      missing
        ? `Journal predecessor ${previousEntryId} is missing`
        : `Journal predecessor cycle or disconnected chain at ${entry.entryId}`,
    ));
    preliminary.set(entry.entryId, {
      valid: false,
      trusted: false,
      failure: missing ? 'missing-predecessor' : 'cycle',
      depth: maxJournalDepth + 1,
      base: inspectBase(entry),
      previousEntryId: previousEntryId ?? null,
    });
  }

  // Then validate commit causality with one mutable set per DFS path. This is
  // linear in entries plus input edges, instead of copying every ancestor set.
  const chainMemo = new Map();
  for (const genesisId of genesisIds) {
    const committed = new Set();
    const stack = [{
      entryId: genesisId,
      exit: false,
      parentValid: true,
      parentTrusted: true,
      parentTrustInvalid: false,
    }];
    while (stack.length > 0) {
      const frame = stack.pop();
      const entry = entriesById.get(frame.entryId);
      if (!entry) continue;
      if (frame.exit) {
        if (frame.committedRecordId !== null) committed.delete(frame.committedRecordId);
        continue;
      }
      const preliminaryResult = preliminary.get(frame.entryId);
      let valid = Boolean(preliminaryResult?.valid && frame.parentValid);
      let failure = preliminaryResult?.failure ?? (frame.parentValid ? null : 'ancestor-invalid');
      let trusted = valid
        && frame.parentTrusted
        && preliminaryResult.base.signatures.signerTrust === 'valid';
      let trustInvalid = valid
        && (frame.parentTrustInvalid || preliminaryResult.base.signatures.signerTrust === 'invalid');
      let committedRecordId = null;
      const body = entry.body;

      if (valid && body.event.kind === 'record-committed') {
        const record = recordsById.get(body.event.recordId);
        let recordValid = Boolean(record)
          && hasExactKeys(record, ['schema', 'recordId', 'body', 'signatures'])
          && Array.isArray(record.signatures)
          && validateWire('#/$defs/recordBody', record.body).valid;
        if (recordValid) {
          try { recordValid = recordIdFor(record.body) === record.recordId; } catch { recordValid = false; }
        }
        if (!recordValid || !Array.isArray(record?.body?.inputs)) {
          valid = false;
          failure = 'invalid-record';
          findings.push(finding('LOG_CONSISTENCY_INVALID', 'invalid', `Journal entry ${frame.entryId} commits a missing or invalid record`));
        } else {
          const committedRecordSignature = verifyRecordSignatures(
            record,
            trustedKeys,
            findings,
            verificationTime,
          );
          if (committedRecordSignature.signature !== 'valid') {
            valid = false;
            failure = 'invalid-record-signature';
            findings.push(finding('LOG_CONSISTENCY_INVALID', 'invalid', `Journal entry ${frame.entryId} commits a record without its required valid signature`));
          }
          const uncommittedInputs = record.body.inputs
            .map((edge) => edge?.producerRecordId)
            .filter((producerId) => !committed.has(producerId));
          if (committed.has(record.recordId) || uncommittedInputs.length > 0) {
            valid = false;
            failure = 'commit-order';
            findings.push(finding('LOG_CONSISTENCY_INVALID', 'invalid', `Journal entry ${frame.entryId} commits a record before its inputs or commits it twice`));
          }
          const consumed = new Set(record.body.inputs
            .filter((edge) => edge?.relation === 'consumes')
            .map((edge) => edge.producerRecordId));
          const expectedHeads = [...new Set([
            ...body.priorHeads.filter((head) => !consumed.has(head)),
            record.recordId,
          ])].sort();
          if (!sameArray(body.resultingHeads, expectedHeads)) {
            valid = false;
            failure = 'head-transition';
            findings.push(finding('LOG_CONSISTENCY_INVALID', 'invalid', `Journal head transition is invalid at ${frame.entryId}`));
          }
          if (valid) {
            committed.add(record.recordId);
            committedRecordId = record.recordId;
          }
        }
      } else if (valid && (!sameArray(body.event.headRecordIds, body.priorHeads)
        || !sameArray(body.resultingHeads, body.priorHeads))) {
        valid = false;
        failure = 'head-transition';
        findings.push(finding('LOG_CONSISTENCY_INVALID', 'invalid', `Journal checkpoint changes or misstates heads at ${frame.entryId}`));
      }

      trusted = valid && trusted;
      trustInvalid = valid && trustInvalid;
      const result = {
        valid,
        trusted,
        trustInvalid,
        failure: valid ? null : failure,
        depth: preliminaryResult?.depth ?? maxJournalDepth + 1,
      };
      chainMemo.set(frame.entryId, result);
      stack.push({ ...frame, exit: true, committedRecordId });
      const children = childrenByPrevious.get(frame.entryId) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({
          entryId: children[index],
          exit: false,
          parentValid: valid,
          parentTrusted: trusted,
          parentTrustInvalid: trustInvalid,
        });
      }
    }
  }
  for (const [entryId, state] of preliminary) {
    if (!chainMemo.has(entryId)) chainMemo.set(entryId, { ...state, trusted: false, trustInvalid: false });
  }
  const validateChain = (entryId) => chainMemo.get(entryId)
    ?? { valid: false, trusted: false, trustInvalid: false, failure: 'missing', depth: 0 };

  const bundleAnchors = Array.isArray(bundle?.anchors) ? bundle.anchors : [];
  const anchorsByDigest = new Map();
  for (const receipt of bundleAnchors) {
    if (!validateWire('#/$defs/anchorReceipt', receipt).valid) {
      findings.push(finding('LOG_PROOF_INVALID', 'invalid', 'Ignored a malformed anchor receipt'));
      continue;
    }
    try {
      const digest = anchorReceiptDigestFor(receipt);
      if (!anchorsByDigest.has(digest)) anchorsByDigest.set(digest, []);
      anchorsByDigest.get(digest).push(receipt);
    } catch {
      findings.push(finding('LOG_PROOF_INVALID', 'invalid', 'Ignored an anchor receipt outside the canonical value space'));
    }
  }
  const anchorResults = Array.isArray(verifiedAnchorResults) ? verifiedAnchorResults : [];
  const anchoredEntries = new Set();
  const consistentlyAnchoredEntries = new Set();
  const anchorStatuses = [];
  let acceptedConsistencyTrustInvalid = false;
  let acceptedConsistencyInvalid = false;
  let acceptedJournalForkDetected = false;
  const resultsByReceipt = new Map();
  for (const result of anchorResults) {
    const key = result?.anchorReceiptDigest ?? '<missing>';
    if (!resultsByReceipt.has(key)) resultsByReceipt.set(key, []);
    resultsByReceipt.get(key).push(result);
  }
  const addChainToSet = (entryId, target) => {
    let cursor = entryId;
    let traversed = 0;
    while (cursor !== null && !target.has(cursor) && traversed <= maxJournalDepth) {
      target.add(cursor);
      cursor = entriesById.get(cursor)?.body?.previousEntryId ?? null;
      traversed += 1;
    }
  };
  for (const results of resultsByReceipt.values()) {
    const result = results[0];
    const contradictory = results.some((candidate) => candidate?.profileUri !== result?.profileUri
      || candidate?.witnessId !== result?.witnessId
      || candidate?.subjectEntryId !== result?.subjectEntryId
      || candidate?.inclusion !== result?.inclusion
      || candidate?.consistency !== result?.consistency
      || candidate?.trustedTime !== result?.trustedTime);
    if (contradictory) {
      findings.push(finding('LOG_PROOF_INVALID', 'invalid', 'Contradictory verifier results were supplied for one anchor receipt'));
      anchorStatuses.push('invalid');
      continue;
    }
    const resultFindings = results.flatMap((candidate) => candidate?.findings ?? []);
    for (const resultFinding of resultFindings) findings.push({ ...resultFinding });
    const failedResultStatuses = resultFindings
      .filter((item) => item.status !== 'valid')
      .map((item) => item.status);
    if (failedResultStatuses.length > 0) {
      anchorStatuses.push(mergeStatus(failedResultStatuses));
      continue;
    }
    const matchingReceipt = (anchorsByDigest.get(result?.anchorReceiptDigest) ?? []).some((receipt) => {
      if (receipt?.profileUri !== result?.profileUri
        || receipt?.witnessId !== result?.witnessId
        || receipt?.subjectEntryId !== result?.subjectEntryId) return false;
      return true;
    });
    if (!matchingReceipt || !(acceptedWitnessProfiles ?? []).includes(result?.profileUri)) {
      findings.push(finding('LOG_PROOF_INVALID', 'invalid', 'A witness result does not bind an accepted receipt in this bundle'));
      anchorStatuses.push('invalid');
      continue;
    }
    if (result.inclusion !== 'valid') {
      anchorStatuses.push(result.inclusion ?? 'indeterminate');
      continue;
    }
    const subjectJournalId = entriesById.get(result.subjectEntryId)?.body?.journalId;
    if (trustedForkJournalIds.has(subjectJournalId)) acceptedJournalForkDetected = true;
    const chain = validateChain(result.subjectEntryId);
    if (!chain.valid) {
      findings.push(finding('LOG_PROOF_INVALID', 'invalid', 'A verified witness subject does not resolve to a valid journal chain'));
      anchorStatuses.push('invalid');
      continue;
    }
    anchorStatuses.push('valid');
    addChainToSet(result.subjectEntryId, anchoredEntries);
    if (result.consistency === 'valid' && chain.trusted) {
      addChainToSet(result.subjectEntryId, consistentlyAnchoredEntries);
    } else if (result.consistency === 'valid' && chain.trustInvalid) {
      acceptedConsistencyTrustInvalid = true;
    } else if (result.consistency === 'invalid') {
      acceptedConsistencyInvalid = true;
      findings.push(finding('LOG_CONSISTENCY_INVALID', 'invalid', 'An accepted witness result reports an invalid consistency proof'));
    }
  }
  const anchoredRecords = new Set();
  const consistentlyAnchoredRecords = new Set();
  for (const entry of entriesById.values()) {
    const recordId = entry?.body?.event?.kind === 'record-committed' ? entry.body.event.recordId : null;
    if (!recordId || !reachableRecordIds.has(recordId)) continue;
    const chain = typeof entry.entryId === 'string' ? validateChain(entry.entryId) : { valid: false };
    if (chain.valid && anchoredEntries.has(entry.entryId)) anchoredRecords.add(recordId);
    if (chain.valid && consistentlyAnchoredEntries.has(entry.entryId)) consistentlyAnchoredRecords.add(recordId);
  }

  let anchoring = anchoredRecords.size > 0
    ? 'valid'
    : mergeStatus(anchorStatuses.filter((status) => status !== 'valid'));

  const reachable = [...reachableRecordIds];
  if (policy.requireEveryReachableRecordAnchored) {
    const missing = reachable.filter((recordId) => !anchoredRecords.has(recordId));
    if (missing.length) {
      anchoring = anchoring === 'invalid' ? 'invalid' : 'indeterminate';
      findings.push(finding('LOG_PROOF_INVALID', anchoring === 'invalid' ? 'invalid' : 'indeterminate', `${missing.length} reachable record(s) lack a valid transitively anchoring journal chain`, { blocksVerdict: true }));
    }
  }
  if (policy.requireJournalConsistency) {
    if (acceptedJournalForkDetected) {
      anchoring = 'invalid';
      findings.push(finding(
        'LOG_CONSISTENCY_INVALID',
        'invalid',
        'An accepted journal contains an authorized fork or multiple genesis',
        { blocksVerdict: true },
      ));
    }
    const missing = reachable.filter((recordId) => !consistentlyAnchoredRecords.has(recordId));
    if (missing.length) {
      if (acceptedConsistencyTrustInvalid || acceptedConsistencyInvalid) anchoring = 'invalid';
      else if (anchoring !== 'invalid') anchoring = 'indeterminate';
      findings.push(finding('LOG_CONSISTENCY_INVALID', anchoring === 'invalid' ? 'invalid' : 'indeterminate', `${missing.length} reachable record(s) lack a trusted, consistency-verified journal chain`, { blocksVerdict: true }));
    }
  }

  return {
    anchoring,
  };
}

function bundleBlobBytes(bundle, suppliedBlobBytes) {
  const candidates = new Map();
  const add = (digest, candidate) => {
    if (typeof digest !== 'string') return;
    if (!candidates.has(digest)) candidates.set(digest, []);
    candidates.get(digest).push(candidate);
  };
  for (const [digest, bytes] of suppliedBlobBytes ?? []) add(digest, { bytes });
  const locations = Array.isArray(bundle?.blobs) ? bundle.blobs : [];
  for (const item of locations) {
    if (item?.inlineBase64Url !== undefined) {
      add(item?.blob?.digest, { inlineBase64Url: item.inlineBase64Url });
    }
  }
  return candidates;
}

function candidateByteLength(candidate) {
  if (Buffer.isBuffer(candidate?.bytes) || ArrayBuffer.isView(candidate?.bytes)) {
    return BigInt(candidate.bytes.byteLength);
  }
  const decodedLength = canonicalBase64UrlByteLength(candidate?.inlineBase64Url);
  return decodedLength === null ? 0n : BigInt(decodedLength);
}

function verifyArtifactBytes(artifact, bytesByDigest, findings, recordId, outputName) {
  if (!isPlainObject(artifact) || !isPlainObject(artifact.blob)) {
    findings.push(finding('HASH_MISMATCH', 'invalid', 'Artifact reference is malformed', { recordId, outputName }));
    return 'invalid';
  }
  const candidates = bytesByDigest.get(artifact.blob.digest) ?? [];
  if (candidates.length === 0) {
    findings.push(finding('MISSING_BLOB', 'indeterminate', 'Artifact bytes were not supplied; its commitment cannot be recomputed', { recordId, outputName }));
    return 'indeterminate';
  }
  const expectedLength = BigInt(artifact.blob.byteLength);
  let sawWrongLength = false;
  for (const candidate of candidates) {
    let bytes = null;
    if (candidate.bytes !== undefined) {
      if (!Buffer.isBuffer(candidate.bytes) && !ArrayBuffer.isView(candidate.bytes)) continue;
      if (BigInt(candidate.bytes.byteLength) !== expectedLength) {
        sawWrongLength = true;
        continue;
      }
      bytes = candidate.bytes;
    } else {
      const candidateLength = canonicalBase64UrlByteLength(candidate.inlineBase64Url);
      if (candidateLength === null) continue;
      if (BigInt(candidateLength) !== expectedLength) {
        sawWrongLength = true;
        continue;
      }
      try {
        bytes = decodeBase64Url(candidate.inlineBase64Url, 'inline blob', candidateLength);
      } catch {
        continue;
      }
    }
    if (sha256Digest(bytes) === artifact.blob.digest) return 'valid';
  }
  if (sawWrongLength) {
    findings.push(finding('BYTE_LENGTH_MISMATCH', 'invalid', `No supplied candidate has the expected ${artifact.blob.byteLength}-byte length`, { recordId, outputName }));
  } else {
    findings.push(finding('HASH_MISMATCH', 'invalid', 'No supplied candidate matches the artifact digest', { recordId, outputName }));
  }
  return 'invalid';
}

function assuranceAtLeast(actual, required) {
  return (ORIGIN_ASSURANCE.get(actual) ?? -1) >= (ORIGIN_ASSURANCE.get(required) ?? Number.POSITIVE_INFINITY);
}

/**
 * Dependency-free diagnostic evaluator for the v1 core invariants.
 *
 * This is intentionally not the public Verifier port: its preverified-result
 * maps are test/integration seams without a runtime authenticity boundary.
 * Production consumers must use the orchestrating Verifier contract, which
 * invokes configured exact-profile verifiers itself.
 */
function verifyDiagnosticBundleInternal({
  rootOutput,
  bundle,
  policy,
  trustStore,
  blobBytes,
  verifiedCaptureEvidence = new Map(),
  verifiedCaptureBoundaries = new Map(),
  verifiedExecutions = new Map(),
  verifiedOperations = new Map(),
  verifiedAnchorResults = [],
  verifiedCriticalExtensions = new Map(),
  verificationTime,
}) {
  const findings = [];
  const selectedRoot = validateWire('#/$defs/outputPointer', rootOutput).valid
    ? rootOutput
    : {
      recordId: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      outputName: '',
    };
  if (selectedRoot !== rootOutput) {
    findings.push(finding('POLICY_DENIED', 'invalid', 'The caller-supplied root output is malformed', { blocksVerdict: true }));
  }
  const recordsById = new Map();
  const conflictingRecordIds = new Set();
  const recordResults = new Map();
  const maxBundleObjects = parseLimit(policy?.limits?.maxBundleObjects, 50_000);
  const maxRecords = parseLimit(policy?.limits?.maxRecords, 10_000);
  const maxDepth = parseLimit(policy?.limits?.maxDepth, 1_000);
  const maxReferencedBytes = parseBigLimit(policy?.limits?.maxReferencedBytes, 1_073_741_824n);
  const maxBlobCandidatesPerDigest = parseLimit(policy?.limits?.maxBlobCandidatesPerDigest, 8);
  const maxVerificationBytes = parseBigLimit(policy?.limits?.maxVerificationBytes, 4_294_967_296n);

  for (const name of [
    'maxBundleObjects',
    'maxRecords',
    'maxDepth',
    'maxReferencedBytes',
    'maxBlobCandidatesPerDigest',
    'maxVerificationBytes',
  ]) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(policy?.limits?.[name] ?? '')) {
      findings.push(finding('POLICY_DENIED', 'invalid', `Policy limit ${name} is missing or noncanonical`, { blocksVerdict: true }));
    }
  }

  if (!isPlainObject(bundle) || bundle.schema !== 'loom.image-provenance.bundle/v1') {
    findings.push(finding('UNSUPPORTED_VERSION', 'invalid', 'Unsupported provenance bundle schema', { blocksVerdict: true }));
  }
  const collectionNames = ['records', 'journalEntries', 'endorsements', 'anchors', 'blobs'];
  const allowedBundleKeys = new Set(['schema', ...collectionNames, 'suggestedRoots']);
  if (isPlainObject(bundle)) {
    if (Object.keys(bundle).some((key) => !allowedBundleKeys.has(key))
      || collectionNames.some((key) => !Array.isArray(bundle[key]))) {
      findings.push(finding('POLICY_DENIED', 'invalid', 'Bundle has missing collection arrays or unknown top-level fields', { blocksVerdict: true }));
    }
  }
  const bundleRecords = Array.isArray(bundle?.records) ? bundle.records : [];
  if (!Array.isArray(bundle?.records)) {
    findings.push(finding('POLICY_DENIED', 'invalid', 'Bundle records must be an array', { blocksVerdict: true }));
  }
  const bundleObjectCount = collectionNames.reduce((total, key) => (
    total + (Array.isArray(bundle?.[key]) ? bundle[key].length : 0)
  ), 0);
  const resourceLimitExceeded = bundleObjectCount > maxBundleObjects || bundleRecords.length > maxRecords;
  if (bundleObjectCount > maxBundleObjects) {
    findings.push(finding('POLICY_DENIED', 'invalid', `Bundle exceeds the ${maxBundleObjects} object verification limit`, { blocksVerdict: true }));
  }
  if (bundleRecords.length > maxRecords) {
    findings.push(finding('POLICY_DENIED', 'invalid', `Bundle exceeds the ${maxRecords} record verification limit`, { blocksVerdict: true }));
  }
  const recordsToIndex = resourceLimitExceeded ? [] : bundleRecords;
  for (const record of recordsToIndex) {
    const bodyShape = validateWire('#/$defs/recordBody', record?.body);
    let computedRecordId = null;
    try { computedRecordId = bodyShape.valid ? recordIdFor(record.body) : null; } catch { /* diagnostic below */ }
    if (!hasExactKeys(record, ['schema', 'recordId', 'body', 'signatures'])
      || record.schema !== 'loom.image-provenance.record-envelope/v1'
      || !Array.isArray(record.signatures)
      || !SHA256_PATTERN.test(record.recordId ?? '')
      || !bodyShape.valid
      || computedRecordId !== record.recordId) {
      findings.push(finding(
        computedRecordId === null || computedRecordId === record?.recordId ? 'POLICY_DENIED' : 'HASH_MISMATCH',
        'invalid',
        `Ignored a malformed or ID-mismatched record envelope${bodyShape.errors[0] ? `: ${bodyShape.errors[0]}` : ''}`,
        typeof record?.recordId === 'string' ? { recordId: record.recordId } : {},
      ));
      continue;
    }
    if (!recordsById.has(record.recordId)) {
      recordsById.set(record.recordId, record);
      continue;
    }
    const existing = recordsById.get(record.recordId);
    let sameBody = false;
    try {
      sameBody = existing.schema === record.schema
        && canonicalize(existing.body) === canonicalize(record.body);
    } catch {
      sameBody = false;
    }
    if (!sameBody) {
      conflictingRecordIds.add(record.recordId);
      findings.push(finding('POLICY_DENIED', 'invalid', `Two independently ID-valid bodies collide at record ID: ${record.recordId}`, { recordId: record.recordId }));
      continue;
    }
    const existingSignatures = Array.isArray(existing.signatures) ? existing.signatures : [];
    const incomingSignatures = Array.isArray(record.signatures) ? record.signatures : [];
    const signatureKeys = new Set(existingSignatures.map((signature) => {
      try { return canonicalize(signature); } catch { return null; }
    }));
    const mergedSignatures = [...existingSignatures];
    for (const signature of incomingSignatures) {
      let key = null;
      try { key = canonicalize(signature); } catch { /* verified later if reachable */ }
      if (!signatureKeys.has(key)) {
        signatureKeys.add(key);
        mergedSignatures.push(signature);
      }
    }
    recordsById.set(record.recordId, { ...existing, signatures: mergedSignatures });
  }
  const boundedBundle = resourceLimitExceeded
    ? { schema: bundle?.schema, records: [], journalEntries: [], endorsements: [], anchors: [], blobs: [] }
    : bundle;
  const bytesByDigest = bundleBlobBytes(boundedBundle, blobBytes);
  const acceptedExecutions = new Map();
  for (const [recordId, result] of verifiedExecutions ?? []) {
    if (result?.recordId !== recordId
      || (result.findings ?? []).some((item) => item.status !== 'valid')) {
      findings.push(finding('EXECUTION_UNVERIFIED', 'invalid', 'A supplied execution result is not bound cleanly to its map key', { recordId }));
      continue;
    }
    acceptedExecutions.set(recordId, result);
  }
  const visiting = new Set();
  const visited = new Set();
  const countedArtifacts = new Set();
  const countedCandidateDigests = new Set();
  const artifactByteStatusByIdentity = new Map();
  const producerOutputsByRecordId = new Map();
  let referencedBytes = 0n;
  let verificationBytes = 0n;
  let candidateLimitExceeded = false;
  let graphBroken = false;

  const findProducerOutput = (producer, outputName) => {
    if (!producerOutputsByRecordId.has(producer.recordId)) {
      const outputIndex = new Map();
      for (const candidate of Array.isArray(producer.body?.outputs) ? producer.body.outputs : []) {
        if (!isPlainObject(candidate) || typeof candidate.outputName !== 'string') continue;
        outputIndex.set(candidate.outputName, candidate);
      }
      producerOutputsByRecordId.set(producer.recordId, outputIndex);
    }
    return producerOutputsByRecordId.get(producer.recordId).get(outputName);
  };

  const visit = (recordId, depth) => {
    if (depth > maxDepth) {
      graphBroken = true;
      findings.push(finding('POLICY_DENIED', 'invalid', `Graph exceeds the ${maxDepth} depth limit`, { recordId }));
      return;
    }
    if (visiting.has(recordId)) {
      graphBroken = true;
      findings.push(finding('GRAPH_CYCLE', 'invalid', 'Record graph contains a cycle', { recordId }));
      return;
    }
    if (visited.has(recordId)) return;
    const record = recordsById.get(recordId);
    if (!record) {
      graphBroken = true;
      findings.push(finding('MISSING_PARENT', 'invalid', `Missing producer record: ${recordId}`, { recordId }));
      return;
    }
    if (conflictingRecordIds.has(recordId)) {
      graphBroken = true;
      findings.push(finding('POLICY_DENIED', 'invalid', `Reachable record ID ${recordId} has conflicting bodies`, { recordId }));
      return;
    }
    visiting.add(recordId);

    let structure = true;
    try {
      structure = strictBodyCheck(
        record,
        findings,
        verifiedCriticalExtensions.get(recordId) ?? new Set(),
      );
    } catch (error) {
      structure = false;
      findings.push(finding('POLICY_DENIED', 'invalid', `Record body is outside the canonical value space: ${error.message}`, { recordId }));
    }
    const computedId = structure ? recordIdFor(record.body) : null;
    if (computedId !== record.recordId) {
      structure = false;
      findings.push(finding('HASH_MISMATCH', 'invalid', `Record ID does not match its canonical body (computed ${computedId})`, { recordId }));
    }

    const signatureResult = verifyRecordSignatures(record, trustStore?.keys ?? [], findings, verificationTime);
    const artifactStatuses = [];
    const outputs = structure && Array.isArray(record.body?.outputs) ? record.body.outputs : [];
    for (const output of outputs) {
      const identity = blobKey(output.artifact.blob);
      if (!countedArtifacts.has(identity)) {
        countedArtifacts.add(identity);
        if (/^(?:0|[1-9][0-9]*)$/u.test(output.artifact.blob.byteLength ?? '')) {
          referencedBytes += BigInt(output.artifact.blob.byteLength);
        }
      }
      if (referencedBytes > maxReferencedBytes) {
        artifactStatuses.push('not-present');
        continue;
      }
      const digest = output.artifact.blob.digest;
      if (!countedCandidateDigests.has(digest)) {
        countedCandidateDigests.add(digest);
        const candidates = bytesByDigest.get(digest) ?? [];
        if (candidates.length > maxBlobCandidatesPerDigest) candidateLimitExceeded = true;
        verificationBytes += candidates.reduce((total, candidate) => total + candidateByteLength(candidate), 0n);
      }
      if (candidateLimitExceeded || verificationBytes > maxVerificationBytes) {
        artifactStatuses.push('not-present');
        continue;
      }
      const byteVerificationIdentity = `${digest}|${output.artifact.blob.byteLength}`;
      if (!artifactByteStatusByIdentity.has(byteVerificationIdentity)) {
        artifactByteStatusByIdentity.set(
          byteVerificationIdentity,
          verifyArtifactBytes(output.artifact, bytesByDigest, findings, recordId, output.outputName),
        );
      }
      artifactStatuses.push(artifactByteStatusByIdentity.get(byteVerificationIdentity));
    }

    const inputs = structure && Array.isArray(record.body?.inputs) ? record.body.inputs : [];
    for (const edge of inputs) {
      const producer = recordsById.get(edge.producerRecordId);
      if (!producer) {
        graphBroken = true;
        findings.push(finding('MISSING_PARENT', 'invalid', `Input role ${edge.role} names a missing producer`, { recordId }));
        continue;
      }
      const output = findProducerOutput(producer, edge.producerOutputName);
      if (!output) {
        graphBroken = true;
        findings.push(finding('MISSING_OUTPUT', 'invalid', `Producer has no output named ${edge.producerOutputName}`, { recordId }));
      } else if (artifactKey(output.artifact) !== artifactKey(edge.expectedArtifact)) {
        graphBroken = true;
        findings.push(finding('EDGE_ARTIFACT_MISMATCH', 'invalid', `Input role ${edge.role} does not repeat its producer's exact artifact reference`, { recordId }));
      }
      visit(edge.producerRecordId, depth + 1);
    }

    const verifiedExecution = acceptedExecutions.get(recordId);
    const operationResult = verifiedOperations.get(recordId);
    let operationSemantics = 'not-present';
    if (structure && record.body?.kind === 'transform') {
      const operationBound = operationResult?.recordId === recordId
        && operationResult?.descriptorDigest === record.body.subject.operation.descriptorDigest;
      const operationFindings = operationResult?.findings ?? [];
      for (const operationFinding of operationFindings) {
        findings.push({ ...operationFinding, recordId: operationFinding.recordId ?? recordId });
      }
      const operationClean = operationBound
        && operationResult.status === 'valid'
        && operationFindings.every((item) => item.status === 'valid');
      if (operationClean) {
        operationSemantics = 'valid';
      } else {
        const status = !operationBound && operationResult
          ? 'invalid'
          : operationResult?.status !== 'valid'
            ? ['invalid', 'indeterminate', 'unsupported'].includes(operationResult?.status)
              ? operationResult.status
              : 'unsupported'
            : mergeStatus(operationFindings.map((item) => item.status).filter((item) => item !== 'valid'));
        operationSemantics = operationResult
          ? status === 'not-present' ? 'unsupported' : status
          : 'not-present';
        findings.push(finding('OPERATION_UNVERIFIED', status, 'Transform operation descriptor, roles, or parameters were not verified for this exact record', { recordId, blocksVerdict: true }));
      }
    }
    recordResults.set(recordId, {
      recordId,
      structure: structure ? 'valid' : 'invalid',
      signature: signatureResult.signature,
      signerTrust: signatureResult.signerTrust,
      artifacts: mergeStatus(artifactStatuses),
      operationSemantics,
      execution: record.body?.kind === 'transform'
        ? verifiedExecution?.execution
          ?? 'declared'
        : 'declared',
    });
    visiting.delete(recordId);
    visited.add(recordId);
  };

  const rootRecord = recordsById.get(selectedRoot.recordId);
  if (!rootRecord) {
    graphBroken = true;
    findings.push(finding('MISSING_PARENT', 'invalid', 'Selected root record is missing', { recordId: selectedRoot.recordId }));
  } else if (!Array.isArray(rootRecord.body?.outputs)
    || !rootRecord.body.outputs.some((output) => output?.outputName === selectedRoot.outputName)) {
    graphBroken = true;
    findings.push(finding('MISSING_OUTPUT', 'invalid', 'Selected root output is missing', selectedRoot));
  }
  visit(selectedRoot.recordId, 0);

  if (referencedBytes > maxReferencedBytes) {
    findings.push(finding('POLICY_DENIED', 'invalid', `Reachable artifacts exceed the ${maxReferencedBytes} byte verification limit`, { blocksVerdict: true }));
  }
  if (candidateLimitExceeded) {
    findings.push(finding('POLICY_DENIED', 'invalid', `A reachable blob exceeds the ${maxBlobCandidatesPerDigest} candidate-location limit`, { blocksVerdict: true }));
  }
  if (verificationBytes > maxVerificationBytes) {
    findings.push(finding('POLICY_DENIED', 'invalid', `Reachable blob candidates exceed the ${maxVerificationBytes} byte hashing limit`, { blocksVerdict: true }));
  }

  // Dependency ancestry follows both edge kinds for integrity. Content ancestry
  // deliberately follows only `consumes`; a camera artifact used as a model,
  // mask, or other resource cannot launder unrelated output into camera origin.
  const contentVisited = new Set();
  const contentRoots = [];
  const contentStack = [selectedRoot.recordId];
  while (contentStack.length > 0) {
    const recordId = contentStack.pop();
    if (contentVisited.has(recordId)) continue;
    contentVisited.add(recordId);
    const record = recordsById.get(recordId);
    if (!record || recordResults.get(recordId)?.structure !== 'valid') continue;
    const consumes = record.body.inputs.filter((edge) => edge.relation === 'consumes');
    if (consumes.length === 0) {
      contentRoots.push(record);
      if (record.body.kind === 'transform') {
        findings.push(finding('POLICY_DENIED', 'invalid', 'A transform with no consumes ancestry cannot be a content root; represent generated bytes with a SourceRecord', { recordId, blocksVerdict: true }));
      }
      continue;
    }
    for (const edge of consumes) contentStack.push(edge.producerRecordId);
  }

  const captureRecords = [...contentVisited]
    .map((recordId) => recordsById.get(recordId))
    .filter((record) => recordResults.get(record?.recordId)?.structure === 'valid'
      && record.body.kind === 'capture');
  const contentRootVerifications = contentRoots
    .filter((record) => record.body.kind === 'capture' || record.body.kind === 'source')
    .map((record) => ({
      recordId: record.recordId,
      kind: record.body.kind,
      ...(record.body.kind === 'source' ? { sourceType: record.body.subject.sourceType } : {}),
    }))
    .sort((left, right) => left.recordId.localeCompare(right.recordId));
  const hasCaptureContentRoot = contentRootVerifications.some((root) => root.kind === 'capture');
  const hasSourceContentRoot = contentRootVerifications.some((root) => root.kind === 'source');
  const contentComposition = hasCaptureContentRoot && hasSourceContentRoot
    ? 'mixed'
    : hasCaptureContentRoot
      ? 'capture-only'
      : hasSourceContentRoot ? 'source-only' : 'not-reached';
  const dependencyRootKinds = new Set([...visited]
    .map((recordId) => recordsById.get(recordId))
    .filter((record) => recordResults.get(record?.recordId)?.structure === 'valid'
      && (record.body.kind === 'capture' || record.body.kind === 'source'))
    .map((record) => record.body.kind));

  for (const rootKind of dependencyRootKinds) {
    if (!(policy.allowedSourceRoots ?? []).includes(rootKind)) {
      findings.push(finding('POLICY_DENIED', 'invalid', `Policy does not allow ${rootKind} roots`, { blocksVerdict: true }));
    }
  }

  const requiredTrustKinds = new Set(policy.trustedSignatureRequiredFor ?? []);
  for (const result of recordResults.values()) {
    const kind = recordsById.get(result.recordId)?.body?.kind;
    if (requiredTrustKinds.has(kind) && result.signerTrust !== 'valid') {
      const status = result.signerTrust === 'invalid' ? 'invalid' : 'indeterminate';
      findings.push(finding('SIGNER_UNTRUSTED', status, `Policy requires a trusted ${kind} signer`, { recordId: result.recordId, blocksVerdict: true }));
    }
  }

  const captureVerifications = captureRecords.map((capture) => {
    const evidence = verifiedCaptureEvidence.get(capture.recordId);
    const evidenceBound = evidence?.recordId === capture.recordId;
    const expectedOutputDigests = [...new Set(capture.body.outputs
      .map((output) => output.artifact.blob.digest))].sort();
    const coveredOutputDigests = Array.isArray(evidence?.coveredOutputDigests)
      ? evidence.coveredOutputDigests
      : [];
    const outputCoverageComplete = coveredOutputDigests.length === new Set(coveredOutputDigests).size
      && coveredOutputDigests.every((digest) => SHA256_PATTERN.test(digest))
      && sameArray([...coveredOutputDigests].sort(), expectedOutputDigests);
    const tierConsistent = evidence?.originAssurance === 'self-declared'
      || (evidence?.originAssurance === 'app-attested' && evidence.appIdentity === 'valid')
      || (evidence?.originAssurance === 'os-attested' && evidence.osBinding === 'valid')
      || (evidence?.originAssurance === 'sensor-path-attested' && evidence.sensorBinding === 'valid');
    const evidenceClean = evidenceBound
      && evidence.status === 'valid'
      && tierConsistent
      && outputCoverageComplete
      && (evidence.findings ?? []).every((item) => item.status === 'valid');
    if (evidence && !evidenceBound) {
      findings.push(finding('ATTESTATION_INVALID', 'invalid', 'Capture evidence result is bound to a different record', { recordId: capture.recordId }));
    }
    if (evidenceBound && !tierConsistent) {
      findings.push(finding('ATTESTATION_INVALID', 'invalid', 'Capture evidence assurance contradicts its orthogonal component checks', { recordId: capture.recordId }));
    }
    if (evidenceBound && !outputCoverageComplete) {
      findings.push(finding('ATTESTATION_INVALID', 'invalid', 'Capture evidence does not cover every output digest in the capture record', { recordId: capture.recordId }));
    }
    if (evidenceBound) {
      for (const evidenceFinding of evidence.findings ?? []) {
        findings.push({ ...evidenceFinding, recordId: evidenceFinding.recordId ?? capture.recordId });
      }
    }
    const assured = evidenceClean
      && ORIGIN_ASSURANCE.has(evidence.originAssurance)
      ? evidence.originAssurance
      : 'self-declared';
    if (!assuranceAtLeast(assured, policy.minimumOriginAssurance)) {
      findings.push(finding('ATTESTATION_INVALID', 'indeterminate', `Capture establishes ${assured}, below required ${policy.minimumOriginAssurance}`, { recordId: capture.recordId, blocksVerdict: true }));
    }
    const failedEvidenceStatus = evidenceBound && !evidenceClean
      ? ['invalid', 'unsupported', 'indeterminate'].includes(evidence.status)
        ? evidence.status
        : 'indeterminate'
      : null;
    const boundaryResult = verifiedCaptureBoundaries.get(capture.recordId);
    const boundaryBound = boundaryResult?.recordId === capture.recordId;
    const boundaryClean = boundaryBound
      && boundaryResult.status === 'valid'
      && (boundaryResult.findings ?? []).every((item) => item.status === 'valid');
    if (boundaryBound) {
      for (const boundaryFinding of boundaryResult.findings ?? []) {
        findings.push({ ...boundaryFinding, recordId: boundaryFinding.recordId ?? capture.recordId });
      }
    }
    const boundaryBinding = boundaryClean
      ? 'valid'
      : boundaryBound && ['invalid', 'unsupported', 'indeterminate'].includes(boundaryResult.status)
        ? boundaryResult.status
        : 'not-present';
    if (policy.requireVerifiedCaptureBoundary && boundaryBinding !== 'valid') {
      findings.push(finding('ATTESTATION_INVALID', boundaryBinding === 'invalid' ? 'invalid' : 'unsupported', 'No accepted serialization profile binds every capture output to the declared acquisition boundary', { recordId: capture.recordId, blocksVerdict: true }));
    }
    return {
      recordId: capture.recordId,
      acquisitionBoundary: capture.body.subject.acquisition.boundary,
      originAssurance: assured,
      boundaryBinding,
      appIdentity: evidenceClean ? evidence.appIdentity : failedEvidenceStatus ?? 'not-present',
      osBinding: evidenceClean ? evidence.osBinding : failedEvidenceStatus ?? 'not-present',
      keyProtection: evidenceClean ? evidence.keyProtection : failedEvidenceStatus ?? 'not-present',
      sensorBinding: evidenceClean ? evidence.sensorBinding : failedEvidenceStatus ?? 'not-present',
      freshness: evidenceClean
        ? evidence.freshness
        : failedEvidenceStatus ?? (capture.body.subject.challenge ? 'indeterminate' : 'not-present'),
      time: evidenceClean ? evidence.time : failedEvidenceStatus ?? 'not-present',
      location: evidenceClean
        ? evidence.location
        : failedEvidenceStatus ?? (capture.body.subject.locationClaim === undefined ? 'not-present' : 'indeterminate'),
    };
  }).sort((left, right) => left.recordId.localeCompare(right.recordId));
  if (captureRecords.length === 0 && policy.minimumOriginAssurance !== 'self-declared') {
    findings.push(finding('ATTESTATION_INVALID', 'indeterminate', 'No camera capture root is reachable', { blocksVerdict: true }));
  }
  const weakestOriginAssurance = captureVerifications.length === 0
    ? 'not-reached'
    : captureVerifications.reduce((weakest, capture) => (
      ORIGIN_ASSURANCE.get(capture.originAssurance) < ORIGIN_ASSURANCE.get(weakest)
        ? capture.originAssurance
        : weakest
    ), captureVerifications[0].originAssurance);
  const allCapturesSatisfyMinimum = captureVerifications.length === 0
    ? policy.minimumOriginAssurance === 'self-declared' ? 'not-present' : 'indeterminate'
    : captureVerifications.every((capture) => assuranceAtLeast(capture.originAssurance, policy.minimumOriginAssurance))
      ? 'valid'
      : 'indeterminate';

  const journalResult = verifyJournal({
    bundle: boundedBundle,
    recordsById,
    reachableRecordIds: visited,
    trustedKeys: trustStore?.keys ?? [],
    verificationTime,
    verifiedAnchorResults,
    acceptedWitnessProfiles: trustStore?.acceptedWitnessProfiles ?? [],
    policy,
    findings,
  });

  for (const record of recordsById.values()) {
    if (!visited.has(record.recordId)) {
      // Unreachable records are deliberately outside the trust decision.
      continue;
    }
    if (recordResults.get(record.recordId)?.structure !== 'valid') continue;
    if (record.body.kind === 'transform') {
      if (policy.requireDisclosedParameters && record.body.subject.parameters?.disclosure !== 'inline') {
        findings.push(finding('POLICY_DENIED', 'invalid', 'Policy requires disclosed transform parameters', { recordId: record.recordId, blocksVerdict: true }));
      }
      const verifiedExecution = acceptedExecutions.get(record.recordId);
      if (policy.requireHermeticTransforms) {
        if (record.body.subject.isolation !== 'hermetic') {
          findings.push(finding('POLICY_DENIED', 'invalid', 'Policy requires the transform to declare hermetic isolation', { recordId: record.recordId, blocksVerdict: true }));
        } else if (verifiedExecution?.hermeticity === 'invalid') {
          findings.push(finding('POLICY_DENIED', 'invalid', 'Verified execution evidence contradicts the hermeticity claim', { recordId: record.recordId, blocksVerdict: true }));
        } else if (verifiedExecution?.hermeticity !== 'valid') {
          findings.push(finding('EXECUTION_UNVERIFIED', 'indeterminate', 'The signed hermeticity field is only a claim; no accepted execution proof established it', { recordId: record.recordId, blocksVerdict: true }));
        }
      }
      const replayClaim = record.body.subject.replay?.claim;
      const replaySatisfied = replayClaim === 'bit-exact'
        ? verifiedExecution?.execution === 'replayed-exact'
        : replayClaim === 'tolerance-defined'
          ? verifiedExecution?.execution === 'replayed-within-tolerance'
            && verifiedExecution.toleranceProfileDigest === record.body.subject.replay.toleranceProfileDigest
          : false;
      if (!replaySatisfied && (policy.replayRequirement === 'every-transform'
        || (policy.replayRequirement === 'when-claimed' && replayClaim !== 'non-replayable'))) {
        findings.push(finding('REPLAY_MISMATCH', 'indeterminate', 'This reference pass did not receive a verified replay result', { recordId: record.recordId, blocksVerdict: true }));
      }
    }
  }

  const reachableResults = [...recordResults.values()];
  const structural = graphBroken || reachableResults.some((result) => result.structure === 'invalid') ? 'invalid' : 'valid';
  const byteIntegrity = mergeStatus(reachableResults.map((result) => result.artifacts));
  const signatures = mergeStatus(reachableResults.map((result) => result.signature));
  // Signatures and endorsements are additive envelopes. A junk optional proof
  // must not let a third party invalidate an otherwise sufficient proof set.
  // Reject from aggregate required facts and policy failures, not merely from
  // the presence of an invalid optional attachment finding.
  const hardInvalid = structural === 'invalid'
    || byteIntegrity === 'invalid'
    || signatures === 'invalid'
    || findings.some((item) => item[VERDICT_BLOCKER] && item.status === 'invalid');
  const unresolvedPolicy = byteIntegrity === 'indeterminate'
    || byteIntegrity === 'unsupported'
    || signatures === 'unsupported'
    || findings.some((item) => item[VERDICT_BLOCKER]
      && (item.status === 'indeterminate' || item.status === 'unsupported'));
  const verdict = hardInvalid ? 'reject' : unresolvedPolicy ? 'indeterminate' : 'accept';
  return {
    schema: 'loom.image-provenance.verification-report/v1',
    verdict,
    rootOutput: selectedRoot,
    structural,
    byteIntegrity,
    signatures,
    lineage: structural === 'invalid' ? 'broken' : 'complete',
    anchoring: journalResult.anchoring,
    captureEvidence: {
      contentRoots: contentRootVerifications,
      contentComposition,
      captures: captureVerifications,
      minimumRequired: policy.minimumOriginAssurance,
      weakestOriginAssurance,
      allCapturesSatisfyMinimum,
    },
    records: reachableResults,
    findings,
  };
}

/**
 * Hostile wire objects should produce a diagnostic report, not escape as an
 * exception. Trust-configuration and preverified inputs are still caller-owned
 * test seams; see verifyDiagnosticBundleInternal's warning above.
 */
export function verifyDiagnosticBundle(request) {
  try {
    return verifyDiagnosticBundleInternal(request ?? {});
  } catch (error) {
    const root = validateWire('#/$defs/outputPointer', request?.rootOutput).valid
      ? request.rootOutput
      : {
        recordId: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        outputName: '',
      };
    const minimumRequired = ORIGIN_ASSURANCE.has(request?.policy?.minimumOriginAssurance)
      ? request.policy.minimumOriginAssurance
      : 'self-declared';
    return {
      schema: 'loom.image-provenance.verification-report/v1',
      verdict: 'reject',
      rootOutput: root,
      structural: 'invalid',
      byteIntegrity: 'not-present',
      signatures: 'not-present',
      lineage: 'broken',
      anchoring: 'not-present',
      captureEvidence: {
        contentRoots: [],
        contentComposition: 'not-reached',
        captures: [],
        minimumRequired,
        weakestOriginAssurance: 'not-reached',
        allCapturesSatisfyMinimum: minimumRequired === 'self-declared' ? 'not-present' : 'indeterminate',
      },
      records: [],
      findings: [finding(
        'POLICY_DENIED',
        'invalid',
        `Diagnostic verification stopped safely on malformed input: ${error instanceof Error ? error.message : String(error)}`,
        { blocksVerdict: true },
      )],
    };
  }
}

export function exactBlob(bytes, mediaType) {
  return {
    digest: sha256Digest(bytes),
    byteLength: String(bytes.byteLength),
    mediaType,
  };
}

export function blobIdentity(blob) {
  return blobKey(blob);
}
