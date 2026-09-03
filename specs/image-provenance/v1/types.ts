/**
 * Loom image-provenance v1.
 *
 * These are the platform-neutral domain and port types. JSON numbers are
 * deliberately absent from signed bodies; exact integers are decimal strings
 * and non-integral values use CanonicalDecimal.
 */

export type Base64Url = string;
export type DecimalInteger = string;
export type NonNegativeDecimalInteger = string;
export type Rfc3339Timestamp = string;
export type Uri = string;

/** `sha256:` followed by an unpadded base64url digest. */
export type Sha256Digest = `sha256:${string}`;
export type RecordId = Sha256Digest & { readonly __recordId: unique symbol };
export type JournalEntryId = Sha256Digest & { readonly __journalEntryId: unique symbol };
export type AnchorReceiptDigest = Sha256Digest & { readonly __anchorReceiptDigest: unique symbol };
export type EvidenceAttachmentDigest = Sha256Digest & { readonly __evidenceAttachmentDigest: unique symbol };

export interface CanonicalDecimal {
  readonly $type: 'decimal';
  readonly coefficient: DecimalInteger;
  readonly scale: DecimalInteger;
}

export interface CanonicalBytes {
  readonly $type: 'bytes';
  readonly base64url: Base64Url;
}

export type CanonicalValue =
  | null
  | boolean
  | string
  | CanonicalDecimal
  | CanonicalBytes
  | readonly CanonicalValue[]
  | CanonicalMap;

export interface CanonicalMap {
  readonly [key: string]: CanonicalValue;
}

/** Exact identity of bytes. It never describes content, never its storage URL. */
export interface ExactBlob {
  readonly digest: Sha256Digest;
  readonly byteLength: NonNegativeDecimalInteger;
  readonly mediaType: string;
}

export type ArtifactRepresentation =
  | 'encoded-image'
  | 'sensor-samples'
  | 'pixel-plane'
  | 'depth-map'
  | 'mask'
  | 'operation-descriptor'
  | 'model-weights'
  | 'lookup-table'
  | 'colour-profile'
  | 'font'
  | 'opaque';

export interface ArtifactRef {
  /** SHA-256 covers the exact bytes described by this output. */
  readonly blob: ExactBlob;
  readonly representation: ArtifactRepresentation;
  /**
   * Required by the relevant profile for non-file artifacts. A pixel-plane
   * layout, for example, names format, dimensions, plane order, row count, and
   * valid bytes per row; stride padding is never part of the artifact.
   */
  readonly layout?: CanonicalMap;
}

export interface NamedOutput {
  /** Unique within its producer record. */
  readonly outputName: string;
  readonly role: string;
  readonly artifact: ArtifactRef;
}

export interface InputEdge {
  /** Operation-defined role such as `primary`, `mask`, `lut`, or `model`. */
  readonly role: string;
  /** `consumes` is content lineage; `uses` is an implementation/resource input. */
  readonly relation: 'consumes' | 'uses';
  readonly producerRecordId: RecordId;
  readonly producerOutputName: string;
  /** Must exactly equal the named producer output, not merely share a digest. */
  readonly expectedArtifact: ArtifactRef;
}

export interface ActorClaim {
  /** A URI or opaque, privacy-preserving identifier. It is a claim until trusted. */
  readonly id?: string;
  readonly software: {
    readonly name: string;
    readonly version: string;
    readonly buildDigest?: Sha256Digest;
  };
}

export interface EvidenceRef {
  readonly profileUri: Uri;
  readonly blob: ExactBlob;
}

export interface CommonRecordBody {
  readonly occurredAt: Rfc3339Timestamp | null;
  readonly actor: ActorClaim;
  readonly inputs: readonly InputEdge[];
  readonly outputs: readonly [NamedOutput, ...NamedOutput[]];
  /** Only pre-existing evidence may be body-referenced; post-record evidence is an endorsement. */
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly extensions?: Readonly<Record<Uri, CanonicalValue>>;
  readonly criticalExtensions?: readonly Uri[];
}

export type CaptureBoundary =
  | 'sensor-samples'
  | 'os-raw'
  | 'os-pixel-buffer'
  | 'os-encoded-asset';

