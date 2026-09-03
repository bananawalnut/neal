import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  anchorReceiptDigestFor,
  verifyDiagnosticBundle,
} from './core.mjs';
import { createSchemaValidator } from './schema-validator.mjs';

const bundle = JSON.parse(readFileSync(
  new URL('../examples/linear-bundle.json', import.meta.url),
  'utf8',
));
const schema = JSON.parse(readFileSync(
  new URL('../schema/bundle.schema.json', import.meta.url),
  'utf8',
));

const schemaResult = createSchemaValidator(schema)('#/$defs/provenanceBundle', bundle);
assert.equal(schemaResult.valid, true, schemaResult.errors.join('\n'));

const signer = bundle.records[0].signatures[0];
const policy = {
  schema: 'loom.image-provenance.verification-policy/v1',
  trustedSignatureRequiredFor: ['capture', 'source', 'transform'],
  allowedSourceRoots: ['capture'],
  minimumOriginAssurance: 'self-declared',
  requireVerifiedCaptureBoundary: false,
  requireEveryReachableRecordAnchored: true,
  requireJournalConsistency: true,
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
};
const verifiedOperations = new Map(bundle.records
  .filter((record) => record.body.kind === 'transform')
  .map((record) => [record.recordId, {
    recordId: record.recordId,
    descriptorDigest: record.body.subject.operation.descriptorDigest,
    status: 'valid',
    findings: [],
  }]));
const anchor = bundle.anchors[0];
const report = verifyDiagnosticBundle({
  rootOutput: bundle.suggestedRoots[0],
  bundle,
  policy,
  trustStore: {
    keys: [{
      fingerprint: signer.statement.signerKeyFingerprint,
      purposes: ['capture-origin', 'source-ingest', 'transform-executor', 'journal-append'],
      publicKey: signer.inlinePublicKey,
    }],
    acceptedEvidenceProfiles: [],
    acceptedWitnessProfiles: [anchor.profileUri],
  },
  verifiedOperations,
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
process.stdout.write(`${JSON.stringify({
  verdict: report.verdict,
  structural: report.structural,
  byteIntegrity: report.byteIntegrity,
  signatures: report.signatures,
  lineage: report.lineage,
  anchoring: report.anchoring,
  contentComposition: report.captureEvidence.contentComposition,
  reachableRecords: report.records.length,
}, null, 2)}\n`);
