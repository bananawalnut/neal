# Loom Image Provenance v1 Contract

Status: draft
Namespace: `loom.image-provenance/*/v1`

This contract defines a platform-neutral way to commit the exact bytes
delivered at a mobile image boundary and to preserve a generic, verifiable
enhancement graph. It separates byte integrity, signed claims, evidence,
execution verification, graph completeness, journal continuity, and external
witnessing so that no one of those facts is mislabeled as “authentic.”

[`contract.cddl`](./contract.cddl) is normative for the JSON object shapes.
[`types.ts`](./types.ts) is the matching platform-neutral interface surface.
This document is normative for canonicalization, identifiers, signatures,
cross-object invariants, proof semantics, root-scoped verification, and trust
language.

## 1. Conformance and honest claim

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**,
and **MAY** are to be interpreted as described by RFC 2119 and RFC 8174.

A conforming implementation can establish:

> These exact bytes are committed by a signed capture or explicit-source
> assertion; every disclosed transform reachable from the selected output
> names its exact producer outputs and resources; and an external witness
> observed a journal entry when a valid anchor receipt is present.

The generic contract does not, by itself, prove:

- that photons from a real scene struck a physical sensor;
- that a photographed scene was not staged, replayed, or displayed;
- that a general-purpose OS did not inject or replace a camera buffer;
- that an authorized or compromised signer told the truth;
- that device time, location, lens identity, or EXIF claims are accurate;
- that named code actually executed;
- that undeclared inputs were absent from an unconstrained transform;
- that an unpublished sibling graph or later journal entry does not exist; or
- that a phone's pre-capture ISP stages were absent.

Ordinary hardware-backed application keys and app/device attestation do not
usually bind camera bytes to the sensor path. A `sensor-path-attested`
conclusion requires a registered evidence profile that specifically proves
that binding. The capture boundary value `sensor-samples` describes the
representation delivered to the app; it is not itself sensor-path attestation.

## 2. Protocol objects and schema discriminators

V1 defines these exact discriminators:

| TypeScript type | Discriminator or signed domain |
| --- | --- |
| `CaptureRecordBody` | `loom.image-provenance.capture/v1` |
| `SourceRecordBody` | `loom.image-provenance.source/v1` |
| `TransformRecordBody` | `loom.image-provenance.transform/v1` |
| `ProvenanceRecordEnvelope` | `loom.image-provenance.record-envelope/v1` |
| `RecordSignatureStatement` | domain `loom.image-provenance.signature/v1` |
| `RecordEndorsement` | `loom.image-provenance.endorsement/v1` |
| `EvidenceAttachmentDigest` | domain `loom.image-provenance.evidence-attachment-id/v1` |
| `JournalEntryBody` | `loom.image-provenance.journal-entry/v1` |
| `JournalSignatureStatement` | domain `loom.image-provenance.journal-signature/v1` |
| `JournalEntryEnvelope` | `loom.image-provenance.journal-envelope/v1` |
| `AnchorReceipt` | `loom.image-provenance.anchor-receipt/v1` |
| `AnchorReceiptDigest` | domain `loom.image-provenance.anchor-receipt-id/v1` |
| `ProvenanceBundle` | `loom.image-provenance.bundle/v1` |
| `OperationDescriptor` | `loom.image-provenance.operation-descriptor/v1` |
| `VerificationPolicy` | `loom.image-provenance.verification-policy/v1` |
| `VerificationReport` | `loom.image-provenance.verification-report/v1` |

Record bodies and journal-entry bodies are immutable. Signatures,
endorsements, anchors, and transport locations remain outside the identifiers
of the objects they accompany, so they can be appended without a hash cycle.

## 3. Number-free RFC 8785 JSON

### 3.1 Signed projection

JSON is the v1 data model. The exact projection used for every v1 hash and
signature is UTF-8 RFC 8785 JSON Canonicalization Scheme (JCS).

A producer **MUST** emit valid UTF-8 JSON. Before hashing or signing, an
implementation **MUST**:

1. reject duplicate object member names;
2. reject malformed Unicode and unpaired surrogate code points;
3. require every string, including every object key, to already be Unicode
   NFC;
4. reject every JSON number in a signed body or signed statement;
5. validate canonical decimal strings and tagged values;
6. validate base64url by decoding and re-encoding it without padding; and
7. serialize the validated value using RFC 8785.

Implementations validate NFC but **MUST NOT** silently normalize historical
input before verification. Normalizing would change the signed data.

Transport whitespace and object insertion order do not carry meaning.
Verifiers parse strictly and calculate their own JCS projection. Arrays are
never reordered by JCS; their order is semantic unless this contract
explicitly defines them as sorted sets.

### 3.2 Integers and decimals

Every integer in a protocol object is a string. A `DecimalInteger` is:

```text
0 | -?[1-9][0-9]*
```

There is no plus sign, leading zero, exponent, decimal point, whitespace, or
negative zero. Fields described as non-negative additionally reject a leading
minus; TypeScript names that subset `NonNegativeDecimalInteger`. `byteLength`,
`shotSequence`, `monotonicTimeClaim`, journal `sequence`, and every policy
limit use that subset. Implementations **MUST** parse untrusted decimal strings
with arbitrary precision or apply a policy limit before conversion to a native
number.

An exact non-integral value is:

```json
{
  "$type": "decimal",
  "coefficient": "5",
  "scale": "-1"
}
```

Its mathematical value is `coefficient × 10^scale`, so the example is `0.5`.
Both fields are canonical `DecimalInteger` strings. The operation descriptor
defines whether representationally different but mathematically equal decimals
are semantically interchangeable. A historical verifier never rewrites them.

`Rfc3339Timestamp` is an RFC 3339 date-time using uppercase `T` and uppercase
`Z` when the UTC form is used; numeric offsets remain allowed. V1 rejects
lowercase `t`/`z` and leap-second `:60` so the CDDL and JSON Schema accept one
spelling and range rule. Verifiers still perform full calendar validation; a
lexically plausible impossible date is invalid.

A `Uri` is an absolute RFC 3986 URI: it has an ASCII scheme, at least one
character after the colon, contains only ASCII URI characters (non-ASCII text
must be UTF-8 percent-encoded), and has only well-formed percent escapes.
Relative references, IRIs, whitespace, and control characters are invalid. URI
strings are signed as written; a verifier **MUST NOT** case-fold,
percent-decode, remove dot segments, or otherwise normalize one before hashing
or equality comparison.

An arbitrary byte string inside a canonical value is:

```json
{
  "$type": "bytes",
  "base64url": "AAECAw"
}
```

`$type` is reserved. An ordinary `CanonicalMap` cannot contain that key.

### 3.3 Extensions

`extensions`, where allowed, maps absolute URI keys to `CanonicalValue`.
`criticalExtensions` contains URI keys whose semantics are required to verify
the containing object.

A verifier **MUST**:

- reject duplicate critical-extension names;
- reject a critical name absent from `extensions`;
- return `unsupported` for an unknown critical extension;
- retain or ignore unknown non-critical extensions without changing signed
  bytes; and
- include both fields in JCS when present.

An artifact cannot weaken verification policy by declaring an extension
non-critical when the caller's policy requires its semantics.

Record-body extensions are evaluated only through a locally configured
`CriticalExtensionVerifier` selected by exact `extensionUri`. It receives the
already-verified record envelope, that URI's exact `CanonicalValue`, and the
out-of-band trust store. A critical extension is satisfied only by a `valid`
result for that same record and URI. Operation-descriptor extensions are
handled by the descriptor resolver and operation-semantics verifier because
`CriticalExtensionVerifier` is record-scoped.

The public `Verifier` invokes these ports directly. The diagnostic evaluator's
`verifiedCriticalExtensions` value is a per-record lower-level seam; a global
set of recognized names cannot establish that an extension value in a
particular record was verified.

## 4. Exact bytes and identifiers

### 4.1 SHA-256 value syntax

`Sha256Digest`, `RecordId`, `JournalEntryId`, `AnchorReceiptDigest`,
`EvidenceAttachmentDigest`, and signer key fingerprints use the same
serialized digest syntax:

```text
sha256:<43-character unpadded base64url encoding of 32 bytes>
```

They remain distinct semantic types in TypeScript. A verifier decodes and
re-encodes the suffix to reject non-canonical base64url spellings.

### 4.2 ExactBlob

```ts
interface ExactBlob {
  digest: Sha256Digest;
  byteLength: NonNegativeDecimalInteger;
  mediaType: string;
}
```

For `ExactBlob`:

```text
digest = "sha256:" || base64url(SHA-256(exact bytes))
byteLength = canonical non-negative decimal length of exact bytes
```