export interface CaptureRecordBody extends CommonRecordBody {
  readonly schema: 'loom.image-provenance.capture/v1';
  readonly kind: 'capture';
  readonly inputs: readonly [];
  readonly subject: {
    readonly sessionId: string;
    readonly shotSequence: NonNegativeDecimalInteger;
    readonly challenge?: {
      readonly issuer: Uri;
      readonly audience: string;
      readonly nonce: Base64Url;
      readonly issuedAt: Rfc3339Timestamp;
      readonly expiresAt: Rfc3339Timestamp;
    };
    readonly acquisition: {
      readonly boundary: CaptureBoundary;
      readonly providerUri: Uri;
      readonly providerVersion: string;
      readonly providerBuildDigest?: Sha256Digest;
      readonly serializationProfileUri: Uri;
      readonly digitalSourceTypeUri: Uri;
      readonly upstreamProcessing: 'declared' | 'opaque' | 'unknown';
      readonly requestedSettings?: CanonicalValue;
      readonly reportedSettings?: CanonicalValue;
    };
    /** Device time is not trusted time without separately verified secure-time evidence. */
    readonly deviceTimeClaim?: Rfc3339Timestamp;
    readonly monotonicTimeClaim?: NonNegativeDecimalInteger;
    readonly locationClaim?: CanonicalValue;
  };
}

/** Explicit root for an imported, generated, or externally proven ingredient. */
export interface SourceRecordBody extends CommonRecordBody {
  readonly schema: 'loom.image-provenance.source/v1';
  readonly kind: 'source';
  readonly inputs: readonly [];
  readonly subject: {
    readonly sourceType: 'imported' | 'generated' | 'external-provenance';
    readonly description?: string;
    readonly upstreamManifest?: EvidenceRef;
  };
}

export type DisclosedParameters = {
  readonly disclosure: 'inline';
  readonly value: CanonicalValue;
};

export type CommittedParameters = {
  readonly disclosure: 'commitment';
  readonly commitment: Sha256Digest;
  readonly mediaType: string;
};

export interface TransformRecordBody extends CommonRecordBody {
  readonly schema: 'loom.image-provenance.transform/v1';
  readonly kind: 'transform';
  readonly inputs: readonly [InputEdge, ...InputEdge[]];
  readonly subject: {
    readonly operation: {
      readonly uri: Uri;
      readonly version: string;
      /** Pins the descriptor's exact semantics even if its URI or version is reused. */
      readonly descriptorDigest: Sha256Digest;
    };
    readonly parameters: DisclosedParameters | CommittedParameters;
    readonly implementation?: {
      readonly kind: 'wasm' | 'native' | 'container' | 'service' | 'opaque';
      readonly name?: string;
      readonly version?: string;
      readonly digest?: Sha256Digest;
    };
    readonly environment?: {
      readonly descriptorDigest: Sha256Digest;
    };
    readonly isolation: 'hermetic' | 'declared-input-sandbox' | 'unconstrained';
    readonly replay:
      | { readonly claim: 'bit-exact' }
      | { readonly claim: 'tolerance-defined'; readonly toleranceProfileDigest: Sha256Digest }
      | { readonly claim: 'non-replayable'; readonly reason?: string };
    readonly executionEvidenceRefs: readonly EvidenceRef[];
  };
}

export type RecordBody = CaptureRecordBody | SourceRecordBody | TransformRecordBody;

export type SignaturePurpose =
  | 'capture-origin'
  | 'source-ingest'
  | 'transform-executor'
  | 'operator-approval';

/** Purposes that an out-of-band trust store may authorize. */
export type TrustedSignaturePurpose = SignaturePurpose | 'journal-append';

/** The exact object whose RFC 8785 bytes are signed. */
export interface RecordSignatureStatement {
  readonly domain: 'loom.image-provenance.signature/v1';
  readonly recordId: RecordId;
  readonly purpose: SignaturePurpose;
  readonly suite: 'Ed25519' | 'ES256';
  readonly signerKeyFingerprint: Sha256Digest;
}

export interface RecordSignature {
  readonly statement: RecordSignatureStatement;
  readonly signature: Base64Url;
  /** Convenience only. Trust never comes from a key carried by the bundle. */
  readonly inlinePublicKey?: {
    readonly format: 'spki-der';
    readonly value: Base64Url;
  };
  readonly publicKeyRef?: EvidenceRef;
  readonly attestationRefs?: readonly EvidenceRef[];
}

