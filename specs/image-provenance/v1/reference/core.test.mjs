import assert from 'node:assert/strict';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  anchorReceiptDigestFor,
  canonicalize,
  exactBlob,
  JOURNAL_SIGNATURE_DOMAIN,
  journalEntryIdFor,
  keyFingerprintFor,
  recordIdFor,
  signRecord,
  signatureStatementFor,
  verifyDiagnosticBundle,
} from './core.mjs';
import { createSchemaValidator } from './schema-validator.mjs';

const TEST_SEED = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const privateKey = createPrivateKey({
  key: Buffer.concat([PKCS8_PREFIX, TEST_SEED]),
  type: 'pkcs8',
  format: 'der',
});
const publicKey = createPublicKey(privateKey);
const publicKeyValue = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const keyFingerprint = keyFingerprintFor(publicKey);
const exampleBundle = JSON.parse(readFileSync(
  new URL('../examples/linear-bundle.json', import.meta.url),
  'utf8',
));
const wireSchema = JSON.parse(readFileSync(
  new URL('../schema/bundle.schema.json', import.meta.url),
  'utf8',
));
const validateWire = createSchemaValidator(wireSchema);

const actor = {
  id: 'urn:test:loom-recorder',
  software: {
    name: 'Loom contract test recorder',
    version: '1.0.0',
  },
};

function artifact(bytes, mediaType = 'image/heic', representation = 'encoded-image') {
  return { blob: exactBlob(bytes, mediaType), representation };
}

function captureBody(outputArtifact) {
  return {
    schema: 'loom.image-provenance.capture/v1',
    kind: 'capture',
    occurredAt: '2026-09-02T19:30:00Z',
    actor,
    inputs: [],
    outputs: [{ outputName: 'camera-output', role: 'primary', artifact: outputArtifact }],
    evidenceRefs: [],
    subject: {
      sessionId: 'test-session-01',
      shotSequence: '1',
      challenge: {
        issuer: 'https://verifier.example.test',
        audience: 'loom-contract-tests',
        nonce: 'AAECAwQFBgcICQ',
        issuedAt: '2026-09-02T19:29:59Z',
        expiresAt: '2026-09-02T19:30:29Z',
      },
      acquisition: {
        boundary: 'os-encoded-asset',
        providerUri: 'urn:test:camera-provider',
        providerVersion: '1.0.0',
        serializationProfileUri: 'urn:loom:image-provenance:encoded-file-bytes:v1',
        digitalSourceTypeUri: 'http://cv.iptc.org/newscodes/digitalsourcetype/computationalCapture',
        upstreamProcessing: 'opaque',
      },
      deviceTimeClaim: '2026-09-02T19:30:00Z',
    },
  };
}

function sourceBody(outputArtifact) {
  return {
    schema: 'loom.image-provenance.source/v1',
    kind: 'source',
    occurredAt: '2026-09-02T19:30:01Z',
    actor,
    inputs: [],
    outputs: [{ outputName: 'mask', role: 'mask', artifact: outputArtifact }],
    evidenceRefs: [],
    subject: {
      sourceType: 'imported',
      description: 'Deterministic test mask',
    },
  };
}

function transformBody({ inputs, outputArtifact, parameters = { disclosure: 'inline', value: { exposureEv: { $type: 'decimal', coefficient: '5', scale: '-1' } } } }) {
  return {
    schema: 'loom.image-provenance.transform/v1',
    kind: 'transform',
    occurredAt: '2026-09-02T19:30:02Z',
    actor,
    inputs,
    outputs: [{ outputName: 'render', role: 'primary', artifact: outputArtifact }],
    evidenceRefs: [],
    subject: {
      operation: {
        uri: 'urn:test:operation:tone-map',
        version: '1.0.0',
        descriptorDigest: exactBlob(Buffer.from('operation descriptor'), 'application/json').digest,
      },
      parameters,
      implementation: {
        kind: 'wasm',
        name: 'test-enhancer',
        version: '1.0.0',
        digest: exactBlob(Buffer.from('test wasm bytes'), 'application/wasm').digest,
      },
      isolation: 'hermetic',
      replay: { claim: 'bit-exact' },
      executionEvidenceRefs: [],
    },
  };
}

function inputEdge(record, outputName, role, relation = 'consumes') {
  const output = record.body.outputs.find((candidate) => candidate.outputName === outputName);
  assert(output);
  return {
    role,
    relation,
    producerRecordId: record.recordId,
    producerOutputName: outputName,
    expectedArtifact: output.artifact,
  };
}

function signJournalBody(body) {
  const entryId = journalEntryIdFor(body);
  const statement = {
    domain: JOURNAL_SIGNATURE_DOMAIN,
    entryId,
    purpose: 'journal-append',
    suite: 'Ed25519',
    signerKeyFingerprint: keyFingerprint,
  };
  return {
    schema: 'loom.image-provenance.journal-envelope/v1',
    entryId,
    body,
    signatures: [{
      statement,
      signature: cryptoSign(null, Buffer.from(canonicalize(statement)), privateKey).toString('base64url'),
      inlinePublicKey: { format: 'spki-der', value: publicKeyValue },
    }],
  };
}

function policy(overrides = {}) {
  return {
    schema: 'loom.image-provenance.verification-policy/v1',
    trustedSignatureRequiredFor: ['capture', 'source', 'transform'],
    allowedSourceRoots: ['capture', 'source'],
    minimumOriginAssurance: 'self-declared',
    requireVerifiedCaptureBoundary: false,
    requireEveryReachableRecordAnchored: false,
    requireJournalConsistency: false,
    requireDisclosedParameters: true,
    requireHermeticTransforms: false,
    replayRequirement: 'none',
    limits: {
      maxBundleObjects: '1000',
      maxRecords: '100',
      maxDepth: '20',
      maxReferencedBytes: '1048576',
      maxBlobCandidatesPerDigest: '8',
      maxVerificationBytes: '8388608',
    },
    ...overrides,
  };
}

const trustStore = {
  keys: [{
    fingerprint: keyFingerprint,
    purposes: ['capture-origin', 'source-ingest', 'transform-executor', 'journal-append'],
    publicKey: { format: 'spki-der', value: publicKeyValue },
  }],
  acceptedEvidenceProfiles: [],
  acceptedWitnessProfiles: [],
};

function verifiedOperationsFor(bundle) {
  return new Map((bundle?.records ?? [])
    .filter((record) => record?.body?.kind === 'transform')
    .map((record) => [record.recordId, {
      recordId: record.recordId,
      descriptorDigest: record.body.subject.operation.descriptorDigest,
      status: 'valid',
      findings: [],
    }]));
}