`mediaType` is signed metadata and **MUST** be a syntactically valid RFC 9110
media type with no surrounding whitespace. The type, subtype, parameter names,
token values, quoted strings, and escaping all receive full grammar validation;
the CDDL regular expression only provides a conservative lexical precheck. The
string is signed as written and is not part of the byte digest. A resolver URL
is deliberately absent. Locators are transport hints and never substitute for
digest and length verification.

### 4.3 Record ID

`RecordBody` does not contain its own ID. The exact domain is the dotted string
below:

```text
recordBodyBytes = UTF8(JCS(recordBody))
recordId = "sha256:" || base64url(
  SHA-256(
    UTF8("loom.image-provenance.record/v1") ||
    0x00 ||
    recordBodyBytes
  )
)
```

The NUL is one byte, not the two characters backslash and zero. The
envelope-supplied `recordId` is a check value; a verifier always recomputes it.
SHA-256 and this domain are fixed for v1.

### 4.4 Journal entry ID

`JournalEntryBody` also excludes its ID:

```text
journalBodyBytes = UTF8(JCS(journalEntryBody))
entryId = "sha256:" || base64url(
  SHA-256(
    UTF8("loom.image-provenance.journal-entry/v1") ||
    0x00 ||
    journalBodyBytes
  )
)
```

Graph parents are not journal predecessors. `producerRecordId` links
derivation; `previousEntryId` links append chronology.

### 4.5 Signer fingerprint

For an inline or trusted SPKI public key:

```text
signerKeyFingerprint =
  "sha256:" || base64url(SHA-256(DER SubjectPublicKeyInfo))
```

It identifies exact key material. It does not establish who controls the key
or whether that controller is trusted.

## 5. Artifacts

### 5.1 ArtifactRef and NamedOutput

The exact v1 shape is:

```ts
interface ArtifactRef {
  blob: ExactBlob;
  representation:
    | "encoded-image"
    | "sensor-samples"
    | "pixel-plane"
    | "depth-map"
    | "mask"
    | "operation-descriptor"
    | "model-weights"
    | "lookup-table"
    | "colour-profile"
    | "font"
    | "opaque";
  layout?: CanonicalMap;
}

interface NamedOutput {
  outputName: string;
  role: string;
  artifact: ArtifactRef;
}
```

`outputName` is non-empty and unique within its producer record. The complete
`artifact` object, not just its blob digest, is provenance-bearing.

Profiles require `layout` for non-self-describing bytes. A pixel-plane or
sensor-sample serialization profile, for example, defines dimensions, sample
format, plane order, row count, and valid bytes per row. Stride padding and
uninitialized allocator bytes **MUST NOT** be included. A decoded plane is a
different artifact from an encoded JPEG or HEIC.

`serializationProfileUri` in a capture record identifies the exact packing
rules used before hashing. Verifiers that do not understand a required profile
cannot claim to have reconstructed the delivered sample representation.

### 5.2 InputEdge

```ts
interface InputEdge {
  role: string;
  relation: "consumes" | "uses";
  producerRecordId: RecordId;
  producerOutputName: string;
  expectedArtifact: ArtifactRef;
}
```

To validate an edge, a verifier **MUST**:

1. resolve exactly one envelope with `producerRecordId`;
2. resolve exactly one named output with `producerOutputName`;
3. compare the producer's complete `artifact` to `expectedArtifact` using
   canonical structural equality; and
4. traverse that producer while checking cycles and policy limits.

The triple `(producerRecordId, producerOutputName, expectedArtifact)` prevents
lineage substitution when identical bytes occur in multiple histories.

`consumes` denotes content ancestry. `uses` denotes a material dependency such
as a mask, LUT, model, colour profile, font, or operation descriptor. Both are
reachable graph edges and both are verified. Input-array order is semantic and
is interpreted by the pinned operation descriptor.

V1 dependency semantics are record-wide: every `consumes` input **MUST**
materially contribute to every named output of that transform record. When two
outputs have different content-dependency sets, the producer **MUST** split
them into separate transform records. The exact-operation semantics verifier
rejects a descriptor/record combination that violates this invariant. This
prevents an unrelated output in a multi-output operation from inheriting a
camera origin that belongs only to its sibling output.

A separate `parents` field is intentionally absent. Parents are derived from
input edges, preventing two competing descriptions of the graph.

## 6. Record bodies

All record bodies contain:

- `occurredAt`: an RFC 3339 claim or `null`;
- `actor`: optional opaque `id` plus required software name, version, and
  optional build digest;
- `inputs`;
- one or more `outputs`;
- `evidenceRefs`, which may be empty; and
- optional `extensions` and `criticalExtensions`.

`occurredAt`, actor identity, software identity, and build identity are signed
claims. Trust requires separately validated evidence or configured keys.

### 6.1 CaptureRecordBody

`CaptureRecordBody` has:

```text
schema = "loom.image-provenance.capture/v1"
kind = "capture"
inputs = []
```

Its `subject` contains:

- `sessionId`;
- non-negative decimal `shotSequence`;
- optional challenge;
- acquisition description;
- optional device-time, monotonic-time, and location claims.

The challenge is exactly:

```ts
{
  issuer: Uri;
  audience: string;
  nonce: Base64Url;
  issuedAt: Rfc3339Timestamp;
  expiresAt: Rfc3339Timestamp;
}
```

The signed nonce supports freshness only when the verifier trusts the issuer,
audience, issuance time, expiry, and nonce uniqueness. A challenge can provide
a lower time bound; it does not establish sensor origin.

The acquisition object is exactly:

```ts
{
  boundary:
    | "sensor-samples"
    | "os-raw"
    | "os-pixel-buffer"
    | "os-encoded-asset";
  providerUri: Uri;
  providerVersion: string;
  providerBuildDigest?: Sha256Digest;
  serializationProfileUri: Uri;
  digitalSourceTypeUri: Uri;
  upstreamProcessing: "declared" | "opaque" | "unknown";
  requestedSettings?: CanonicalValue;
  reportedSettings?: CanonicalValue;
}
```

The boundary means only:

- `sensor-samples`: the provider claims it serialized delivered sensor-sample
  bytes;
- `os-raw`: the provider claims an OS camera API delivered a raw format;
- `os-pixel-buffer`: the provider claims an OS camera API delivered decoded
  planes; or
- `os-encoded-asset`: the provider claims an OS camera API delivered an
  encoded asset.

None is an origin assurance level. Evidence evaluated by a registered profile
may separately establish `app-attested`, `os-attested`, or
`sensor-path-attested`.

`upstreamProcessing` prevents “unedited” from silently ignoring ISP work:

- `declared`: a selected evidence/profile set declares the relevant upstream
  processing;
- `opaque`: a known OS/ISP pipeline may have transformed samples but its stages
  are unavailable; or
- `unknown`: the producer cannot characterize that upstream path.

A UI says “no recorded post-boundary transforms” when that is what the graph
shows. It does not say “unprocessed” merely because the capture record is a
root.

The boundary label and `serializationProfileUri` are signed claims until the
matching profile validates their relationship to every output. The
process-local port is:

```ts
interface CaptureBoundaryVerifier {
  serializationProfileUri: Uri;
  verify(
    record: ProvenanceRecordEnvelope<CaptureRecordBody>,
    trust: TrustStore,
  ): Promise<{ status: CheckStatus; findings: readonly VerificationFinding[] }>;
}
```

The core invokes exactly the verifier registered for the record's
`serializationProfileUri`, after record and artifact-byte verification, and
places its result in `CaptureVerification.boundaryBinding`. The verifier must
apply that profile's output-representation and layout rules and any documented
platform trust assumptions. Only `valid` satisfies
`requireVerifiedCaptureBoundary`; absence is not inferred as validity. The
diagnostic evaluator's per-record `verifiedCaptureBoundaries` map is only a lower-level
test/integration seam.

Boundary binding still does not establish that photons reached a sensor. That
stronger conclusion requires independently verified sensor-path evidence.

### 6.2 SourceRecordBody

Imported, generated, and externally proven roots are explicit source records:

```text
schema = "loom.image-provenance.source/v1"
kind = "source"
inputs = []
```

`sourceType` is `imported`, `generated`, or `external-provenance`. Optional
`upstreamManifest` is an `EvidenceRef`; it is not trusted until the matching
evidence verifier succeeds.

A source record **MUST NOT** be presented as mobile-camera provenance.
`VerificationPolicy.allowedSourceRoots` decides which root kinds are
acceptable across the complete dependency closure, including roots reached
only through `uses` edges. Camera-origin assurance is separately calculated
over the content closure reached through `consumes` edges only.