export interface ProvenanceRecordEnvelope<TBody extends RecordBody = RecordBody> {
  readonly schema: 'loom.image-provenance.record-envelope/v1';
  /** SHA-256(domain || NUL || JCS(body)); the body never contains its own ID. */
  readonly recordId: RecordId;
  readonly body: TBody;
  /** Additive endorsements do not change recordId. */
  readonly signatures: readonly [RecordSignature, ...RecordSignature[]];
}

export type EvidenceBinding =
  | { readonly target: 'record'; readonly recordId: RecordId }
  | { readonly target: 'artifact'; readonly digest: Sha256Digest }
  | { readonly target: 'key'; readonly keyFingerprint: Sha256Digest }
  | { readonly target: 'challenge'; readonly issuer: Uri; readonly nonce: Base64Url };

/** Evidence created after a record exists belongs here to avoid a hash cycle. */
export interface RecordEndorsement {
  readonly schema: 'loom.image-provenance.endorsement/v1';
  readonly profileUri: Uri;
  readonly targetRecordId: RecordId;
  readonly expectedBindings: readonly [EvidenceBinding, ...EvidenceBinding[]];
  readonly evidence: ExactBlob;
}

export interface JournalEntryBody {
  readonly schema: 'loom.image-provenance.journal-entry/v1';
  readonly journalId: string;
  readonly sequence: NonNegativeDecimalInteger;
  readonly previousEntryId: JournalEntryId | null;
  readonly event:
    | { readonly kind: 'record-committed'; readonly recordId: RecordId }
    | { readonly kind: 'heads-checkpoint'; readonly headRecordIds: readonly RecordId[] };
  readonly priorHeads: readonly RecordId[];
  readonly resultingHeads: readonly RecordId[];
}

export interface JournalSignatureStatement {
  readonly domain: 'loom.image-provenance.journal-signature/v1';
  readonly entryId: JournalEntryId;
  readonly purpose: 'journal-append';
  readonly suite: 'Ed25519' | 'ES256';
  readonly signerKeyFingerprint: Sha256Digest;
}

export interface JournalSignature {
  readonly statement: JournalSignatureStatement;
  readonly signature: Base64Url;
  readonly inlinePublicKey?: { readonly format: 'spki-der'; readonly value: Base64Url };
  readonly publicKeyRef?: EvidenceRef;
}

export interface JournalEntryEnvelope {
  readonly schema: 'loom.image-provenance.journal-envelope/v1';
  readonly entryId: JournalEntryId;
  readonly body: JournalEntryBody;
  readonly signatures: readonly [JournalSignature, ...JournalSignature[]];
}

/** Opaque witness proof interpreted only by its registered verifier profile. */
export interface AnchorReceipt {
  readonly schema: 'loom.image-provenance.anchor-receipt/v1';
  readonly profileUri: Uri;
  readonly witnessId: string;
  readonly subjectEntryId: JournalEntryId;
  readonly receipt: ExactBlob;
  readonly checkpoint: ExactBlob;
  readonly consistencyProof?: ExactBlob;
  /** A claim unless the witness profile validates secure/finality time. */
  readonly witnessedAtClaim?: Rfc3339Timestamp;
}

export interface BlobLocation {
  readonly blob: ExactBlob;
  readonly inlineBase64Url?: Base64Url;
  readonly locations?: readonly Uri[];
}

export interface OutputPointer {
  readonly recordId: RecordId;
  readonly outputName: string;
}

/** Transport container. Array order and suggested roots carry no trust semantics. */
export interface ProvenanceBundle {
  readonly schema: 'loom.image-provenance.bundle/v1';
  readonly records: readonly ProvenanceRecordEnvelope[];
  readonly journalEntries: readonly JournalEntryEnvelope[];
  readonly endorsements: readonly RecordEndorsement[];
  readonly anchors: readonly AnchorReceipt[];
  readonly blobs: readonly BlobLocation[];
  readonly suggestedRoots?: readonly OutputPointer[];
}

export type CheckStatus =
  | 'valid'
  | 'invalid'
  | 'indeterminate'
  | 'unsupported'
  | 'not-present';

export type OriginAssurance =
  | 'self-declared'
  | 'app-attested'
  | 'os-attested'
  | 'sensor-path-attested';