function fixture({ multiInput = false, multiCapture = false } = {}) {
  const cameraBytes = Buffer.from('camera-output-byte-vector-v1');
  const secondCameraBytes = Buffer.from('camera-output-byte-vector-v2');
  const maskBytes = Buffer.from('mask-byte-vector-v1');
  const renderBytes = Buffer.from(multiInput ? 'composite-render-byte-vector-v1' : 'tone-render-byte-vector-v1');
  const capture = signRecord(captureBody(artifact(cameraBytes)), { privateKey, publicKey });
  const secondCaptureBody = captureBody(artifact(secondCameraBytes));
  secondCaptureBody.subject.sessionId = 'test-session-02';
  const secondCapture = multiCapture
    ? signRecord(secondCaptureBody, { privateKey, publicKey })
    : null;
  const source = multiInput ? signRecord(sourceBody(artifact(maskBytes, 'image/png', 'mask')), { privateKey, publicKey }) : null;
  const inputs = [inputEdge(capture, 'camera-output', 'primary')];
  if (secondCapture) inputs.push(inputEdge(secondCapture, 'camera-output', 'secondary'));
  if (source) inputs.push(inputEdge(source, 'mask', 'mask', 'uses'));
  const transform = signRecord(transformBody({ inputs, outputArtifact: artifact(renderBytes, 'image/png') }), { privateKey, publicKey });
  const records = [transform, ...(source ? [source] : []), ...(secondCapture ? [secondCapture] : []), capture];
  const bytes = new Map([
    [capture.body.outputs[0].artifact.blob.digest, cameraBytes],
    [transform.body.outputs[0].artifact.blob.digest, renderBytes],
  ]);
  if (source) bytes.set(source.body.outputs[0].artifact.blob.digest, maskBytes);
  if (secondCapture) bytes.set(secondCapture.body.outputs[0].artifact.blob.digest, secondCameraBytes);
  return {
    capture,
    secondCapture,
    source,
    transform,
    blobBytes: bytes,
    rootOutput: { recordId: transform.recordId, outputName: 'render' },
    bundle: {
      schema: 'loom.image-provenance.bundle/v1',
      records,
      journalEntries: [],
      endorsements: [],
      anchors: [],
      blobs: [],
      suggestedRoots: [{ recordId: transform.recordId, outputName: 'render' }],
    },
  };
}

function verify(item, overrides = {}) {
  return verifyDiagnosticBundle({
    rootOutput: item.rootOutput,
    bundle: item.bundle,
    policy: policy(),
    trustStore,
    blobBytes: item.blobBytes,
    verifiedOperations: verifiedOperationsFor(item.bundle),
    ...overrides,
  });
}

test('canonical v1 values forbid JSON numbers and preserve array order', () => {
  assert.equal(canonicalize({ z: 'last', a: ['first', 'second'] }), '{"a":["first","second"],"z":"last"}');
  assert.throws(() => canonicalize({ unsafe: 0.5 }), /JSON number/u);
  assert.throws(() => canonicalize({ text: 'e\u0301' }), /Unicode NFC/u);
  assert.throws(() => canonicalize({ $type: 'unknown' }), /reserved \$type/u);
  assert.throws(() => canonicalize({ $type: 'decimal', coefficient: '01', scale: '0' }), /canonical decimal/u);
});

test('wire lexical validation checks real RFC 3339 dates and full media-type tchar', () => {
  for (const timestamp of [
    '2000-02-29T23:59:59Z',
    '2024-02-29T00:00:00.123-07:30',
  ]) {
    assert.equal(validateWire('#/$defs/timestamp', timestamp).valid, true, timestamp);
  }
  for (const timestamp of [
    '1900-02-29T00:00:00Z',
    '2026-02-31T00:00:00Z',
    '2026-04-31T00:00:00Z',
  ]) {
    assert.equal(validateWire('#/$defs/timestamp', timestamp).valid, false, timestamp);
  }
  assert.equal(validateWire('#/$defs/mediaType', "application/vnd.loom%25'*+.^_`|~-json").valid, true);
  assert.equal(validateWire('#/$defs/mediaType', 'image/png; charset=utf-8; note="a\\"b"').valid, true);
  assert.equal(validateWire('#/$defs/mediaType', 'image/png; =oops').valid, false);
  assert.equal(validateWire('#/$defs/mediaType', 'image/png; charset =utf-8').valid, false);
  assert.equal(validateWire('#/$defs/uri', 'https://example.test/%C3%A9').valid, true);
  assert.equal(validateWire('#/$defs/uri', 'https://example.test/é').valid, false);
  assert.equal(validateWire('#/$defs/uri', 'https://example.test/%ZZ').valid, false);
});

test('invalid signed media-type parameters fail record structure', () => {
  const item = fixture();
  item.capture.body.outputs[0].artifact.blob.mediaType = 'image/png; =oops';
  const resigned = signRecord(item.capture.body, { privateKey, publicKey });
  item.capture.recordId = resigned.recordId;
  item.capture.signatures = resigned.signatures;
  item.transform.body.inputs[0].producerRecordId = resigned.recordId;
  item.transform.body.inputs[0].expectedArtifact = item.capture.body.outputs[0].artifact;
  const resignedTransform = signRecord(item.transform.body, { privateKey, publicKey });
  item.transform.recordId = resignedTransform.recordId;
  item.transform.signatures = resignedTransform.signatures;
  item.rootOutput.recordId = resignedTransform.recordId;
  item.bundle.suggestedRoots[0].recordId = resignedTransform.recordId;
  const report = verify(item);
  assert.equal(report.verdict, 'reject');
  assert(report.findings.some((entry) => entry.code === 'POLICY_DENIED'
    && entry.message.includes('malformed or ID-mismatched record envelope')));
});

test('a signed linear capture-to-transform graph verifies from an explicit root', () => {
  const item = fixture();
  const report = verify(item);
  assert.equal(report.verdict, 'accept');
  assert.equal(report.lineage, 'complete');
  assert.equal(report.byteIntegrity, 'valid');
  assert.equal(report.signatures, 'valid');
  assert.equal(report.captureEvidence.weakestOriginAssurance, 'self-declared');
});

test('record array order has no lineage meaning', () => {
  const item = fixture();
  item.bundle.records.reverse();
  assert.equal(verify(item).verdict, 'accept');
});

test('a multi-input composite verifies every content and resource edge', () => {
  const item = fixture({ multiInput: true });
  const report = verify(item);
  assert.equal(report.verdict, 'accept');
  assert.equal(report.records.length, 3);
});