### 6.3 TransformRecordBody

`TransformRecordBody` has:

```text
schema = "loom.image-provenance.transform/v1"
kind = "transform"
inputs = one or more InputEdge values
```

One schema covers crop, rotate, tone mapping, compositing, redaction, encoding,
metadata changes, model-driven enhancement, and export.

The operation tuple contains URI, version, and `descriptorDigest`. The digest
pins exact semantics even if a publisher reuses a URI or version:

```text
descriptorDigest =
  "sha256:" || base64url(SHA-256(UTF8(JCS(OperationDescriptor))))
```

Parameters are either disclosed:

```json
{ "disclosure": "inline", "value": { "exposure": {
  "$type": "decimal", "coefficient": "5", "scale": "-1"
} } }
```

or committed:

```json
{
  "disclosure": "commitment",
  "commitment": "sha256:...",
  "mediaType": "application/jcs+json"
}
```

For committed parameters, `commitment` hashes the exact disclosure bytes
identified by `mediaType`. A verifier cannot inspect, replay, or validate
parameter semantics until those bytes and the operation-specific decoder are
available. `requireDisclosedParameters` can fail such a record.

The optional implementation identifies a claimed `wasm`, `native`,
`container`, `service`, or `opaque` implementation by name, version, and/or
digest. The optional environment pins a descriptor digest. These identify
claims; a digest alone does not prove that code or environment executed.

`isolation` is `hermetic`, `declared-input-sandbox`, or `unconstrained`. It is
a signed claim until execution evidence verifies it. Only an appropriate
hermetic execution profile can elevate “all inputs are declared” above an
assertion.

Replay is:

- `{ "claim": "bit-exact" }`;
- `{ "claim": "tolerance-defined", "toleranceProfileDigest": "sha256:..." }`;
  or
- `{ "claim": "non-replayable", "reason": "..." }`.

Model weights, masks, LUTs, colour profiles, fonts, prompts, seeds, and captured
network results **SHOULD** be explicit inputs or inline parameters when
reproducibility is claimed.

`executionEvidenceRefs` is present even when empty. It contains evidence that
already exists when the body is hashed. A proof created after `recordId`
exists is a `RecordEndorsement`.

## 7. OperationDescriptor

The standalone descriptor has this exact v1 surface:

```ts
interface OperationDescriptor {
  schema: "loom.image-provenance.operation-descriptor/v1";
  uri: Uri;
  version: string;
  inputRoles: readonly {
    role: string;
    relation: "consumes" | "uses";
  }[];
  outputRoles: readonly string[];
  parameterSchema: CanonicalValue;
  colourSemantics?: CanonicalValue;
  metadataSemantics?: CanonicalValue;
  replayProfileUri?: Uri;
  extensions?: Readonly<Record<Uri, CanonicalValue>>;
  criticalExtensions?: readonly Uri[];
}
```

The bundle does not add an operation-descriptor array. Descriptor bytes can be
resolved externally by digest or carried as an artifact/blob with
representation `operation-descriptor`. A verifier recomputes
`descriptorDigest`, verifies role compatibility and parameter shape, and
applies only registered replay semantics. An unknown descriptor or critical
extension is `unsupported`, never guessed from the operation name.

Resolution and semantic validation use explicit process-local ports:

```ts
interface OperationDescriptorResolution {
  expectedDigest: Sha256Digest;
  status: CheckStatus;
  descriptor?: OperationDescriptor;
  findings: readonly VerificationFinding[];
}

interface OperationDescriptorResolver {
  resolve(
    identity: TransformRecordBody["subject"]["operation"],
    trust: TrustStore,
  ): Promise<OperationDescriptorResolution>;
}

interface OperationSemanticsVerifier {
  operationUri: Uri;
  verify(
    record: ProvenanceRecordEnvelope<TransformRecordBody>,
    descriptor: OperationDescriptor,
    trust: TrustStore,
  ): Promise<VerifiedOperation>;
}

interface VerifiedOperation {
  recordId: RecordId;
  descriptorDigest: Sha256Digest;
  status: CheckStatus;
  findings: readonly VerificationFinding[];
}
```

The resolver **MUST** recompute the returned descriptor's JCS digest, return it
as `expectedDigest`, and require it to equal the transform's signed
`descriptorDigest`; descriptor URI and version must also equal the signed
identity. A `valid` resolution requires the descriptor to be present. The core
then selects exactly one locally configured semantics verifier by exact
operation URI. That verifier checks ordered input roles and relations, output
roles, parameter schema, and registered colour, metadata, extension, and replay
semantics. A `VerifiedOperation` is accepted only when its `recordId` and
`descriptorDigest` equal the record being checked; this prevents reuse across
records or descriptor revisions. Missing semantics are `not-present` or
`unsupported`, never inferred from a human-readable operation name.

## 8. Record signatures

### 8.1 Identifier and signature separation

`ProvenanceRecordEnvelope` is:

```ts
{
  schema: "loom.image-provenance.record-envelope/v1";
  recordId: RecordId;
  body: RecordBody;
  signatures: readonly [RecordSignature, ...RecordSignature[]];
}
```

`recordId` commits only to `body`. Signatures can therefore be added without
changing it. A conforming envelope contains at least one signature.

### 8.2 Exact signed statement

The complete signed value is:

```ts
interface RecordSignatureStatement {
  domain: "loom.image-provenance.signature/v1";
  recordId: RecordId;
  purpose:
    | "capture-origin"
    | "source-ingest"
    | "transform-executor"
    | "operator-approval";
  suite: "Ed25519" | "ES256";
  signerKeyFingerprint: Sha256Digest;
}
```

The exact signature message is:

```text
UTF8(JCS(statement))
```

There is no additional prefix: the signed `domain` member provides
cross-protocol separation. Signing only the record digest, or leaving purpose,
suite, or key fingerprint outside the statement, is non-conforming.

V1 signatures are:

- Ed25519 per RFC 8032 over the exact message; or
- ES256, ECDSA P-256 with SHA-256, encoded as IEEE P1363 32-byte `r` followed
  by 32-byte `s`.

Both encode exactly 64 signature bytes as unpadded base64url. DER-encoded ECDSA
is not accepted in `signature`. ES256 producers **SHOULD** emit low-S values.
Verifiers **MUST NOT** use signature bytes as identity and must deduplicate
threshold signers by trusted key fingerprint, so ECDSA malleability cannot add
a signer.

The verifier obtains SPKI key bytes from `inlinePublicKey`, `publicKeyRef`, or
the trust store. A `publicKeyRef` is usable only through the exact-profile,
attachment-digest-bound `PublicKeyResolver` port defined in section 16; the
bundle cannot register that resolver. The verifier then:

1. hashes DER SPKI and matches `signerKeyFingerprint`;
2. verifies the signature under the declared suite;
3. evaluates key trust, allowed purpose, validity interval, and revocation
   independently.

An inline key proves only cryptographic consistency. It never makes itself
trusted.

### 8.3 Required purposes

The record kind determines the minimum cryptographic purpose:

| Kind | Required signature purpose |
| --- | --- |
| `capture` | `capture-origin` |
| `source` | `source-ingest` |
| `transform` | `transform-executor` |

`operator-approval` is additive and cannot replace the kind-specific
signature. `VerificationPolicy.trustedSignatureRequiredFor` determines which
reachable kinds additionally require a signature from a trusted configured
key. The artifact cannot choose a weaker policy.

`TrustedSignaturePurpose` is exactly
`SignaturePurpose | "journal-append"`. `TrustedKey.purposes` uses that wider
type so an out-of-band trust store can authorize record-signing keys and
journal-signing keys without admitting `journal-append` as a record-signature
purpose.

Removing a required signature is invalid. A mathematically valid signature
whose key is not trusted is cryptographically `valid` while signer trust is
`indeterminate`.

## 9. Evidence, attestations, and execution proofs

### 9.1 EvidenceRef

`EvidenceRef` contains only:

```ts
{
  profileUri: Uri;
  blob: ExactBlob;
}
```

The exact profile implementation and trust configuration interpret the opaque
blob. The verifier checks its bytes first and supplies expected bindings
derived from context. Merely naming a profile does not execute code from the
bundle or make its roots trusted.

Only evidence that exists before a body ID is computed can be referenced by
that body. Signature `publicKeyRef` and `attestationRefs` follow the same
rule unless they are later transported as endorsements.

### 9.2 RecordEndorsement and cycle avoidance

Evidence that binds an existing record uses:

```ts
interface RecordEndorsement {
  schema: "loom.image-provenance.endorsement/v1";
  profileUri: Uri;
  targetRecordId: RecordId;
  expectedBindings: readonly [EvidenceBinding, ...EvidenceBinding[]];
  evidence: ExactBlob;
}
```