export interface VerificationPolicy {
  readonly schema: 'loom.image-provenance.verification-policy/v1';
  readonly trustedSignatureRequiredFor: readonly ('capture' | 'source' | 'transform')[];
  readonly allowedSourceRoots: readonly ('capture' | 'source')[];
  readonly minimumOriginAssurance: OriginAssurance;
  readonly requireVerifiedCaptureBoundary: boolean;
  readonly requireEveryReachableRecordAnchored: boolean;
  readonly requireJournalConsistency: boolean;
  readonly requireDisclosedParameters: boolean;
  readonly requireHermeticTransforms: boolean;
  readonly replayRequirement: 'none' | 'when-claimed' | 'every-transform';
  readonly limits: {
    readonly maxBundleObjects: NonNegativeDecimalInteger;
    readonly maxRecords: NonNegativeDecimalInteger;
    readonly maxDepth: NonNegativeDecimalInteger;
    readonly maxReferencedBytes: NonNegativeDecimalInteger;
    /** Maximum transport candidates considered for one committed digest. */
    readonly maxBlobCandidatesPerDigest: NonNegativeDecimalInteger;
    /** Aggregate candidate bytes the verifier may decode or hash. */
    readonly maxVerificationBytes: NonNegativeDecimalInteger;
  };
}

export interface VerificationFinding {
  readonly code:
    | 'HASH_MISMATCH'
    | 'BYTE_LENGTH_MISMATCH'
    | 'SIGNATURE_INVALID'
    | 'SIGNER_UNTRUSTED'
    | 'SIGNER_REVOKED'
    | 'MISSING_PARENT'
    | 'MISSING_OUTPUT'
    | 'EDGE_ARTIFACT_MISMATCH'
    | 'MISSING_BLOB'
    | 'ATTESTATION_INVALID'
    | 'LOG_PROOF_INVALID'
    | 'LOG_CONSISTENCY_INVALID'
    | 'CLOCK_UNTRUSTED'
    | 'EXECUTION_UNVERIFIED'
    | 'OPERATION_UNVERIFIED'
    | 'REPLAY_MISMATCH'
    | 'UNKNOWN_CRITICAL_EXTENSION'
    | 'UNSUPPORTED_VERSION'
    | 'UNSUPPORTED_ALGORITHM'
    | 'GRAPH_CYCLE'
    | 'POLICY_DENIED';
  readonly status: Exclude<CheckStatus, 'not-present'>;
  readonly message: string;
  readonly recordId?: RecordId;
  readonly outputName?: string;
}

export interface RecordVerification {
  readonly recordId: RecordId;
  readonly structure: CheckStatus;
  readonly signature: CheckStatus;
  readonly signerTrust: CheckStatus;
  readonly artifacts: CheckStatus;
  readonly operationSemantics: CheckStatus;
  readonly execution:
    | 'declared'
    | 'replayed-exact'
    | 'replayed-within-tolerance'
    | 'proof-verified'
    | 'execution-attested'
    | 'not-reproducible';
}

/** Profile-verified execution facts; signed transform fields alone do not mint this. */
export interface VerifiedExecution {
  readonly recordId: RecordId;
  readonly execution: Exclude<RecordVerification['execution'], 'declared'>;
  /** Required when execution is `replayed-within-tolerance`. */
  readonly toleranceProfileDigest?: Sha256Digest;
  readonly hermeticity: CheckStatus;
  readonly findings: readonly VerificationFinding[];
}

export interface VerificationReport {
  readonly schema: 'loom.image-provenance.verification-report/v1';
  readonly verdict: 'accept' | 'reject' | 'indeterminate';
  readonly rootOutput: OutputPointer;
  readonly structural: CheckStatus;
  readonly byteIntegrity: CheckStatus;
  readonly signatures: CheckStatus;
  readonly lineage: 'complete' | 'partial' | 'broken';
  readonly anchoring: CheckStatus;
  readonly captureEvidence: {
    /** Every capture/source root in the consumes-only content closure. */
    readonly contentRoots: readonly ContentRootVerification[];
    readonly contentComposition: 'capture-only' | 'source-only' | 'mixed' | 'not-reached';
    readonly captures: readonly CaptureVerification[];
    readonly minimumRequired: OriginAssurance;
    readonly weakestOriginAssurance: OriginAssurance | 'not-reached';
    readonly allCapturesSatisfyMinimum: CheckStatus;
  };
  readonly records: readonly RecordVerification[];
  readonly findings: readonly VerificationFinding[];
}