test('one changed output byte fails the hard binding', () => {
  const item = fixture();
  const digest = item.transform.body.outputs[0].artifact.blob.digest;
  item.blobBytes.set(digest, Buffer.from('tone-render-byte-vector-v2'));
  const report = verify(item);
  assert.equal(report.verdict, 'reject');
  assert(report.findings.some((entry) => entry.code === 'HASH_MISMATCH'));
});

test('changing a signed parameter without changing the envelope fails the record ID', () => {
  const item = fixture();
  item.transform.body.subject.parameters.value.exposureEv.coefficient = '6';
  const report = verify(item);
  assert.equal(report.verdict, 'reject');
  assert.notEqual(recordIdFor(item.transform.body), item.transform.recordId);
});

test('deleting a producer breaks graph closure', () => {
  const item = fixture();
  item.bundle.records = [item.transform];
  const report = verify(item);
  assert.equal(report.verdict, 'reject');
  assert.equal(report.lineage, 'broken');
  assert(report.findings.some((entry) => entry.code === 'MISSING_PARENT'));
});

test('a mismatched producer output commitment is rejected', () => {
  const item = fixture();
  item.transform.body.inputs[0].expectedArtifact = artifact(Buffer.from('different bytes'));
  const resigned = signRecord(item.transform.body, { privateKey, publicKey });
  item.transform.recordId = resigned.recordId;
  item.transform.signatures = resigned.signatures;
  item.rootOutput.recordId = resigned.recordId;
  item.bundle.suggestedRoots[0].recordId = resigned.recordId;
  const report = verify(item);
  assert.equal(report.verdict, 'reject');
  assert(report.findings.some((entry) => entry.code === 'EDGE_ARTIFACT_MISMATCH'));
});

test('an inline public key verifies integrity but does not create trust', () => {
  const item = fixture();
  const report = verify(item, { trustStore: { ...trustStore, keys: [] } });
  assert.equal(report.verdict, 'indeterminate');
  assert(report.findings.some((entry) => entry.code === 'SIGNER_UNTRUSTED'));
});

test('a known-revoked sole required signer is a definite policy failure', () => {
  const item = fixture();
  const report = verify(item, {
    verificationTime: '2026-09-02T20:00:00Z',
    trustStore: {
      ...trustStore,
      keys: trustStore.keys.map((key) => ({ ...key, revokedAt: '2026-09-02T19:59:00Z' })),
    },
  });
  assert.equal(report.verdict, 'reject');
  assert(report.findings.some((entry) => entry.code === 'SIGNER_REVOKED'));
});

test('an added unknown signature cannot improve a revoked required signer', () => {
  const item = fixture();
  const other = generateKeyPairSync('ed25519');
  item.transform.signatures.push(signRecord(item.transform.body, {
    privateKey: other.privateKey,
    publicKey: other.publicKey,
  }).signatures[0]);
  const report = verify(item, {
    verificationTime: '2026-09-02T20:00:00Z',
    trustStore: {
      ...trustStore,
      keys: trustStore.keys.map((key) => ({ ...key, revokedAt: '2026-09-02T19:59:00Z' })),
    },
  });
  assert.equal(report.verdict, 'reject');
  assert.equal(report.records.find((record) => record.recordId === item.transform.recordId).signerTrust, 'invalid');
});

test('a configured key without the required purpose is definitively unauthorized', () => {
  const item = fixture();
  const report = verify(item, {
    trustStore: {
      ...trustStore,
      keys: trustStore.keys.map((key) => ({
        ...key,
        purposes: key.purposes.filter((purpose) => purpose !== 'transform-executor'),
      })),
    },
  });
  assert.equal(report.verdict, 'reject');
  assert.equal(report.records.find((record) => record.recordId === item.transform.recordId).signerTrust, 'invalid');
  assert(report.findings.some((entry) => entry.code === 'SIGNER_UNTRUSTED'
    && entry.message.includes('not authorized')));
});

test('an invalid optional signature cannot poison a sufficient valid proof set', () => {
  const item = fixture();
  item.transform.signatures.push({
    ...item.transform.signatures[0],
    signature: 'AA',
  });
  const report = verify(item);
  assert.equal(report.verdict, 'accept');
  assert(report.findings.some((entry) => entry.code === 'SIGNATURE_INVALID'));
});

test('an unverifiable optional operator approval cannot poison a sufficient proof set', () => {
  const item = fixture();
  item.transform.signatures.push({
    statement: signatureStatementFor({
      recordId: item.transform.recordId,
      purpose: 'operator-approval',
      suite: 'Ed25519',
      signerKeyFingerprint: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }),
    signature: 'AA',
  });
  const report = verify(item);
  assert.equal(report.verdict, 'accept');
  assert(report.findings.some((entry) => entry.code === 'SIGNATURE_INVALID'));
});