Bindings can target:

- a record ID;
- an artifact digest;
- a signing-key fingerprint; or
- a challenge issuer and nonce.

A body **MUST NOT** reference evidence that cryptographically binds that same
body's future `recordId`; that would create a hash cycle. Such evidence is a
detached endorsement.

`expectedBindings` is non-empty and declares what the attachment asks to bind.
It does not state what was established and is not trusted as policy. The core
derives its own expected bindings from the resolved target and local policy,
then checks the attachment declaration and verifier result against them.

### 9.3 Evidence-verifier request and result binding

An `EvidenceRef` or `RecordEndorsement` is an evidence attachment. Its complete
object has this process-local identity:

```text
evidenceAttachmentBytes = UTF8(JCS(attachment))
evidenceAttachmentDigest = "sha256:" || base64url(
  SHA-256(
    UTF8("loom.image-provenance.evidence-attachment-id/v1") ||
    0x00 ||
    evidenceAttachmentBytes
  )
)
```

`EvidenceAttachmentDigest` is not added to either wire object. It binds a
process-local result to every field of exactly one immutable attachment.

```ts
interface EvidenceVerificationRequest {
  attachment: EvidenceRef | RecordEndorsement;
  targetRecord: ProvenanceRecordEnvelope;
  evidenceBytes: VerifiedBlobReader;
  expectedBindings: readonly EvidenceBinding[];
  trust: TrustStore;
}

interface EvidenceResult {
  evidenceAttachmentDigest: EvidenceAttachmentDigest;
  status: CheckStatus;
  establishedBindings: readonly EvidenceBinding[];
  capture?: VerifiedCaptureEvidence;
  execution?: VerifiedExecution;
  findings: readonly VerificationFinding[];
}
```

The core selects the verifier by exact `profileUri`, supplies the target record
and core-derived expected bindings, and provides a trusted-core reader whose
blob equals `EvidenceRef.blob` or `RecordEndorsement.evidence`. It recomputes
and matches `evidenceAttachmentDigest` before accepting the result. For an
endorsement, `targetRecord.recordId` must equal `targetRecordId`; for a body
reference, it must be the record from whose context the attachment was reached.
The result's established bindings must cover the required bindings. These
checks prevent a result for one attachment, target, or proof blob from being
substituted for another.

Before accepting the result, the core also requires
`evidenceBytes.consume(...)` to have reached verified EOF successfully. The
reader contract is defined in Section 11; returning a result after examining
only a prefix cannot establish any binding or evidence fact.

### 9.4 Computational and execution proofs

V1 carries a post-record execution proof as a `RecordEndorsement` whose
`profileUri` identifies the proof or execution-attestation scheme and whose
`evidence` identifies the exact proof bytes.

A conforming execution-proof profile **MUST** bind:

1. `targetRecordId`;
2. the transform's operation descriptor digest;
3. its ordered input edges and exact expected artifacts; and
4. its exact output artifacts.

Because `targetRecordId` already commits to items 2–4, a proof MAY expose only
that ID as its public input if the registered verifier demonstrates that its
circuit or attested statement interprets the corresponding canonical body.
The verifier derives expected public inputs from the resolved target record;
it never trusts public-input text supplied solely by the evidence blob.

The report distinguishes:

- `declared`;
- `replayed-exact`;
- `replayed-within-tolerance`;
- `proof-verified`;
- `execution-attested`; and
- `not-reproducible`.

Profile verification can mint this process-local result:

```ts
interface VerifiedExecution {
  recordId: RecordId;
  execution: Exclude<RecordVerification["execution"], "declared">;
  toleranceProfileDigest?: Sha256Digest;
  hermeticity: CheckStatus;
  findings: readonly VerificationFinding[];
}
```

The enclosing `EvidenceResult.status` must be `valid`, `recordId` must match the
verified endorsement target, and `establishedBindings` must include the
corresponding record binding requested by `expectedBindings`. A
`replayed-within-tolerance` result requires `toleranceProfileDigest`, and it
satisfies a transform's replay claim only when that digest equals the signed
claim. The core does not infer this result from signed transform fields.

An implementation digest, hermeticity claim, proof under an untrusted
verification key, or successful lineage check does not become execution proof.
Execution proof never upgrades camera-origin assurance.

`ProofProvider` in the TypeScript port is the record-signature provider. General
execution proof verification is dispatched through the profile-specific
`EvidenceVerifier` and `RecordEndorsement` path. A successful verifier may
return the subject-bound `VerifiedExecution` as `EvidenceResult.execution`.
The public `Verifier` consumes only results minted by its configured evidence
verifiers; the diagnostic evaluator's `verifiedExecutions` map is a lower-level test
and integration seam, not an untrusted bundle field or public-verifier input.

`requireHermeticTransforms` requires more than the signed
`isolation: "hermetic"` claim. Without accepted execution evidence that reports
`hermeticity: "valid"`, the result is `indeterminate` with
`EXECUTION_UNVERIFIED`; a verified contradiction is invalid.

### 9.5 Origin assurance

Evidence verifiers may establish one of:

- `self-declared`;
- `app-attested`;
- `os-attested`; or
- `sensor-path-attested`.

They return capture-specific facts only through this process-local type:

```ts
interface VerifiedCaptureEvidence {
  recordId: RecordId;
  status: CheckStatus;
  originAssurance: OriginAssurance;
  coveredOutputDigests: readonly Sha256Digest[];
  appIdentity: CheckStatus;
  osBinding: CheckStatus;
  keyProtection: CheckStatus;
  sensorBinding: CheckStatus;
  freshness: CheckStatus;
  time: CheckStatus;
  location: CheckStatus;
  findings: readonly VerificationFinding[];
}
```

The core accepts it only from the configured verifier for an accepted exact
profile, with a matching record in both `expectedBindings` and
`establishedBindings`. Origin evidence scoped to a capture record must cover
the duplicate-free exact digest set of **every** output in that record; the
core checks `coveredOutputDigests` and corresponding artifact bindings. If a
platform profile proves only a subset, producers split outputs into separate
capture records rather than promoting an uncovered sibling. Both the enclosing `EvidenceResult.status` and the
capture result's own `status` must be `valid` before `originAssurance` may be
promoted; the orthogonal fact statuses remain independent.

Assurance labels must agree with those facts: `app-attested` requires
`appIdentity: "valid"`, `os-attested` requires `osBinding: "valid"`, and
`sensor-path-attested` requires `sensorBinding: "valid"`. A contradictory
label/result is invalid rather than a weaker successful assurance.

The public `Verifier` obtains these values only by invoking its configured
`EvidenceVerifier` instances. The reference diagnostic evaluator's
`verifiedCaptureEvidence` map is a lower-level test and integration seam, not a
bundle field or public-verifier input.

These are policy levels, not synonyms for artifact integrity. An implementation
must not infer a higher level from secure key storage, EXIF, a camera API name,
or a lower assurance level.

Origin policy is evaluated for every capture in the `consumes`-only content
closure, never just the first or strongest one. Reporting the weakest assurance
prevents one well-attested capture in a composite from laundering weaker
capture ingredients; a capture reached only as a `uses` dependency cannot
promote output origin.

## 10. Append-only journal

The graph describes derivation. The journal describes append chronology.

### 10.1 JournalEntryBody

The body contains:

```ts
{
  schema: "loom.image-provenance.journal-entry/v1";
  journalId: string;
  sequence: NonNegativeDecimalInteger;
  previousEntryId: JournalEntryId | null;
  event:
    | { kind: "record-committed"; recordId: RecordId }
    | { kind: "heads-checkpoint"; headRecordIds: readonly RecordId[] };
  priorHeads: readonly RecordId[];
  resultingHeads: readonly RecordId[];
}
```

Head arrays and `headRecordIds` are duplicate-free arrays sorted
lexicographically by Unicode code point. Their sorted form is included in JCS.

Genesis is:

```text
sequence = "0"
previousEntryId = null
priorHeads = []
```

Every later entry requires:

```text
current.journalId = previous.journalId
sequence = previous.sequence + 1
previousEntryId = previous.entryId
priorHeads = previous.resultingHeads
```

`journalId` partitions independent histories. A valid history has one genesis
for that ID, and every non-genesis entry resolves exactly one predecessor in
the same history. Array order in a bundle never supplies chronology.

For `record-committed`, resolve record `R`. Let `C` be the set of current heads
named by `R.inputs` with relation `consumes`; equivalently, only such producers
that occur in `priorHeads` are removed. Then:

```text
resultingHeads = sortUnique((priorHeads - C) union { R.recordId })
```

Deriving from an older non-head creates an additional head rather than deleting
an existing one. A multi-input transform can merge multiple current heads.
`uses` edges never retire their producer head.

Before appending the event, the recorder **MUST** recompute `R.recordId`, verify
at least one kind-required record signature, and require every input
`producerRecordId`—for both `consumes` and `uses`—to have appeared in an earlier
`record-committed` event in the same predecessor history. V1 has no trusted
import-checkpoint mechanism that can waive this ordering rule.
The inherited head set therefore contains only records whose IDs and required
signatures were verified when committed. This cryptographic check does not make
the record signer trusted unless policy and the out-of-band trust store do so.

For `heads-checkpoint`:

```text
headRecordIds = priorHeads = resultingHeads
```

The event advances and signs journal chronology without changing graph heads.

An append implementation checks the expected current entry and head set
atomically. Re-appending identical canonical bytes under the same ID may be
idempotent; different bytes under one ID are a fatal integrity failure.
A second `record-committed` event for a record already present in the same
history is invalid and **MUST NOT** consume a new sequence number. A retried
producer call returns the existing `CommittedRecord` after confirming exact
request equivalence.

### 10.2 Journal signatures

`JournalEntryEnvelope` contains schema
`loom.image-provenance.journal-envelope/v1`, computed `entryId`, body, and one
or more signatures.

The exact journal signature statement is:

```ts
{
  domain: "loom.image-provenance.journal-signature/v1";
  entryId: JournalEntryId;
  purpose: "journal-append";
  suite: "Ed25519" | "ES256";
  signerKeyFingerprint: Sha256Digest;
}
```

The message is exactly `UTF8(JCS(statement))`, using the same signature
encoding and SPKI-fingerprint rules as record signatures. The statement's
entry ID must equal the envelope entry ID. Journal-author authorization comes
from verifier configuration and/or the accepted witness profile, never from
the inline key alone.

Only a journal entry whose body ID was recomputed, whose statement binds that
same ID, whose required journal signature verifies, and whose predecessor/head
transition is valid may support an anchoring result. A valid-looking anchor
cannot rehabilitate a malformed, unsigned, discontinuous, or invalidly
transitioned journal entry.

### 10.3 Local limitations

A valid phone-local hash chain detects mutation and reordering in the entries
presented. It cannot alone detect:

- deletion of a suffix;
- presentation of an older valid tip;
- a privately maintained fork; or
- equivocation between verifiers.

Those require a previously remembered trusted checkpoint, a transparency log
with consistency checking, independent witness gossip, or a finality system.

Two body-and-ID-valid entries in the same journal with the same
`previousEntryId`, different `entryId` values, and at least one cryptographically
valid signature each from a trusted key authorized for `journal-append` are a
fork. A self-signed or otherwise unauthorized sibling is only a diagnostic and
cannot poison an authorized branch. A verifier **MUST NOT** silently pick among
authorized branches. It reports journal consistency invalid, unless a
configured witness/finality profile explicitly establishes which branch is
canonical under that profile. Even then, the losing authorized branch remains
evidence of equivocation. Conversely, absence of a sibling entry proves
nothing about a hidden fork, and a locally valid tip proves nothing about an
omitted suffix.

## 11. AnchorReceipt and optional Dregg witness

`AnchorReceipt` has:

```ts
{
  schema: "loom.image-provenance.anchor-receipt/v1";
  profileUri: Uri;
  witnessId: string;
  subjectEntryId: JournalEntryId;
  receipt: ExactBlob;
  checkpoint: ExactBlob;
  consistencyProof?: ExactBlob;
  witnessedAtClaim?: Rfc3339Timestamp;
}
```

The matching `WitnessVerifier`, selected from configured code by exact
`profileUri`, receives a `WitnessVerificationRequest` containing the immutable
anchor, the exact subject `JournalEntryEnvelope`, trusted-core readers for each
referenced proof blob, and core-validated forms of out-of-band
`TrustedCheckpoint` values plus the `TrustStore`. A configured checkpoint
contains its `ExactBlob` and canonical base64url `checkpointBytes`; the core
checks those bytes and replaces them with a `VerifiedBlobReader` before plugin
dispatch. A digest-only checkpoint is insufficient. The subject envelope's ID must equal `subjectEntryId`; the core first
recomputes and verifies that journal entry under Section 10.

The readers for `receipt`, `checkpoint`, and optional `consistencyProof` each
repeat the corresponding `ExactBlob`. `consume` is core-driven: it reaches EOF,
awaits the consumer for every immutable chunk, and rechecks digest and length
before resolving. The core accepts a result that depends on a reader only after
that reader has resolved successfully, so a plugin cannot turn a verified
prefix into a valid result. A verifier never receives a provider-selected
locator or unchecked bytes in place of these readers.
`consistencyProofBytes` is present if and only if `consistencyProof` is present.

```ts
interface VerifiedBlobReader {
  blob: ExactBlob;
  consume(
    consumer: (chunk: Readonly<Uint8Array>) => Promise<void>,
  ): Promise<void>;
}

interface WitnessVerificationRequest {
  receipt: AnchorReceipt;
  subjectEntry: JournalEntryEnvelope;
  receiptBytes: VerifiedBlobReader;
  checkpointBytes: VerifiedBlobReader;
  consistencyProofBytes?: VerifiedBlobReader;
  trustedCheckpoints: readonly VerifiedTrustedCheckpoint[];
  trust: TrustStore;
}

interface VerifiedTrustedCheckpoint {
  witnessId: string;
  profileUri: Uri;
  checkpoint: ExactBlob;
  checkpointBytes: VerifiedBlobReader;
}
```

The complete receipt object also has a process-local, domain-separated identity:

```text
anchorReceiptBytes = UTF8(JCS(anchorReceipt))
anchorReceiptDigest = "sha256:" || base64url(
  SHA-256(
    UTF8("loom.image-provenance.anchor-receipt-id/v1") ||
    0x00 ||
    anchorReceiptBytes
  )
)
```

`AnchorReceiptDigest` is not a new member of the bundle receipt. It is computed
by the trusted core over every present receipt field, including optional fields,
to bind a process-local verification result to exactly one immutable receipt.

It returns a process-local `WitnessResult` that binds
`anchorReceiptDigest`, `profileUri`, `witnessId`, and `subjectEntryId`, reports
`inclusion` and `consistency` separately, and may include `trustedTime` only
when the profile actually established it. The core **MUST** recompute and match
all four bindings to the request before using the result. A bare boolean or
bare set of "verified entry IDs" is not sufficient.

```ts
interface WitnessResult {
  anchorReceiptDigest: AnchorReceiptDigest;
  profileUri: Uri;
  witnessId: string;
  subjectEntryId: JournalEntryId;
  inclusion: CheckStatus;
  consistency: CheckStatus;
  trustedTime?: Rfc3339Timestamp;
  findings: readonly VerificationFinding[];
}
```

An inclusion-valid receipt for a valid subject entry transitively anchors the
verified predecessor chain because each entry commits its predecessor ID.
`requireEveryReachableRecordAnchored` therefore requires every reachable record
to have a valid commit event on such a chain; it does not require one direct
receipt per record. `requireJournalConsistency` additionally requires a
`consistency: "valid"` result under an accepted profile, a configured prior
checkpoint when that profile requires one, and authorized journal signatures
through the relevant chain.

The verifier **MUST** establish that receipt and checkpoint cryptographically
bind the subject entry. If consistency is required, it also checks the supplied
proof against a previously trusted checkpoint or independent witness. An
inclusion proof paired only with a self-supplied key/checkpoint does not
establish trust or prevent a split view.

`witnessedAtClaim` is a claim unless the profile establishes trusted/finality
time. A trusted witness time proves the commitment existed no later than that
time; it does not prove the camera fired then. A trusted nonce issued at `T0`
and witness at `T1` can bound freshness to the interval, subject to the
evidence profile's assumptions.

`loom.image-provenance/witness/dregg/v1` is reserved as an optional witness
profile. A conforming Dregg adapter:

1. submits the journal-entry commitment through a capability-gated Dregg turn;
2. returns exact receipt, checkpoint, and optional consistency-proof blobs;
3. binds the Dregg federation/domain and commitment context;
4. verifies against a Dregg trust anchor supplied outside the bundle; and
5. reports only the authorized append/state-continuity guarantees it checked.

The generic core has no Dregg dependency. A Dregg receipt does not itself prove
sensor origin, transform execution, scene truth, trusted time, or ownership.
Image bytes should remain off-ledger in content-addressed storage.

## 12. Bundle and root selection