export interface ContentRootVerification {
  readonly recordId: RecordId;
  readonly kind: 'capture' | 'source';
  readonly sourceType?: SourceRecordBody['subject']['sourceType'];
}

export interface CaptureVerification {
  readonly recordId: RecordId;
  readonly acquisitionBoundary: CaptureBoundary;
  readonly originAssurance: OriginAssurance;
  /** Whether the profile bound each output representation to the declared boundary. */
  readonly boundaryBinding: CheckStatus;
  readonly appIdentity: CheckStatus;
  readonly osBinding: CheckStatus;
  readonly keyProtection: CheckStatus;
  readonly sensorBinding: CheckStatus;
  readonly freshness: CheckStatus;
  readonly time: CheckStatus;
  readonly location: CheckStatus;
}

export interface TrustedKey {
  readonly fingerprint: Sha256Digest;
  readonly purposes: readonly TrustedSignaturePurpose[];
  readonly publicKey: { readonly format: 'spki-der'; readonly value: Base64Url };
  readonly notBefore?: Rfc3339Timestamp;
  readonly notAfter?: Rfc3339Timestamp;
  readonly revokedAt?: Rfc3339Timestamp;
}

export interface TrustedCheckpoint {
  readonly witnessId: string;
  readonly profileUri: Uri;
  readonly checkpoint: ExactBlob;
  /** Canonical bytes matching checkpoint; trust configuration is out of band. */
  readonly checkpointBytes: Base64Url;
}

export interface TrustStore {
  readonly keys: readonly TrustedKey[];
  readonly acceptedEvidenceProfiles: readonly Uri[];
  readonly acceptedWitnessProfiles: readonly Uri[];
}

/** Provider-facing capability: it cannot seal, abort, or inspect store state. */
export interface ArtifactSink {
  /** Implementations copy or transfer bytes before returning this promise. */
  write(chunk: Readonly<Uint8Array>): Promise<void>;
}

/** Trusted-orchestrator control for the same staged output. */
export interface ArtifactWriter {
  readonly sink: ArtifactSink;
  readonly state: 'open' | 'sealing' | 'sealed' | 'aborted';
  /** The trusted store computes the digest and byte length and mints this opaque receipt. */
  seal(): Promise<SealedArtifact>;
  abort(): Promise<void>;
}

/**
 * Process-local proof that an ArtifactStore, rather than a provider, sealed the
 * bytes. It is never serialized. Implementations must make the brand/runtime
 * token unforgeable outside their trusted storage boundary.
 */
export interface SealedArtifact {
  readonly blob: ExactBlob;
  readonly __sealedArtifactBrand: unique symbol;
}

export interface ArtifactStore {
  begin(mediaType: string): Promise<ArtifactWriter>;
  read(blob: ExactBlob): AsyncIterable<Uint8Array>;
}

/** Independent hostile-input limits applied before a bundle is materialized. */
export interface BundleParseLimits {
  readonly maxRawBytes: NonNegativeDecimalInteger;
  readonly maxNestingDepth: NonNegativeDecimalInteger;
  readonly maxStringBytes: NonNegativeDecimalInteger;
  readonly maxObjectMembers: NonNegativeDecimalInteger;
  readonly maxArrayItems: NonNegativeDecimalInteger;
  readonly maxTotalValues: NonNegativeDecimalInteger;
}

/** Trusted byte-oriented parser; duplicate object keys are always rejected. */
export interface ProvenanceBundleParser {
  /** Parser first copies/transfers into non-shared core-owned storage. */
  parse(bytes: Readonly<Uint8Array>, limits: BundleParseLimits): ProvenanceBundle;
}

export interface BlobResolutionRequest {
  readonly blob: ExactBlob;
  /** Untrusted transport hints; the resolver applies its own network policy. */
  readonly locations: readonly Uri[];
}

export interface ResolvedBlobStream {
  readonly resolvedFrom: Uri;
  /** Resolver-owned chunks are untrusted; the core copies each before use. */
  readonly chunks: AsyncIterable<Readonly<Uint8Array>>;
}

/** Caller-configured transport only; the trusted core still rechecks bytes. */
export interface BlobResolver {
  resolve(request: BlobResolutionRequest): Promise<ResolvedBlobStream>;
}