test('ES256 rejects an ECDSA key on any curve other than P-256', () => {
  const item = fixture();
  const wrongCurve = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const wrongFingerprint = keyFingerprintFor(wrongCurve.publicKey);
  const statement = signatureStatementFor({
    recordId: item.transform.recordId,
    purpose: 'transform-executor',
    suite: 'ES256',
    signerKeyFingerprint: wrongFingerprint,
  });
  item.transform.signatures = [{
    statement,
    signature: cryptoSign('sha256', Buffer.from(canonicalize(statement)), {
      key: wrongCurve.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url'),
    inlinePublicKey: {
      format: 'spki-der',
      value: wrongCurve.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    },
  }];
  const report = verify(item, {
    trustStore: {
      ...trustStore,
      keys: [...trustStore.keys, {
        fingerprint: wrongFingerprint,
        purposes: ['transform-executor'],
        publicKey: item.transform.signatures[0].inlinePublicKey,
      }],
    },
  });
  assert.equal(report.verdict, 'reject');
  assert(report.findings.some((entry) => entry.code === 'SIGNATURE_INVALID'));
});

test('stronger camera-origin policy stays indeterminate without a platform verifier', () => {
  const item = fixture();
  const report = verify(item, { policy: policy({ minimumOriginAssurance: 'sensor-path-attested' }) });
  assert.equal(report.verdict, 'indeterminate');
  assert.equal(report.captureEvidence.captures[0].sensorBinding, 'not-present');
});

test('multi-capture assurance aggregates the weakest source without inferring component facts', () => {
  const item = fixture({ multiCapture: true });
  const report = verify(item, {
    policy: policy({ minimumOriginAssurance: 'sensor-path-attested' }),
    verifiedCaptureEvidence: new Map([[
      item.capture.recordId,
      {
        recordId: item.capture.recordId,
        status: 'valid',
        originAssurance: 'sensor-path-attested',
        coveredOutputDigests: [item.capture.body.outputs[0].artifact.blob.digest],
        appIdentity: 'valid',
        osBinding: 'valid',
        keyProtection: 'not-present',
        sensorBinding: 'valid',
        freshness: 'valid',
        time: 'not-present',
        location: 'not-present',
        findings: [],
      },
    ]]),
  });
  assert.equal(report.verdict, 'indeterminate');
  assert.equal(report.captureEvidence.captures.length, 2);
  assert.equal(report.captureEvidence.weakestOriginAssurance, 'self-declared');
  assert(report.captureEvidence.captures.some((capture) => capture.keyProtection === 'not-present'
    && capture.sensorBinding === 'valid'));
});

test('failed capture evidence cannot promote any component to valid', () => {
  const item = fixture();
  const report = verify(item, {
    verifiedCaptureEvidence: new Map([[
      item.capture.recordId,
      {
        recordId: item.capture.recordId,
        status: 'invalid',
        originAssurance: 'sensor-path-attested',
        coveredOutputDigests: [item.capture.body.outputs[0].artifact.blob.digest],
        appIdentity: 'valid',
        osBinding: 'valid',
        keyProtection: 'valid',
        sensorBinding: 'valid',
        freshness: 'valid',
        time: 'valid',
        location: 'valid',
        findings: [],
      },
    ]]),
  });
  assert.equal(report.captureEvidence.weakestOriginAssurance, 'self-declared');
  assert.equal(report.captureEvidence.captures[0].sensorBinding, 'invalid');
});

test('internally contradictory valid capture evidence cannot promote assurance', () => {
  const item = fixture();
  const report = verify(item, {
    policy: policy({ minimumOriginAssurance: 'sensor-path-attested' }),
    verifiedCaptureEvidence: new Map([[
      item.capture.recordId,
      {
        recordId: item.capture.recordId,
        status: 'valid',
        originAssurance: 'sensor-path-attested',
        coveredOutputDigests: [item.capture.body.outputs[0].artifact.blob.digest],
        appIdentity: 'valid',
        osBinding: 'valid',
        keyProtection: 'valid',
        sensorBinding: 'invalid',
        freshness: 'valid',
        time: 'valid',
        location: 'valid',
        findings: [],
      },
    ]]),
  });
  assert.equal(report.verdict, 'indeterminate');
  assert.equal(report.captureEvidence.weakestOriginAssurance, 'self-declared');
  assert.equal(report.captureEvidence.captures[0].sensorBinding, 'indeterminate');
  assert(report.findings.some((entry) => entry.code === 'ATTESTATION_INVALID'));
});

test('capture assurance requires evidence coverage of every capture output', () => {
  const item = fixture();
  const alternateBytes = Buffer.from('alternate-camera-output-byte-vector-v1');
  const alternateArtifact = artifact(alternateBytes);
  item.capture.body.outputs.push({
    outputName: 'alternate-camera-output',
    role: 'alternate',
    artifact: alternateArtifact,
  });
  const resignedCapture = signRecord(item.capture.body, { privateKey, publicKey });
  item.capture.recordId = resignedCapture.recordId;
  item.capture.signatures = resignedCapture.signatures;
  item.transform.body.inputs[0] = inputEdge(
    item.capture,
    'alternate-camera-output',
    'primary',
  );
  const resignedTransform = signRecord(item.transform.body, { privateKey, publicKey });
  item.transform.recordId = resignedTransform.recordId;
  item.transform.signatures = resignedTransform.signatures;
  item.rootOutput.recordId = resignedTransform.recordId;
  item.bundle.suggestedRoots[0].recordId = resignedTransform.recordId;
  item.blobBytes.set(alternateArtifact.blob.digest, alternateBytes);

  const report = verify(item, {
    policy: policy({ minimumOriginAssurance: 'sensor-path-attested' }),
    verifiedCaptureEvidence: new Map([[
      item.capture.recordId,
      {
        recordId: item.capture.recordId,
        status: 'valid',
        originAssurance: 'sensor-path-attested',
        coveredOutputDigests: [item.capture.body.outputs[0].artifact.blob.digest],
        appIdentity: 'valid',
        osBinding: 'valid',
        keyProtection: 'valid',
        sensorBinding: 'valid',
        freshness: 'valid',
        time: 'valid',
        location: 'not-present',
        findings: [],
      },
    ]]),
  });
  assert.equal(report.verdict, 'indeterminate');
  assert.equal(report.captureEvidence.weakestOriginAssurance, 'self-declared');
  assert(report.findings.some((entry) => entry.code === 'ATTESTATION_INVALID'
    && entry.message.includes('every output digest')));
});

test('mixed capture and source content roots are explicit in the report', () => {
  const item = fixture({ multiInput: true });
  item.transform.body.inputs.find((edge) => edge.role === 'mask').relation = 'consumes';
  const resigned = signRecord(item.transform.body, { privateKey, publicKey });
  item.transform.recordId = resigned.recordId;
  item.transform.signatures = resigned.signatures;
  item.rootOutput.recordId = resigned.recordId;
  item.bundle.suggestedRoots[0].recordId = resigned.recordId;
  const report = verify(item, {
    policy: policy({ minimumOriginAssurance: 'sensor-path-attested' }),
    verifiedCaptureEvidence: new Map([[
      item.capture.recordId,
      {
        recordId: item.capture.recordId,
        status: 'valid',
        originAssurance: 'sensor-path-attested',
        coveredOutputDigests: [item.capture.body.outputs[0].artifact.blob.digest],
        appIdentity: 'valid',
        osBinding: 'valid',
        keyProtection: 'valid',
        sensorBinding: 'valid',
        freshness: 'valid',
        time: 'valid',
        location: 'not-present',
        findings: [],
      },
    ]]),
  });
  assert.equal(report.verdict, 'accept');
  assert.equal(report.captureEvidence.contentComposition, 'mixed');
  assert.deepEqual(new Set(report.captureEvidence.contentRoots.map((root) => root.kind)), new Set(['capture', 'source']));
});

test('capture boundary/output compatibility requires its own verified profile', () => {
  const item = fixture();
  const missing = verify(item, { policy: policy({ requireVerifiedCaptureBoundary: true }) });
  assert.equal(missing.verdict, 'indeterminate');
  assert.equal(missing.captureEvidence.captures[0].boundaryBinding, 'not-present');

  const verified = verify(item, {
    policy: policy({ requireVerifiedCaptureBoundary: true }),
    verifiedCaptureBoundaries: new Map([[
      item.capture.recordId,
      { recordId: item.capture.recordId, status: 'valid', findings: [] },
    ]]),
  });
  assert.equal(verified.verdict, 'accept');
});

test('a signed hermeticity claim is not treated as verified execution evidence', () => {
  const item = fixture();
  const report = verify(item, { policy: policy({ requireHermeticTransforms: true }) });
  assert.equal(report.verdict, 'indeterminate');
  assert(report.findings.some((entry) => entry.code === 'EXECUTION_UNVERIFIED'));

  const withEvidence = verify(item, {
    policy: policy({ requireHermeticTransforms: true }),
    verifiedExecutions: new Map([[
      item.transform.recordId,
      {
        recordId: item.transform.recordId,
        execution: 'proof-verified',
        hermeticity: 'valid',
        findings: [],
      },
    ]]),
  });
  assert.equal(withEvidence.verdict, 'accept');
});

test('operation semantics must bind the exact record and descriptor digest', () => {
  const item = fixture();
  const missing = verify(item, { verifiedOperations: new Map() });
  assert.equal(missing.verdict, 'indeterminate');
  assert.equal(missing.records.find((record) => record.recordId === item.transform.recordId).operationSemantics, 'not-present');

  const invalid = verify(item, {
    verifiedOperations: new Map([[
      item.transform.recordId,
      {
        recordId: item.transform.recordId,
        descriptorDigest: item.capture.body.outputs[0].artifact.blob.digest,
        status: 'valid',
        findings: [],
      },
    ]]),
  });
  assert.equal(invalid.verdict, 'reject');
  assert.equal(invalid.records.find((record) => record.recordId === item.transform.recordId).operationSemantics, 'invalid');
});

test('a uses-only camera dependency cannot launder generated content into sensor origin', () => {
  const item = fixture();
  item.transform.body.inputs[0].relation = 'uses';
  const resigned = signRecord(item.transform.body, { privateKey, publicKey });
  item.transform.recordId = resigned.recordId;
  item.transform.signatures = resigned.signatures;
  item.rootOutput.recordId = resigned.recordId;
  item.bundle.suggestedRoots[0].recordId = resigned.recordId;
  const report = verify(item, {
    policy: policy({ minimumOriginAssurance: 'sensor-path-attested' }),
    verifiedCaptureEvidence: new Map([[
      item.capture.recordId,
      {
        recordId: item.capture.recordId,
        status: 'valid',
        originAssurance: 'sensor-path-attested',
        coveredOutputDigests: [item.capture.body.outputs[0].artifact.blob.digest],
        appIdentity: 'valid',
        osBinding: 'valid',
        keyProtection: 'valid',
        sensorBinding: 'valid',
        freshness: 'valid',
        time: 'valid',
        location: 'not-present',
        findings: [],
      },
    ]]),
  });
  assert.equal(report.verdict, 'reject');
  assert.equal(report.captureEvidence.weakestOriginAssurance, 'not-reached');
  assert(report.findings.some((entry) => entry.code === 'POLICY_DENIED'
    && entry.message.includes('no consumes ancestry')));
});

test('source-root policy also applies to resource-only dependencies', () => {
  const item = fixture({ multiInput: true });
  const report = verify(item, { policy: policy({ allowedSourceRoots: ['capture'] }) });
  assert.equal(report.verdict, 'reject');
  assert(report.findings.some((entry) => entry.code === 'POLICY_DENIED'
    && entry.message.includes('source roots')));
});

test('a non-replayable signed claim remains declared without verified execution evidence', () => {
  const item = fixture();
  item.transform.body.subject.replay = { claim: 'non-replayable', reason: 'vendor service unavailable' };
  const resigned = signRecord(item.transform.body, { privateKey, publicKey });
  item.transform.recordId = resigned.recordId;
  item.transform.signatures = resigned.signatures;
  item.rootOutput.recordId = resigned.recordId;
  item.bundle.suggestedRoots[0].recordId = resigned.recordId;
  const report = verify(item);
  assert.equal(report.verdict, 'accept');
  assert.equal(report.records.find((record) => record.recordId === resigned.recordId).execution, 'declared');
});

test('unknown critical extensions are unsupported, not silently ignored', () => {
  const item = fixture();
  const extensionUri = 'https://example.test/extensions/unknown/v1';
  item.transform.body.extensions = { [extensionUri]: { mode: 'diagnostic' } };
  item.transform.body.criticalExtensions = [extensionUri];
  item.transform.recordId = recordIdFor(item.transform.body);
  item.rootOutput.recordId = item.transform.recordId;
  item.bundle.suggestedRoots[0].recordId = item.transform.recordId;
  item.transform.signatures = signRecord(item.transform.body, { privateKey, publicKey }).signatures;
  const report = verify(item);
  assert.equal(report.verdict, 'indeterminate');
  assert(report.findings.some((entry) => entry.code === 'UNKNOWN_CRITICAL_EXTENSION'));
});

test('unreachable records do not influence a root-scoped verdict', () => {
  const item = fixture();
  const unrelated = signRecord(sourceBody(artifact(Buffer.from('unrelated'))), { privateKey, publicKey });
  unrelated.recordId = 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  item.bundle.records.push(unrelated);
  assert.equal(verify(item).verdict, 'accept');
});

test('an ID-mismatched duplicate cannot poison an ID-valid reachable record', () => {
  const item = fixture();
  const conflicting = structuredClone(item.transform);
  conflicting.body.occurredAt = '2026-09-02T19:30:03Z';
  for (const records of [
    [item.transform, conflicting, item.capture],
    [conflicting, item.transform, item.capture],
  ]) {
    const report = verify(item, { bundle: { ...item.bundle, records } });
    assert.equal(report.verdict, 'accept');
    assert(report.findings.some((entry) => entry.code === 'HASH_MISMATCH'));
  }
});

test('multiple blob locations are order-independent when one matches exactly', () => {
  const item = fixture();
  const output = item.transform.body.outputs[0];
  const correctBytes = item.blobBytes.get(output.artifact.blob.digest);
  item.blobBytes.delete(output.artifact.blob.digest);
  const correct = {
    blob: output.artifact.blob,
    inlineBase64Url: correctBytes.toString('base64url'),
  };
  const wrong = {
    blob: output.artifact.blob,
    inlineBase64Url: Buffer.from('wrong candidate').toString('base64url'),
  };
  for (const blobs of [[wrong, correct], [correct, wrong]]) {
    const report = verify(item, { bundle: { ...item.bundle, blobs } });
    assert.equal(report.verdict, 'accept');
  }
});

test('candidate-count and hashing-byte budgets bound alternative blob work', () => {
  const item = fixture();
  const output = item.transform.body.outputs[0];
  const length = Number(output.artifact.blob.byteLength);
  item.bundle.blobs = Array.from({ length: 8 }, (_, index) => ({
    blob: output.artifact.blob,
    inlineBase64Url: Buffer.alloc(length, index + 1).toString('base64url'),
  }));
  const tooMany = verify(item);
  assert.equal(tooMany.verdict, 'reject');
  assert(tooMany.findings.some((entry) => entry.code === 'POLICY_DENIED'
    && entry.message.includes('candidate-location limit')));

  const byteLimited = verify(fixture(), {
    policy: policy({
      limits: { ...policy().limits, maxVerificationBytes: '1' },
    }),
  });
  assert.equal(byteLimited.verdict, 'reject');
  assert(byteLimited.findings.some((entry) => entry.code === 'POLICY_DENIED'
    && entry.message.includes('byte hashing limit')));
});

test('policy limit decimals are canonical rather than silently normalized', () => {
  const item = fixture();
  const report = verify(item, {
    policy: policy({ limits: { ...policy().limits, maxRecords: '01' } }),
  });
  assert.equal(report.verdict, 'reject');
  assert(report.findings.some((entry) => entry.code === 'POLICY_DENIED'
    && entry.message.includes('maxRecords is missing or noncanonical')));
});

test('malformed hostile reachable objects return reports instead of throwing', () => {
  const malformedBundles = [];
  {
    const item = fixture();
    item.transform.body.outputs.push(null);
    malformedBundles.push({ rootOutput: item.rootOutput, bundle: item.bundle, blobBytes: item.blobBytes });
  }
  {
    const item = fixture();
    item.transform.body.inputs.push(null);
    malformedBundles.push({ rootOutput: item.rootOutput, bundle: item.bundle, blobBytes: item.blobBytes });
  }
  {
    const item = fixture();
    item.transform.body.subject = null;
    malformedBundles.push({ rootOutput: item.rootOutput, bundle: item.bundle, blobBytes: item.blobBytes });
  }
  {
    const item = fixture();
    item.capture.body.outputs = [null];
    malformedBundles.push({ rootOutput: item.rootOutput, bundle: item.bundle, blobBytes: item.blobBytes });
  }
  malformedBundles.push({ rootOutput: null, bundle: null, blobBytes: new Map() });

  for (const candidate of malformedBundles) {
    let report;
    assert.doesNotThrow(() => {
      report = verifyDiagnosticBundle({
        ...candidate,
        policy: policy(),
        trustStore,
      });
    });
    assert.equal(report.verdict, 'reject');
  }

  assert.doesNotThrow(() => {
    const item = fixture();
    const report = verifyDiagnosticBundle({
      ...item,
      policy: policy(),
      trustStore,
      verifiedOperations: null,
    });
    assert.equal(report.verdict, 'reject');
  });
});

test('a trusted final witness transitively anchors a valid signed journal chain', () => {
  const rootOutput = exampleBundle.suggestedRoots[0];
  const finalAnchor = exampleBundle.anchors[0];
  const report = verifyDiagnosticBundle({
    rootOutput,
    bundle: exampleBundle,
    policy: policy({
      requireEveryReachableRecordAnchored: true,
      requireJournalConsistency: true,
      requireHermeticTransforms: false,
    }),
    trustStore: {
      ...trustStore,
      acceptedWitnessProfiles: [finalAnchor.profileUri],
    },
    verifiedOperations: verifiedOperationsFor(exampleBundle),
    verifiedAnchorResults: [{
      anchorReceiptDigest: anchorReceiptDigestFor(finalAnchor),
      profileUri: finalAnchor.profileUri,
      witnessId: finalAnchor.witnessId,
      subjectEntryId: finalAnchor.subjectEntryId,
      inclusion: 'valid',
      consistency: 'valid',
      findings: [],
    }],
  });
  assert.equal(report.verdict, 'accept');
  assert.equal(report.anchoring, 'valid');
});

test('journal verification is independent of bundle array order', () => {
  const bundle = structuredClone(exampleBundle);
  bundle.journalEntries.reverse();
  const anchor = bundle.anchors[0];
  const report = verifyDiagnosticBundle({
    rootOutput: bundle.suggestedRoots[0],
    bundle,
    policy: policy({
      requireEveryReachableRecordAnchored: true,
      requireJournalConsistency: true,
      requireHermeticTransforms: false,
    }),
    trustStore: { ...trustStore, acceptedWitnessProfiles: [anchor.profileUri] },
    verifiedOperations: verifiedOperationsFor(bundle),
    verifiedAnchorResults: [{
      anchorReceiptDigest: anchorReceiptDigestFor(anchor),
      profileUri: anchor.profileUri,
      witnessId: anchor.witnessId,
      subjectEntryId: anchor.subjectEntryId,
      inclusion: 'valid',
      consistency: 'valid',
      findings: [],
    }],
  });
  assert.equal(report.verdict, 'accept');
});

test('an ID-mismatched journal duplicate cannot poison the valid anchored chain', () => {
  const bundle = structuredClone(exampleBundle);
  const hostile = structuredClone(bundle.journalEntries[1]);
  hostile.body.event = {
    kind: 'heads-checkpoint',
    headRecordIds: hostile.body.priorHeads,
  };
  hostile.body.resultingHeads = hostile.body.priorHeads;
  bundle.journalEntries.unshift(hostile);
  const anchor = bundle.anchors[0];
  const report = verifyDiagnosticBundle({
    rootOutput: bundle.suggestedRoots[0],
    bundle,
    policy: policy({
      requireEveryReachableRecordAnchored: true,
      requireJournalConsistency: true,
      requireHermeticTransforms: false,
    }),
    trustStore: { ...trustStore, acceptedWitnessProfiles: [anchor.profileUri] },
    verifiedOperations: verifiedOperationsFor(bundle),
    verifiedAnchorResults: [{
      anchorReceiptDigest: anchorReceiptDigestFor(anchor),
      profileUri: anchor.profileUri,
      witnessId: anchor.witnessId,
      subjectEntryId: anchor.subjectEntryId,
      inclusion: 'valid',
      consistency: 'valid',
      findings: [],
    }],
  });
  assert.equal(report.verdict, 'accept');
  assert(report.findings.some((entry) => entry.code === 'LOG_CONSISTENCY_INVALID'
    && entry.message.includes('ID-mismatched')));
});

test('a known-invalid witness consistency proof rejects required consistency', () => {
  const anchor = exampleBundle.anchors[0];
  const report = verifyDiagnosticBundle({
    rootOutput: exampleBundle.suggestedRoots[0],
    bundle: exampleBundle,
    policy: policy({
      requireEveryReachableRecordAnchored: true,
      requireJournalConsistency: true,
      requireHermeticTransforms: false,
    }),
    trustStore: { ...trustStore, acceptedWitnessProfiles: [anchor.profileUri] },
    verifiedOperations: verifiedOperationsFor(exampleBundle),
    verifiedAnchorResults: [{
      anchorReceiptDigest: anchorReceiptDigestFor(anchor),
      profileUri: anchor.profileUri,
      witnessId: anchor.witnessId,
      subjectEntryId: anchor.subjectEntryId,
      inclusion: 'valid',
      consistency: 'invalid',
      findings: [],
    }],
  });
  assert.equal(report.verdict, 'reject');
  assert.equal(report.anchoring, 'invalid');
});

test('a journal signer explicitly unauthorized by policy cannot satisfy consistency', () => {
  const anchor = exampleBundle.anchors[0];
  const report = verifyDiagnosticBundle({
    rootOutput: exampleBundle.suggestedRoots[0],
    bundle: exampleBundle,
    policy: policy({
      requireEveryReachableRecordAnchored: true,
      requireJournalConsistency: true,
      requireHermeticTransforms: false,
    }),
    trustStore: {
      ...trustStore,
      keys: trustStore.keys.map((key) => ({
        ...key,
        purposes: key.purposes.filter((purpose) => purpose !== 'journal-append'),
      })),
      acceptedWitnessProfiles: [anchor.profileUri],
    },
    verifiedOperations: verifiedOperationsFor(exampleBundle),
    verifiedAnchorResults: [{
      anchorReceiptDigest: anchorReceiptDigestFor(anchor),
      profileUri: anchor.profileUri,
      witnessId: anchor.witnessId,
      subjectEntryId: anchor.subjectEntryId,
      inclusion: 'valid',
      consistency: 'valid',
      findings: [],
    }],
  });
  assert.equal(report.verdict, 'reject');
  assert.equal(report.anchoring, 'invalid');
});

test('a trusted journal fork rejects a policy that requires consistency', () => {
  const bundle = structuredClone(exampleBundle);
  const genesis = bundle.journalEntries.find((entry) => entry.body.sequence === '0');
  const fork = signJournalBody({
    schema: 'loom.image-provenance.journal-entry/v1',
    journalId: genesis.body.journalId,
    sequence: '1',
    previousEntryId: genesis.entryId,
    event: { kind: 'heads-checkpoint', headRecordIds: genesis.body.resultingHeads },
    priorHeads: genesis.body.resultingHeads,
    resultingHeads: genesis.body.resultingHeads,
  });
  bundle.journalEntries.push(fork);
  const anchor = bundle.anchors[0];
  const report = verifyDiagnosticBundle({
    rootOutput: bundle.suggestedRoots[0],
    bundle,
    policy: policy({
      requireEveryReachableRecordAnchored: true,
      requireJournalConsistency: true,
      requireHermeticTransforms: false,
    }),
    trustStore: { ...trustStore, acceptedWitnessProfiles: [anchor.profileUri] },
    verifiedOperations: verifiedOperationsFor(bundle),
    verifiedAnchorResults: [{
      anchorReceiptDigest: anchorReceiptDigestFor(anchor),
      profileUri: anchor.profileUri,
      witnessId: anchor.witnessId,
      subjectEntryId: anchor.subjectEntryId,
      inclusion: 'valid',
      consistency: 'valid',
      findings: [],
    }],
  });
  assert.equal(report.verdict, 'reject');
  assert(report.findings.some((entry) => entry.code === 'LOG_CONSISTENCY_INVALID'
    && entry.status === 'invalid'));
});

test('a trusted fork after an anchored tip still rejects required consistency', () => {
  const bundle = structuredClone(exampleBundle);
  const tip = bundle.journalEntries.find((entry) => entry.entryId === bundle.anchors[0].subjectEntryId);
  assert(tip);

  const checkpointChild = signJournalBody({
    schema: 'loom.image-provenance.journal-entry/v1',
    journalId: tip.body.journalId,
    sequence: String(BigInt(tip.body.sequence) + 1n),
    previousEntryId: tip.entryId,
    event: { kind: 'heads-checkpoint', headRecordIds: tip.body.resultingHeads },
    priorHeads: tip.body.resultingHeads,
    resultingHeads: tip.body.resultingHeads,
  });

  const unrelatedSource = signRecord(sourceBody(artifact(Buffer.from('post-anchor-source'))), {
    privateKey,
    publicKey,
  });
  const forkHeads = [...tip.body.resultingHeads, unrelatedSource.recordId].sort();
  const commitChild = signJournalBody({
    schema: 'loom.image-provenance.journal-entry/v1',
    journalId: tip.body.journalId,
    sequence: String(BigInt(tip.body.sequence) + 1n),
    previousEntryId: tip.entryId,
    event: { kind: 'record-committed', recordId: unrelatedSource.recordId },
    priorHeads: tip.body.resultingHeads,
    resultingHeads: forkHeads,
  });
  bundle.records.push(unrelatedSource);
  bundle.journalEntries.push(checkpointChild, commitChild);

  const anchor = bundle.anchors[0];
  const report = verifyDiagnosticBundle({
    rootOutput: bundle.suggestedRoots[0],
    bundle,
    policy: policy({
      requireEveryReachableRecordAnchored: true,
      requireJournalConsistency: true,
      requireHermeticTransforms: false,
    }),
    trustStore: { ...trustStore, acceptedWitnessProfiles: [anchor.profileUri] },
    verifiedOperations: verifiedOperationsFor(bundle),
    verifiedAnchorResults: [{
      anchorReceiptDigest: anchorReceiptDigestFor(anchor),
      profileUri: anchor.profileUri,
      witnessId: anchor.witnessId,
      subjectEntryId: anchor.subjectEntryId,
      inclusion: 'valid',
      consistency: 'valid',
      findings: [],
    }],
  });
  assert.equal(report.verdict, 'reject');
  assert.equal(report.anchoring, 'invalid');
  assert(report.findings.some((entry) => entry.code === 'LOG_CONSISTENCY_INVALID'
    && entry.status === 'invalid'));
});

test('a trusted fork in an unrelated journal cannot poison a root-scoped verdict', () => {
  const bundle = structuredClone(exampleBundle);
  const sources = ['unrelated-source-a', 'unrelated-source-b'].map((value) => signRecord(
    sourceBody(artifact(Buffer.from(value))),
    { privateKey, publicKey },
  ));
  const unrelatedEntries = sources.map((source) => signJournalBody({
    schema: 'loom.image-provenance.journal-entry/v1',
    journalId: 'urn:test:unrelated-forked-journal',
    sequence: '0',
    previousEntryId: null,
    event: { kind: 'record-committed', recordId: source.recordId },
    priorHeads: [],
    resultingHeads: [source.recordId],
  }));
  bundle.records.push(...sources);
  bundle.journalEntries.push(...unrelatedEntries);

  const anchor = bundle.anchors[0];
  const report = verifyDiagnosticBundle({
    rootOutput: bundle.suggestedRoots[0],
    bundle,
    policy: policy({
      requireEveryReachableRecordAnchored: true,
      requireJournalConsistency: true,
      requireHermeticTransforms: false,
    }),
    trustStore: { ...trustStore, acceptedWitnessProfiles: [anchor.profileUri] },
    verifiedOperations: verifiedOperationsFor(bundle),
    verifiedAnchorResults: [{
      anchorReceiptDigest: anchorReceiptDigestFor(anchor),
      profileUri: anchor.profileUri,
      witnessId: anchor.witnessId,
      subjectEntryId: anchor.subjectEntryId,
      inclusion: 'valid',
      consistency: 'valid',
      findings: [],
    }],
  });
  assert.equal(report.verdict, 'accept');
  assert.equal(report.anchoring, 'valid');
});

test('a witness result cannot be replayed over substituted receipt or checkpoint fields', () => {
  const bundle = structuredClone(exampleBundle);
  const originalAnchor = structuredClone(bundle.anchors[0]);
  bundle.anchors[0].checkpoint = bundle.anchors[0].receipt;
  const report = verifyDiagnosticBundle({
    rootOutput: bundle.suggestedRoots[0],
    bundle,
    policy: policy({
      requireEveryReachableRecordAnchored: true,
      requireJournalConsistency: true,
      requireHermeticTransforms: false,
    }),
    trustStore: {
      ...trustStore,
      acceptedWitnessProfiles: [originalAnchor.profileUri],
    },
    verifiedOperations: verifiedOperationsFor(bundle),
    verifiedAnchorResults: [{
      anchorReceiptDigest: anchorReceiptDigestFor(originalAnchor),
      profileUri: originalAnchor.profileUri,
      witnessId: originalAnchor.witnessId,
      subjectEntryId: originalAnchor.subjectEntryId,
      inclusion: 'valid',
      consistency: 'valid',
      findings: [],
    }],
  });
  assert.notEqual(report.verdict, 'accept');
});

test('contradictory results for one receipt are order-independent and never accepted', () => {
  const anchor = exampleBundle.anchors[0];
  const good = {
    anchorReceiptDigest: anchorReceiptDigestFor(anchor),
    profileUri: anchor.profileUri,
    witnessId: anchor.witnessId,
    subjectEntryId: anchor.subjectEntryId,
    inclusion: 'valid',
    consistency: 'valid',
    findings: [],
  };
  const bad = { ...good, inclusion: 'invalid' };
  const reports = [[bad, good], [good, bad]].map((verifiedAnchorResults) => verifyDiagnosticBundle({
    rootOutput: exampleBundle.suggestedRoots[0],
    bundle: exampleBundle,
    policy: policy({
      requireEveryReachableRecordAnchored: true,
      requireJournalConsistency: true,
      requireHermeticTransforms: false,
    }),
    trustStore: { ...trustStore, acceptedWitnessProfiles: [anchor.profileUri] },
    verifiedOperations: verifiedOperationsFor(exampleBundle),
    verifiedAnchorResults,
  }));
  assert.equal(reports[0].verdict, reports[1].verdict);
  assert.equal(reports[0].anchoring, reports[1].anchoring);
  assert.notEqual(reports[0].verdict, 'accept');
});

test('a verified entry ID cannot be reused with forged journal bodies', () => {
  const bundle = structuredClone(exampleBundle);
  const finalEntry = bundle.journalEntries.at(-1);
  bundle.journalEntries = bundle.records.map((record) => ({
    ...structuredClone(finalEntry),
    body: {
      ...structuredClone(finalEntry.body),
      event: { kind: 'record-committed', recordId: record.recordId },
    },
  }));
  const finalAnchor = bundle.anchors[0];
  const report = verifyDiagnosticBundle({
    rootOutput: bundle.suggestedRoots[0],
    bundle,
    policy: policy({
      requireEveryReachableRecordAnchored: true,
      requireJournalConsistency: true,
      requireHermeticTransforms: false,
    }),
    trustStore: {
      ...trustStore,
      acceptedWitnessProfiles: [finalAnchor.profileUri],
    },
    verifiedOperations: verifiedOperationsFor(bundle),
    verifiedAnchorResults: [{
      anchorReceiptDigest: anchorReceiptDigestFor(finalAnchor),
      profileUri: finalAnchor.profileUri,
      witnessId: finalAnchor.witnessId,
      subjectEntryId: finalAnchor.subjectEntryId,
      inclusion: 'valid',
      consistency: 'valid',
      findings: [],
    }],
  });
  assert.notEqual(report.verdict, 'accept');
  assert(report.findings.some((entry) => entry.code === 'LOG_CONSISTENCY_INVALID'));
});

test('an unsigned junk journal candidate cannot poison sufficient anchored coverage', () => {
  const bundle = structuredClone(exampleBundle);
  bundle.journalEntries.push({
    schema: 'loom.image-provenance.journal-envelope/v1',
    entryId: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    body: {
      schema: 'loom.image-provenance.journal-entry/v1',
      journalId: 'urn:test:hostile-junk',
      sequence: '9',
      previousEntryId: 'sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      event: { kind: 'record-committed', recordId: bundle.suggestedRoots[0].recordId },
      priorHeads: [],
      resultingHeads: [bundle.suggestedRoots[0].recordId],
    },
    signatures: [],
  });
  const anchor = bundle.anchors[0];
  const report = verifyDiagnosticBundle({
    rootOutput: bundle.suggestedRoots[0],
    bundle,
    policy: policy({
      requireEveryReachableRecordAnchored: true,
      requireJournalConsistency: true,
      requireHermeticTransforms: false,
    }),
    trustStore: { ...trustStore, acceptedWitnessProfiles: [anchor.profileUri] },
    verifiedOperations: verifiedOperationsFor(bundle),
    verifiedAnchorResults: [{
      anchorReceiptDigest: anchorReceiptDigestFor(anchor),
      profileUri: anchor.profileUri,
      witnessId: anchor.witnessId,
      subjectEntryId: anchor.subjectEntryId,
      inclusion: 'valid',
      consistency: 'valid',
      findings: [],
    }],
  });
  assert.equal(report.verdict, 'accept');
});