`ProvenanceBundle` has the exact fields:

```ts
{
  schema: "loom.image-provenance.bundle/v1";
  records: readonly ProvenanceRecordEnvelope[];
  journalEntries: readonly JournalEntryEnvelope[];
  endorsements: readonly RecordEndorsement[];
  anchors: readonly AnchorReceipt[];
  blobs: readonly BlobLocation[];
  suggestedRoots?: readonly OutputPointer[];
}
```

All five collection fields are present, even when empty. Array order carries no
graph, journal, trust, or “latest” meaning.

Indexing records and journal entries is order-independent. Before an envelope
can participate in an ID bucket, its body is strictly validated and its ID is
recomputed. ID-mismatched or malformed candidates are diagnostic junk; they
cannot poison a separate ID-valid envelope merely by copying its claimed ID.
Envelopes with the same recomputed object ID, schema, and canonically identical
body may then be coalesced; their additive signature objects are unioned and
canonically deduplicated. An exact duplicate transport envelope is therefore
idempotent, although JSON Schema `uniqueItems` remains a useful
transport-hygiene check. Two distinct bodies that independently recompute to
the same ID are a hash-collision conflict, not alternative versions.

A `BlobLocation` repeats `ExactBlob` and may have inline base64url bytes,
locations, both, or neither. Every supplied byte source is untrusted until its
length and SHA-256 match. A missing byte source is `not-present` or
`indeterminate`, not a hash mismatch.

`suggestedRoots` is a UI/transport hint. Verification always starts from a
caller-selected:

```ts
interface OutputPointer {
  recordId: RecordId;
  outputName: string;
}
```

The verifier **MUST NOT** infer the target from the last bundle item, the
largest timestamp/sequence, or a suggested root. A trusted UI choice, expected
file digest, signed distribution statement, or policy-selected journal head
can supply the pointer.

Only records reachable from the selected output through `consumes` and `uses`
edges affect that verification decision. Unreachable extra records and
attachments are ignored or reported separately; malicious unrelated objects
cannot invalidate or launder themselves into the selected lineage.

If selection begins from final bytes, a verifier may enumerate outputs with the
matching exact artifact. Multiple matches are ambiguous and cannot be resolved
silently.

## 13. VerificationPolicy

Policy is caller supplied and is never learned from the artifact:

```ts
interface VerificationPolicy {
  schema: "loom.image-provenance.verification-policy/v1";
  trustedSignatureRequiredFor: readonly
    ("capture" | "source" | "transform")[];
  allowedSourceRoots: readonly ("capture" | "source")[];
  minimumOriginAssurance:
    | "self-declared"
    | "app-attested"
    | "os-attested"
    | "sensor-path-attested";
  requireVerifiedCaptureBoundary: boolean;
  requireEveryReachableRecordAnchored: boolean;
  requireJournalConsistency: boolean;
  requireDisclosedParameters: boolean;
  requireHermeticTransforms: boolean;
  replayRequirement: "none" | "when-claimed" | "every-transform";
  limits: {
    maxBundleObjects: NonNegativeDecimalInteger;
    maxRecords: NonNegativeDecimalInteger;
    maxDepth: NonNegativeDecimalInteger;
    maxReferencedBytes: NonNegativeDecimalInteger;
    maxBlobCandidatesPerDigest: NonNegativeDecimalInteger;
    maxVerificationBytes: NonNegativeDecimalInteger;
  };
}
```

Limit fields are non-negative decimal strings. `maxBundleObjects` bounds the
sum of elements in the bundle's five required collection arrays: `records`,
`journalEntries`, `endorsements`, `anchors`, and `blobs`. `maxRecords` is the
additional record-array bound; `maxDepth` bounds graph traversal; and
`maxReferencedBytes` bounds the aggregate exact byte lengths selected for
resolution. `maxBlobCandidatesPerDigest` bounds alternative transport
locations for one digest, while `maxVerificationBytes` bounds the actual
candidate bytes decoded or hashed across the decision. These latter two limits
prevent repeated wrong candidates from multiplying work beyond the committed
artifact size. Implementations apply these limits before indexing, recursive
resolution, decoding, hashing, or large allocation. Independent parser byte, nesting, string,
member, and array limits also apply to the entire transport, including
`suggestedRoots`, before a bundle object is materialized.

When `requireVerifiedCaptureBoundary` is true, every content-ancestry capture
must have `boundaryBinding: "valid"` from the verifier registered for its exact
`serializationProfileUri`. Merely signing a boundary label does not satisfy
this policy.

Trust configuration supplies exact signing keys, purpose authorization,
validity/revocation data, accepted evidence profiles, accepted witness
profiles, and trusted checkpoints. A trust anchor inside the bundle is merely
untrusted input unless it matches that configuration.

## 14. Root-scoped verification

A conforming verifier performs the following steps:

1. **Parse and bound.** Parse JSON with duplicate-key detection and enforce
   global resource limits before indexing. Enforce NFC, number-free values,
   CDDL shape, and canonical lexical values on every signed object that enters
   the selected graph, relevant journal chain, or accepted proof path. Report
   malformed unreachable attachments without letting them decide the
   root-scoped verdict unless they prevent safe parsing or bounding.
2. **Index.** Strictly validate and recompute each candidate ID, discarding
   malformed or ID-mismatched candidates as non-authoritative diagnostics,
   then index valid record and journal-entry IDs without trusting order.
   Coalesce same-schema envelopes only when their bodies are canonically
   identical, unioning their additive signatures. An actual collision between
   two independently ID-valid bodies under a reachable record ID is fatal; an
   unreachable collision is diagnostic only. A colliding journal entry is
   unusable for chronology or anchoring, but remains diagnostic when a separate
   sufficient valid anchored chain covers policy.
3. **Select root.** Require the external `OutputPointer` to resolve to exactly
   one named output.
4. **Recompute IDs.** JCS-project every reachable body and recompute record
   IDs.
5. **Traverse graph.** Build a dependency closure by following both edge
   relations, enforce source-root policy across that closure, detect cycles,
   and validate exact `expectedArtifact` equality. Separately build the
   content-origin closure by following only `consumes`; a transform with no
   such path is not a content root and generated bytes require an explicit
   `SourceRecord`.
6. **Verify bytes.** For every supplied reachable blob, check non-negative
   length and SHA-256. Distinguish missing bytes from mismatched bytes.
7. **Verify signatures.** Check exact statements, purposes, suites, SPKI
   fingerprints, signatures, trust, validity, and revocation independently.
   When configured key intervals apply, evaluate them at the caller-supplied
   `verificationTime`; omission makes that trust decision indeterminate.
8. **Verify capture boundaries.** Dispatch each capture to the verifier for its
   exact serialization profile and report boundary binding separately from
   sensor-origin assurance.
9. **Verify evidence.** Recompute attachment digests, provide verified blob
   readers, and dispatch only to locally registered exact-profile verifiers.
   Match result digests and compare established bindings and capture assurance
   with policy.
10. **Verify critical extensions.** Invoke the exact-URI record verifier for
    each reachable critical extension; never substitute a global recognized-name
    set for a result bound to that record and value.
11. **Verify operation semantics.** Resolve and recompute operation descriptors
    by digest, then use the exact-URI verifier to validate roles, parameters,
    and registered semantics.
12. **Verify execution.** Use only subject-bound results minted by configured
    replay or proof/attestation evidence verifiers when policy requires them.
    Never promote a signed declaration or an untrusted preverified-result map.
13. **Verify journal.** For relevant entries, check IDs, statement signatures,
    sequence/predecessor links, event rules, and head transitions.
14. **Verify anchors.** Recompute each complete anchor-receipt digest, pair it
    with its already-verified subject entry and verified proof-blob readers,
    and dispatch only accepted witness profiles with configured checkpoints.
    Match every returned receipt/profile/witness/subject binding and validate
    required inclusion, consistency, and finality.
15. **Decide policy.** Produce orthogonal results, then derive `accept`,
    `reject`, or `indeterminate`.

The requested root and all reachable edges are the scope. “Complete lineage”
means graph closure relative to that root and disclosed boundary. It does not
prove there is no unpublished alternative branch or later journal state.

Status semantics are:

- `valid`: the stated check succeeded;
- `invalid`: supplied material contradicts or fails the check;
- `indeterminate`: available facts cannot satisfy or refute the policy;
- `unsupported`: the implementation does not understand required semantics;
- `not-present`: no applicable material was supplied.

Unsupported or absent evidence is not silently converted to valid. A valid
signature by an untrusted key is not silently converted to invalid
cryptography.