export interface CaptureCapabilities {
  readonly boundaries: readonly CaptureBoundary[];
  readonly outputMediaTypes: readonly string[];
  readonly evidenceProfiles: readonly Uri[];
}

export interface CaptureIntent {
  readonly preferredBoundary: CaptureBoundary;
  /** Trusted immutable plan used to allocate and bind each output writer. */
  readonly outputs: readonly [OutputDeclaration, ...OutputDeclaration[]];
  readonly requestedSettings?: CanonicalValue;
  readonly challenge?: CaptureRecordBody['subject']['challenge'];
}

export interface ShotRequest {
  /** Exact frozen copy of the accepted intent plan. */
  readonly outputs: readonly [OutputDeclaration, ...OutputDeclaration[]];
  /** Keys exactly match outputs and are frozen before provider invocation. */
  readonly outputSinks: Readonly<Record<string, ArtifactSink>>;
}

export interface OutputDeclaration {
  readonly outputName: string;
  readonly role: string;
  readonly mediaType: string;
  readonly representation: ArtifactRepresentation;
  readonly layout?: CanonicalMap;
}

export interface SealedOutput {
  readonly outputName: string;
  readonly sealedArtifact: SealedArtifact;
}

/** Provider-authored claims before the trusted recorder joins sealed bytes. */
export interface CaptureDraft {
  readonly body: Omit<CaptureRecordBody, 'outputs'>;
  readonly outputs: readonly [OutputDeclaration, ...OutputDeclaration[]];
}

export interface CaptureSession {
  capture(request: ShotRequest): Promise<CaptureDraft>;
  close(): Promise<void>;
}

export interface CaptureProvider {
  capabilities(): Promise<CaptureCapabilities>;
  begin(intent: CaptureIntent): Promise<CaptureSession>;
}

export interface OperationDescriptor {
  readonly schema: 'loom.image-provenance.operation-descriptor/v1';
  readonly uri: Uri;
  readonly version: string;
  /** In v1 every consumes role contributes to every output role. */
  readonly inputRoles: readonly { readonly role: string; readonly relation: 'consumes' | 'uses' }[];
  readonly outputRoles: readonly string[];
  readonly parameterSchema: CanonicalValue;
  readonly colourSemantics?: CanonicalValue;
  readonly metadataSemantics?: CanonicalValue;
  readonly replayProfileUri?: Uri;
  readonly extensions?: Readonly<Record<Uri, CanonicalValue>>;
  readonly criticalExtensions?: readonly Uri[];
}

export interface TransformRequest {
  readonly inputs: readonly [TransformInput, ...TransformInput[]];
  readonly parameters: DisclosedParameters | CommittedParameters;
  /** Descriptor snapshot whose digest/identity the recorder must enforce. */
  readonly descriptor: OperationDescriptor;
  /** Trusted immutable plan used to allocate and bind each output writer. */
  readonly outputs: readonly [OutputDeclaration, ...OutputDeclaration[]];
  readonly outputSinks: Readonly<Record<string, ArtifactSink>>;
}

export interface TransformInput {
  readonly edge: InputEdge;
  /** Core-controlled full-consumption reader for exactly edge.expectedArtifact. */
  readonly bytes: VerifiedBlobReader;
}

export interface TransformDraft {
  readonly body: Omit<TransformRecordBody, 'outputs'>;
  readonly outputs: readonly [OutputDeclaration, ...OutputDeclaration[]];
}

export interface OperationProvider {
  descriptor(): Promise<OperationDescriptor>;
  execute(request: TransformRequest): Promise<TransformDraft>;
}

export interface OperationDescriptorResolution {
  readonly expectedDigest: Sha256Digest;
  readonly status: CheckStatus;
  readonly descriptor?: OperationDescriptor;
  readonly findings: readonly VerificationFinding[];
}

/** Resolves immutable descriptor semantics and recomputes expectedDigest. */
export interface OperationDescriptorResolver {
  resolve(
    identity: TransformRecordBody['subject']['operation'],
    trust: TrustStore,
  ): Promise<OperationDescriptorResolution>;
}

export interface OperationSemanticsVerifier {
  readonly operationUri: Uri;
  verify(
    record: ProvenanceRecordEnvelope<TransformRecordBody>,
    descriptor: OperationDescriptor,
    trust: TrustStore,
  ): Promise<VerifiedOperation>;
}