Verification requirements are coverage-based. A malformed or invalid optional
signature, journal candidate, endorsement, anchor, or other attachment is
reported, but cannot poison a separate sufficient valid proof set merely by
being included by an attacker.

## 15. VerificationReport

The result is exactly:

```ts
interface VerificationReport {
  schema: "loom.image-provenance.verification-report/v1";
  verdict: "accept" | "reject" | "indeterminate";
  rootOutput: OutputPointer;
  structural: CheckStatus;
  byteIntegrity: CheckStatus;
  signatures: CheckStatus;
  lineage: "complete" | "partial" | "broken";
  anchoring: CheckStatus;
  captureEvidence: {
    contentRoots: readonly ContentRootVerification[];
    contentComposition: "capture-only" | "source-only" | "mixed" | "not-reached";
    captures: readonly CaptureVerification[];
    minimumRequired: OriginAssurance;
    weakestOriginAssurance: OriginAssurance | "not-reached";
    allCapturesSatisfyMinimum: CheckStatus;
  };
  records: readonly RecordVerification[];
  findings: readonly VerificationFinding[];
}

interface ContentRootVerification {
  recordId: RecordId;
  kind: "capture" | "source";
  sourceType?: "imported" | "generated" | "external-provenance";
}

interface RecordVerification {
  recordId: RecordId;
  structure: CheckStatus;
  signature: CheckStatus;
  signerTrust: CheckStatus;
  artifacts: CheckStatus;
  operationSemantics: CheckStatus;
  execution:
    | "declared"
    | "replayed-exact"
    | "replayed-within-tolerance"
    | "proof-verified"
    | "execution-attested"
    | "not-reproducible";
}

interface CaptureVerification {
  recordId: RecordId;
  acquisitionBoundary: CaptureBoundary;
  originAssurance: OriginAssurance;
  boundaryBinding: CheckStatus;
  appIdentity: CheckStatus;
  osBinding: CheckStatus;
  keyProtection: CheckStatus;
  sensorBinding: CheckStatus;
  freshness: CheckStatus;
  time: CheckStatus;
  location: CheckStatus;
}
```

Each `RecordVerification` reports structure, signature, signer trust,
artifacts, operation semantics, and execution independently. For capture and
source records, `operationSemantics` is `not-present`. Stable finding codes are
the exact union in `types.ts` and `contract.cddl`; v1 does not invent
unnamespaced ad-hoc codes.

`captureEvidence.captures` has one result for every capture in the
`consumes`-only content-origin closure. Captures reached only through `uses`
remain in dependency integrity/signature diagnostics but cannot raise the
selected output's origin assurance.
`contentRoots` lists every capture and explicit source root in that closure,
and `contentComposition` makes capture-only, source-only, and mixed content
unambiguous. `weakestOriginAssurance` is the weakest assurance among the listed
capture ingredients only; it is never a claim that a `mixed` or `source-only`
output is wholly camera-origin. A camera-only policy uses
`allowedSourceRoots: ["capture"]`.
`minimumRequired` repeats the caller's policy, `weakestOriginAssurance` is the
minimum across those captures, and `allCapturesSatisfyMinimum` states the
aggregate check. With no reachable capture, `captures` is empty and
`weakestOriginAssurance` is `not-reached`; source-root policy still decides
whether that graph is acceptable.

An implementation **MUST NOT** replace this evidence matrix with
`authentic: true`. In particular:

- exact bytes can be `valid` while sensor binding is `not-present`;
- app identity can be `valid` while OS binding is `not-present`;
- signatures can be `valid` while signer trust is `indeterminate`;
- lineage can be `complete` while execution remains `declared`; and
- a journal can be internally valid while anchoring is `not-present`.

## 16. Platform-neutral ports

The TypeScript interfaces assign responsibility as follows:

- `ProvenanceBundleParser` accepts exact UTF-8 JSON bytes plus required
  `BundleParseLimits`. It rejects duplicate object keys, invalid UTF-8, JSON
  numbers in the signed value space, excessive raw bytes, nesting, strings,
  members, array items, or total values before constructing a
  `ProvenanceBundle`. The public `Verifier` accepts bytes, never an object from
  an ambient permissive JSON parser. At method entry it synchronously copies or
  exclusively transfers those bytes into non-shared core-owned storage before
  parsing; `SharedArrayBuffer`-backed input is rejected unless an atomic
  immutable snapshot is first made.
- `BlobLocation.locations` values are inert transport hints to the core. The
  core never dereferences one itself. An optional caller-configured
  `BlobResolver` may open them under an explicit scheme/host, DNS rebinding,
  private/link-local address, redirect, timeout, and streamed-byte policy. It
  must reject `file:` and other local-capability schemes by default. The core
  synchronously copies every yielded chunk into non-shared owned memory before
  hashing or awaiting, applies `maxVerificationBytes` while streaming, and recomputes exact length
  and SHA-256 before minting a `VerifiedBlobReader`; a resolver's success is
  never byte integrity.
- The trusted orchestrator owns `ArtifactStore` and every `ArtifactWriter`.
  A provider sees only the writer's `ArtifactSink`, which exposes `write` but
  cannot seal, abort, or inspect store state. `ArtifactWriter.seal()` computes
  the exact blob and returns a process-local `SealedArtifact`; providers never
  submit an authoritative digest or byte length.
- `ArtifactSink.write` accepts `Readonly<Uint8Array>`. At invocation, the sink
  synchronously copies the referenced bytes or takes exclusive ownership
  before returning control; TypeScript `readonly` alone does not prevent
  mutation through an alias. Providers issue and await writes serially per
  sink, and the store defensively linearizes accepted writes in invocation
  order.
- A writer starts `open`. `seal()` linearizes after all accepted writes,
  changes `open` to `sealing`, rejects later writes, and finally changes to
  `sealed`. Concurrent or repeated `seal()` calls while `sealing` or `sealed`
  resolve to the same immutable `SealedArtifact`. `abort()` linearized while
  `open` discards staged bytes and makes `aborted` terminal; repeated abort is
  idempotent, while sealing an aborted writer or aborting a sealing/sealed
  writer rejects. Every write after `sealed` or `aborted` rejects.
- `CaptureProvider.begin(intent)` receives no store. `CaptureSession.capture`
  writes only through the `ShotRequest.outputSinks` supplied by the trusted
  orchestrator and returns a `CaptureDraft`. `CaptureIntent.outputs` is a
  non-empty trusted plan of output name, media type, role, representation, and
  optional layout. The orchestrator opens each writer with that planned media
  type; `ShotRequest.outputs` repeats the exact frozen plan and its sink keys
  match it one-for-one before the provider receives either value.
- `CaptureDraft`, `SourceDraft`, and `TransformDraft` carry a body with
  `outputs` omitted plus a non-empty tuple of `OutputDeclaration` values. They
  do not carry final `ExactBlob` values. Each declaration includes media type
  and must exactly match the trusted request plan before sealed bytes are
  joined.
- Each `SealedOutput` pairs an output name with a core-minted sealed artifact.
  The recorder requires a one-to-one, duplicate-free match with the draft's
  declarations. Each receipt must come from the same trusted store/session and
  exact writer allocated for that producer invocation and output name. The
  recorder then constructs `NamedOutput` values in declaration order.
- `OperationProvider` exposes the pinned descriptor and executes a
  `TransformRequest` into caller-provided sinks. Every request has one or more
  `TransformInput` values containing an edge and a core-controlled
  `VerifiedBlobReader` for exactly that edge's `expectedArtifact`, plus the
  requested parameters, immutable `OperationDescriptor` snapshot, and a
  non-empty frozen output plan whose roles are admitted by that descriptor. A
  transform cannot complete successfully until every required reader has
  consumed and reverified its full input.
- `ProofProvider` signs a `RecordSignatureStatement`; `JournalProofProvider`
  signs a `JournalSignatureStatement`. They return `RecordSignature` and
  `JournalSignature`, respectively.
- `ProvenanceRecorder.commitCapture`, `commitSource`, and `commitTransform`
  each accept the draft, a non-empty sealed-output tuple, both proof providers,
  and the relevant trusted request context (`CaptureIntent` plus `ShotRequest`,
  or `TransformRequest`). Before signing, the recorder checks that the draft
  preserves that context, the frozen output names, and the pinned operation
  identity. It atomically persists and returns a `CommittedRecord` containing
  the record and its `record-committed` journal entry.
  `appendHeadsCheckpoint` is the only standalone journal append port.
- `ProvenanceRecorder.anchor` resolves the signed entry and passes its complete
  `JournalEntryEnvelope` to a selected `WitnessSink`; an entry ID alone is not
  the witness payload.
- `EvidenceVerifier` handles body evidence and post-record endorsements for one
  exact profile URI. It accepts an `EvidenceVerificationRequest` with
  core-derived context and a verified blob reader, and its digest-bound
  `EvidenceResult` may carry
  `VerifiedCaptureEvidence` or `VerifiedExecution` only when that profile
  established the subject binding and corresponding facts.
- A signature `publicKeyRef` is resolved only by a configured
  `PublicKeyResolver` registered for that exact evidence profile. Its result is
  bound to the domain-separated attachment digest, profile URI, and expected
  signer fingerprint. The trusted core then independently parses DER SPKI,
  recomputes the fingerprint, and verifies the signature. A resolver result
  never grants trust; purpose authorization and key trust still come only from
  the caller's trust store.
- `OperationDescriptorResolver` resolves and rehashes a transform's immutable
  descriptor; `OperationSemanticsVerifier` validates one exact operation URI
  and returns a record-and-descriptor-bound `VerifiedOperation`.
- `CriticalExtensionVerifier` validates one exact record-extension URI, while
  `CaptureBoundaryVerifier` validates one exact capture serialization profile.
- `WitnessVerifier` handles one exact anchor profile using out-of-band trusted
  checkpoints. It accepts a `WitnessVerificationRequest` with the exact subject
  entry and trusted-core `VerifiedBlobReader` values, then returns a
  receipt-and-subject-bound `WitnessResult`, not a bare status.
- `Verifier.verify` requires external `rootOutput`, exact `bundleBytes`, parser
  limits, policy, and trust store, plus optional `verificationTime`, trusted
  checkpoints, a blob resolver, public-key/evidence/witness verifiers,
  descriptor resolver, operation-semantics verifiers, critical-extension
  verifiers, and capture-boundary verifiers.

At every async plugin boundary, the trusted core deep-copies and deeply freezes,
or takes an equivalent immutable snapshot of, all plain-data request,
descriptor, policy, checkpoint, and trust inputs before passing them to
provider, proof, resolver, or verifier code. It likewise snapshots and
revalidates every returned draft or result before any later asynchronous call.
Capability objects such as sinks and readers keep stable,
non-provider-forgeable identities. Neither TypeScript `readonly` nor a shallow
`Object.freeze` is a security boundary.

A `VerifiedBlobReader` retains only the core-owned verified snapshot and gives
each consumer callback a fresh non-shared copy (or an equivalent immutable
exclusive transfer). It never exposes storage still aliased by a resolver,
provider, caller, or another consumer, and it rechecks full length and digest
through EOF before accepting the consumer result.

`BundleParseLimits`, `ProvenanceBundleParser`, `BlobResolver` and its stream,
`ArtifactSink`, `SealedArtifact`, `SealedOutput`, drafts, provider
requests/results, `EvidenceAttachmentDigest`, `EvidenceVerificationRequest`,
`EvidenceResult`, `VerifiedCaptureEvidence`, `VerifiedExecution`, operation and
extension verifier results including `VerifiedOperation`, public-key resolver
requests/results,
`AnchorReceiptDigest`, `VerifiedBlobReader`,
`VerifiedTrustedCheckpoint`, `WitnessVerificationRequest`, and `WitnessResult` are process-local port
values, not wire objects, so they do not appear in `contract.cddl`. The
`__sealedArtifactBrand` must be unforgeable at the trusted storage boundary; a
TypeScript assertion or provider-constructed lookalike is not sufficient. A
recorded output does not become exportable until its writer is sealed and the
record plus journal entry are durably committed. Staged unreferenced blobs may
be garbage-collected under recovery policy.

## 17. Threat semantics

| Threat | V1 detection or mitigation | Residual |
| --- | --- | --- |
| Post-commit byte or metadata edit | SHA-256, record ID, signature | Compromised signer can create a new signed claim |
| Middle-node deletion or edge substitution | Exact producer/output/artifact edge traversal | Entirely new trusted-looking roots depend on origin evidence |
| Declared capture-boundary spoof | Exact serialization-profile verifier and `boundaryBinding` | Profile guarantees may still stop short of sensor origin |
| Reused operation URI/version | Descriptor digest, resolver, exact-URI semantics verifier | Trust still depends on the registered semantics implementation |
| Evidence or witness result substitution | Domain-separated attachment/receipt digest plus subject bindings | A compromised configured verifier can still lie |
| Bundle reorder | No semantic dependence on bundle order | Journal order must be checked separately |
| Journal reorder or edit | Entry IDs, signatures, predecessor and head rules | Local valid suffix truncation is still possible |
| Replay or backdating | Trusted challenge plus witnessed checkpoint | Device timestamps alone are claims |
| Hidden transform inputs | Hermetic profile and execution proof | Unconstrained execution remains declared only |
| Named but unexecuted code | Replay, proof, or execution attestation | Implementation digest alone proves no execution |
| Key compromise | Short-lived keys, attestation, revocation policy | Valid malicious signatures before known revocation may remain |
| Witness equivocation | Prior checkpoint, consistency proof, independent witness | A first-contact single-log bundle cannot rule out split view |
| Blob withholding | Commitment remains; report `not-present` | Content and replay cannot be independently checked |
| Sensitive metadata disclosure | Optional claims, committed parameters, selective blobs | Stable digests may leak equality |

## 18. Compatibility

- Exact v1 schema/domain strings never change meaning.
- Unknown major versions return `unsupported`.
- Additive non-critical extensions may be preserved and ignored.
- Unknown critical extensions never pass silently.
- Operation meaning is pinned by descriptor digest, not SemVer alone.
- Evidence, replay, witness, and future C2PA profiles version independently.
- Hash or canonicalization changes require a new version/domain.
- Corrections, migrations, redactions, exports, and endorsements create new
  records or attachments; they never rewrite a historical identifier.
- Lossless relays preserve unknown fields and exact blob bytes.

## 19. Minimum conformance vectors

A conformance suite should cover:

- identical JCS, record IDs, journal IDs, and key fingerprints across
  independent implementations;
- NFC rejection without normalization;
- rejection of every JSON number in signed bodies/statements;
- canonical tagged decimals with positive and negative scales;
- Ed25519 and raw P1363 ES256 signatures;
- signature-purpose relabeling, signer-key mismatch, stripping, and revocation;
- one capture-to-transform path and one multi-input graph;
- source roots for imported/generated/external provenance;
- `uses`-only camera-origin laundering, mixed capture/source content roots,
  and capture evidence that omits one of a capture's outputs;
- a changed byte, length, parameter, representation, layout, output name, and
  producer record;
- missing nodes, cycles, duplicate IDs, and resource-limit exhaustion;
- body-referenced evidence versus post-record endorsement cycle avoidance;
- evidence-result substitution across attachments or target records;
- undisclosed parameters, non-hermetic transforms, false replay claims, and
  mismatched execution proofs;
- descriptor digest/identity mismatch, unknown operation semantics, a
  `VerifiedOperation` substituted across record or descriptor identities, and
  a critical-extension result reused for another record;
- an unverified capture-boundary label and a composite whose weakest capture
  is below the required origin assurance;
- changed/deleted/reordered journal entries and invalid head transitions;
- a reverse-topological journal that commits a transform before either a
  `consumes` or `uses` producer;
- missing, untrusted, inconsistent, and equivocal witness checkpoints;
- a trusted journal fork before and after an otherwise valid anchored tip;
- witness-result substitution across two receipts for the same subject entry;
- ID-mismatched duplicate envelopes that cannot poison valid candidates, and
  bounded multiple blob candidates whose order cannot change the verdict;
- unreachable hostile records that do not affect the selected root; and
- valid byte integrity with `self-declared` origin and absent sensor binding.

## 20. CDDL cross-check

| Concept | CDDL rule |
| --- | --- |
| Signed bodies | `capture-record-body`, `source-record-body`, `transform-record-body` |
| Artifact identity | `exact-blob`, `artifact-ref`, `named-output` |
| Graph edge | `input-edge` |
| Signatures | `record-signature-statement`, `record-signature`, `journal-signature-statement` |
| Post-record proof/evidence | `record-endorsement`, `evidence-binding` |
| Append chronology | `journal-entry-body`, `journal-entry-envelope` |
| External witness | `anchor-receipt` |
| Root-selected transport | `output-pointer`, `provenance-bundle` |
| Policy and result | `verification-policy`, `verification-report` |
| Number-free values | `canonical-value`, `canonical-decimal`, `canonical-bytes` |

CDDL expresses shape. NFC, duplicate-key rejection, hashes, signatures,
canonical equality, array sorting, graph closure, cycle detection, journal
transition equations, evidence bindings, trust, and policy evaluation remain
the semantic rules in this document.