export interface VerifiedOperation {
  readonly recordId: RecordId;
  readonly descriptorDigest: Sha256Digest;
  readonly status: CheckStatus;
  readonly findings: readonly VerificationFinding[];
}

export interface ProofProvider {
  sign(statement: RecordSignatureStatement): Promise<RecordSignature>;
}

export interface JournalProofProvider {
  sign(statement: JournalSignatureStatement): Promise<JournalSignature>;
}

export interface SourceDraft {
  readonly body: Omit<SourceRecordBody, 'outputs'>;
  readonly outputs: readonly [OutputDeclaration, ...OutputDeclaration[]];
}

export interface CommittedRecord<TBody extends RecordBody = RecordBody> {
  readonly record: ProvenanceRecordEnvelope<TBody>;
  /** Created in the same durable transaction as record. */
  readonly journalEntry: JournalEntryEnvelope;
}

export interface ProvenanceRecorder {
  commitCapture(
    intent: CaptureIntent,
    request: ShotRequest,
    draft: CaptureDraft,
    sealedOutputs: readonly [SealedOutput, ...SealedOutput[]],
    proof: ProofProvider,
    journalProof: JournalProofProvider,
  ): Promise<CommittedRecord<CaptureRecordBody>>;
  commitSource(
    draft: SourceDraft,
    sealedOutputs: readonly [SealedOutput, ...SealedOutput[]],
    proof: ProofProvider,
    journalProof: JournalProofProvider,
  ): Promise<CommittedRecord<SourceRecordBody>>;
  commitTransform(
    request: TransformRequest,
    draft: TransformDraft,
    sealedOutputs: readonly [SealedOutput, ...SealedOutput[]],
    proof: ProofProvider,
    journalProof: JournalProofProvider,
  ): Promise<CommittedRecord<TransformRecordBody>>;
  appendHeadsCheckpoint(proof: JournalProofProvider): Promise<JournalEntryEnvelope>;
  anchor(entryId: JournalEntryId, sink: WitnessSink): Promise<AnchorReceipt>;
}

export interface WitnessSink {
  readonly profileUri: Uri;
  append(entry: JournalEntryEnvelope): Promise<AnchorReceipt>;
}

export interface EvidenceResult {
  /** Domain-separated digest of the complete immutable attachment verified. */
  readonly evidenceAttachmentDigest: EvidenceAttachmentDigest;
  readonly status: CheckStatus;
  readonly establishedBindings: readonly EvidenceBinding[];
  readonly capture?: VerifiedCaptureEvidence;
  /** Present only when this profile verified execution facts for its target record. */
  readonly execution?: VerifiedExecution;
  readonly findings: readonly VerificationFinding[];
}

/** Orthogonal capture facts minted only by an accepted evidence profile. */
export interface VerifiedCaptureEvidence {
  readonly recordId: RecordId;
  readonly status: CheckStatus;
  readonly originAssurance: OriginAssurance;
  /** Duplicate-free exact set of capture output digests covered by this result. */
  readonly coveredOutputDigests: readonly Sha256Digest[];
  readonly appIdentity: CheckStatus;
  readonly osBinding: CheckStatus;
  readonly keyProtection: CheckStatus;
  readonly sensorBinding: CheckStatus;
  readonly freshness: CheckStatus;
  readonly time: CheckStatus;
  readonly location: CheckStatus;
  readonly findings: readonly VerificationFinding[];
}

export interface EvidenceVerifier {
  readonly profileUri: Uri;
  verify(request: EvidenceVerificationRequest): Promise<EvidenceResult>;
}

export interface EvidenceVerificationRequest {
  readonly attachment: EvidenceRef | RecordEndorsement;
  readonly targetRecord: ProvenanceRecordEnvelope;
  readonly evidenceBytes: VerifiedBlobReader;
  /** Derived by the trusted core from targetRecord and local policy. */
  readonly expectedBindings: readonly EvidenceBinding[];
  readonly trust: TrustStore;
}

export interface CriticalExtensionVerifier {
  readonly extensionUri: Uri;
  verify(request: {
    readonly record: ProvenanceRecordEnvelope;
    readonly value: CanonicalValue;
    readonly trust: TrustStore;
  }): Promise<{ readonly status: CheckStatus; readonly findings: readonly VerificationFinding[] }>;
}

export interface CaptureBoundaryVerifier {
  readonly serializationProfileUri: Uri;
  verify(
    record: ProvenanceRecordEnvelope<CaptureRecordBody>,
    trust: TrustStore,
  ): Promise<{ readonly status: CheckStatus; readonly findings: readonly VerificationFinding[] }>;
}

export interface WitnessVerifier {
  readonly profileUri: Uri;
  verify(request: WitnessVerificationRequest): Promise<WitnessResult>;
}

export interface VerifiedBlobReader {
  readonly blob: ExactBlob;
  /**
   * The trusted core drives the stream to EOF and rechecks digest/length before
   * resolving; the consumer cannot turn a verified prefix into a valid result.
   */
  /** Each callback receives a fresh non-shared copy with no resolver alias. */
  consume(consumer: (chunk: Readonly<Uint8Array>) => Promise<void>): Promise<void>;
}

export interface PublicKeyResolutionRequest {
  readonly reference: EvidenceRef;
  readonly expectedFingerprint: Sha256Digest;
  readonly evidenceBytes: VerifiedBlobReader;
  readonly trust: TrustStore;
}

/** Exact-reference result minted by a configured public-key profile resolver. */
export interface PublicKeyResolution {
  readonly evidenceAttachmentDigest: EvidenceAttachmentDigest;
  readonly profileUri: Uri;
  readonly signerKeyFingerprint: Sha256Digest;
  readonly status: CheckStatus;
  readonly publicKey?: { readonly format: 'spki-der'; readonly value: Base64Url };
  readonly findings: readonly VerificationFinding[];
}

export interface PublicKeyResolver {
  readonly profileUri: Uri;
  resolve(request: PublicKeyResolutionRequest): Promise<PublicKeyResolution>;
}

export interface WitnessVerificationRequest {
  readonly receipt: AnchorReceipt;
  readonly subjectEntry: JournalEntryEnvelope;
  readonly receiptBytes: VerifiedBlobReader;
  readonly checkpointBytes: VerifiedBlobReader;
  readonly consistencyProofBytes?: VerifiedBlobReader;
  readonly trustedCheckpoints: readonly VerifiedTrustedCheckpoint[];
  readonly trust: TrustStore;
}

export interface VerifiedTrustedCheckpoint {
  readonly witnessId: string;
  readonly profileUri: Uri;
  readonly checkpoint: ExactBlob;
  readonly checkpointBytes: VerifiedBlobReader;
}

/** Result minted by a configured verifier for one exact AnchorReceipt. */
export interface WitnessResult {
  /** Domain-separated digest of the complete, immutable AnchorReceipt verified. */
  readonly anchorReceiptDigest: AnchorReceiptDigest;
  readonly profileUri: Uri;
  readonly witnessId: string;
  readonly subjectEntryId: JournalEntryId;
  readonly inclusion: CheckStatus;
  readonly consistency: CheckStatus;
  readonly trustedTime?: Rfc3339Timestamp;
  readonly findings: readonly VerificationFinding[];
}

export interface Verifier {
  verify(request: {
    /** Externally selected; bundle ordering and suggestedRoots are untrusted. */
    readonly rootOutput: OutputPointer;
    /** Exact UTF-8 JSON transport; synchronously copied before strict parsing. */
    readonly bundleBytes: Readonly<Uint8Array>;
    readonly parseLimits: BundleParseLimits;
    readonly policy: VerificationPolicy;
    readonly trustStore: TrustStore;
    /** Required to apply configured key validity intervals deterministically. */
    readonly verificationTime?: Rfc3339Timestamp;
    readonly trustedCheckpoints?: readonly TrustedCheckpoint[];
    readonly evidenceVerifiers?: readonly EvidenceVerifier[];
    readonly publicKeyResolvers?: readonly PublicKeyResolver[];
    readonly blobResolver?: BlobResolver;
    readonly witnessVerifiers?: readonly WitnessVerifier[];
    readonly operationDescriptorResolver?: OperationDescriptorResolver;
    readonly operationSemanticsVerifiers?: readonly OperationSemanticsVerifier[];
    readonly criticalExtensionVerifiers?: readonly CriticalExtensionVerifier[];
    readonly captureBoundaryVerifiers?: readonly CaptureBoundaryVerifier[];
  }): Promise<VerificationReport>;
}
