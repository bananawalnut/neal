# Initiative 003 — Loom mobile image provenance

## Outcome

Define a portable, contract-first system that preserves the exact bytes received at a mobile capture boundary and records every later enhancement as a verifiable provenance graph. The first deliverable is the platform-neutral contract and verifier surface, not an iOS- or Android-specific camera implementation.

The core must remain useful for any image workflow. Loom, NEAL, DREGG, a particular phone vendor, and a particular editor may supply profiles or adapters, but none belongs in the generic record model.

## What the proof can honestly say

The system can prove that:

1. an identified producer committed to a specific byte sequence at a declared boundary;
2. the committed bytes match a supplied artifact;
3. every declared input and output in the enhancement graph is linked by exact digest;
4. record signatures, execution evidence, and optional witness receipts validate under an explicit trust policy; and
5. the verifier found a complete, partial, broken, or indeterminate path to the selected output.

It must not turn those facts into a stronger camera claim. On ordinary iOS and Android devices, an application can usually attest only to bytes delivered by an OS API. An application signature, app/device integrity attestation, timestamp, EXIF block, or C2PA manifest does not by itself prove that photons reached a particular physical sensor or that no opaque upstream processing occurred.

The capture record therefore names the observed boundary—such as `os-encoded-asset`, `os-pixel-buffer`, `os-raw`, or `sensor-samples`—and separately records the evidence available for it. `sensor-path-attested` is valid only when a trusted evidence profile cryptographically binds the artifact to a documented sensor-to-output path. Commodity-platform adapters must not claim it merely because they invoked a camera API.

Imported, downloaded, generated, or otherwise external images enter through an explicit source record. They are never relabelled as local captures.

## Product experience

The interface should make assurance inspectable rather than reduce provenance to a green badge:

1. Capture or import an image.
2. Seal the exact bytes immediately through the trusted artifact writer.
3. Show every content-ancestry capture's declared boundary and evidence matrix,
   plus the weakest verified origin assurance across them.
4. Apply enhancements through generic operation providers.
5. Display a directed graph of inputs, resource dependencies, transforms, and outputs.
6. Export the selected artifact with a portable provenance bundle and, when requested, a C2PA 2.4 representation.
7. Verify the bundle independently and report byte integrity, lineage, signatures, capture evidence, replay/proof status, and witnessing as separate results.

Unknown evidence, algorithms, critical extensions, or trust roots produce `unsupported` or `indeterminate`, never an optimistic success.

## Architecture

### Generic core

The core ports are defined in the [v1 contract](../../specs/image-provenance/v1/CONTRACT.md) and [TypeScript interface](../../specs/image-provenance/v1/types.ts):

- `ArtifactStore` and `ArtifactWriter` compute digest and byte length inside the trusted core; providers receive only write-only `ArtifactSink` capabilities and cannot seal or author commitments.
- `CaptureProvider` and `CaptureSession` expose platform capture capabilities and return a capture draft without deciding its trust level.
- `OperationProvider` declares an immutable operation descriptor and executes one generic enhancement.
- `ProvenanceRecorder` commits records, appends the signed journal, and optionally submits a journal entry to a witness.
- `EvidenceVerifier` validates profile-specific capture or execution evidence, `PublicKeyResolver` handles exact-profile referenced keys, and `WitnessVerifier` validates witness receipts against configured checkpoints.
- `ProvenanceBundleParser` accepts exact transport bytes under hostile-input limits, while an optional caller-configured `BlobResolver` handles inert external locations under SSRF and streaming limits before the core rehashes bytes.
- `WitnessSink` appends an already-committed journal entry to an optional external witness.
- `Verifier.verify` begins from an externally selected root output and exact bundle bytes, then evaluates the reachable graph against explicit parser limits, policy, and trust store.

Platform adapters depend on these ports. The core never depends on UIKit, AVFoundation, CameraX, Android Camera2, a C2PA SDK, a ledger, or a hosted service.

### Provenance DAG

The enhancement history is a directed acyclic graph, not merely a mutable list. Each record has named outputs, and each transform edge identifies:

- the producing record and output name;
- the exact expected artifact digest, length, media type, representation, and layout;
- an operation-defined role such as `primary`, `mask`, `depth`, `lut`, or `model`; and
- whether the input is content lineage (`consumes`) or an implementation resource (`uses`).

This supports crops and filters as well as HDR merges, masks, compositing, model-assisted enhancement, colour transforms, and multiple renditions. Array order and a bundle's suggested roots carry no trust semantics. The verifier chooses the root, validates every reachable edge, rejects cycles, and reports missing ancestry.

In v1, every `consumes` input must contribute to every output in its transform
record. Operations whose outputs have different dependency sets split those
outputs into separate records. The verifier checks all `uses` dependencies but
never counts them toward camera-origin assurance.

Record bodies are content-addressed independently from later signatures and endorsements. A signed append-only journal can record commit order, while an external witness can add evidence of publication or ordering without rewriting the provenance DAG. Neither journal sequence nor a witness time claim is trusted time unless its profile establishes that property.

### Capture transaction

The capture path follows a narrow ownership boundary:

1. The caller selects a declared boundary and optional freshness challenge.
2. The trusted core opens output writers and gives the platform provider only their write-only sinks.
3. The platform provider writes the exact bytes it receives; it cannot seal the writer or submit a precomputed digest as fact.
4. The core seals the artifact, builds the capture record, and verifies that the draft declarations match the sealed outputs.
5. A proof provider signs the domain-separated record statement.
6. The recorder appends a journal entry before the artifact is handed to enhancement code.

A crash may leave an uncommitted blob for garbage collection, but it must never create a committed record that points at partially written or different bytes.

## C2PA 2.4 adapter

C2PA is an interoperability adapter, not a replacement for the native graph. The target is the [C2PA Technical Specification 2.4](https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html).

The adapter should:

- export supported capture and transform records as C2PA claims, actions, ingredients, assertions, and hard bindings;
- preserve signer and validation information without upgrading an untrusted assertion into a verified fact;
- import a validated C2PA ingredient or manifest as external evidence or an external-provenance source record;
- preserve the original C2PA manifest bytes by digest when the native graph cannot express every assertion losslessly;
- distinguish an embedded manifest, an external manifest, and a missing or stripped manifest; and
- report mapping omissions and unsupported critical semantics.

A valid C2PA signature establishes integrity and signer information under C2PA's trust model. It does not automatically establish physical sensor origin, truthful metadata, trusted time, or correctness of an enhancement. Those remain policy- and evidence-specific findings.

## Optional Dregg witnessing

Dregg may be explored as an implementation of the `WitnessSink` profile `loom.image-provenance/witness/dregg/v1`. The core submits the complete signed journal-entry envelope and receives an opaque, content-addressed witness receipt plus checkpoint and any consistency proof required by the profile.

Dregg is optional. A bundle remains structurally and cryptographically verifiable without it, and no producer or consumer may require DREGG tokens, a NEAL wallet, or chain connectivity to use the core contract.

The Dregg witness profile is active research and is not audit-ready. Until its protocol, trust anchors, finality semantics, privacy properties, costs, failure recovery, and independent security review are complete:

- it must be disabled by default in production;
- receipts must be labelled experimental;
- an unavailable or untrusted Dregg verifier yields `unsupported` or `indeterminate` anchoring;
- a Dregg receipt must not be presented as camera-origin, transform-correctness, ownership, or trusted-time proof; and
- the original signed journal and artifacts remain independently exportable.

## Privacy and safety boundaries

- Location, wall-clock time, device identity, camera settings, and stable actor identifiers are optional claims with explicit disclosure controls.
- Default exports should omit precise location and stable hardware identifiers.
- Trust comes from configured roots and evidence verifiers, never from a public key carried inside the same untrusted bundle.
- Verification must be offline-capable when all required artifacts, evidence, keys, and checkpoints are supplied.
- Capture never silently uploads, anchors, or publishes content. External witnessing and C2PA repository use require explicit policy and user intent.
- Provenance describes history and evidence; it does not determine whether the depicted event is true, ethical, authorized, or non-misleading.

## Delivery phases

### Phase 0 — freeze the contract

- Review the normative prose, CDDL, TypeScript ports, JSON Schema, and deterministic fixtures.
- Freeze canonicalization, domain separation, digest encoding, extension rules, and verifier status vocabulary.
- Threat-model hash cycles, substitution, graph splicing, replay, key compromise, metadata leakage, and resource exhaustion.

Exit gate: two independent implementations derive identical identifiers and reject the same malformed fixtures.

### Phase 1 — local provenance MVP

- Implement streaming artifact storage, capture/source/transform commits, signatures, journal append, bundle export, and independent verification.
- Support a minimal linear pipeline plus one multi-input transform.
- Ship tamper, deletion, reorder, cycle, unknown-extension, and missing-artifact fixtures.

Exit gate: an offline verifier reconstructs the selected output's complete reachable lineage and detects every fixture mutation.

### Phase 2 — mobile capture adapters

- Add one iOS and one Android adapter in their actual application repositories.
- Record the strongest boundary each API really exposes and preserve opaque upstream-processing disclosure.
- Integrate available app/device attestation only through named evidence profiles.
- Exercise capture interruption, storage pressure, permission denial, backgrounding, and key rotation.

Exit gate: each adapter proves exact bytes from its declared application/OS boundary and never claims unsupported sensor origin.

### Phase 3 — generic enhancement providers

- Register operation descriptors for crop, orientation, colour conversion, resize, and one multi-input operation.
- Add bit-exact replay where practical and tolerance profiles or explicit non-replayability elsewhere.
- Bind models, LUTs, colour profiles, masks, and other dependencies through `uses` edges.

Exit gate: changing parameters, implementation identity, dependencies, inputs, or output bytes invalidates the affected verification path.

### Phase 4 — interoperability and witnessing

- Implement and cross-test the C2PA 2.4 import/export adapter.
- Prototype Dregg behind the optional `WitnessSink` interface.
- Complete an independent security and privacy review before either adapter becomes a default trust path.

Exit gate: supported C2PA lineage round-trips without silent claim promotion, and disabling Dregg has no effect on core verification.

## Acceptance criteria

- The original artifact bytes are retained or explicitly declared unavailable; their exact digest and byte length are immutable.
- A capture report never claims a stronger boundary or assurance level than validated evidence establishes.
- Commodity iOS and Android capture is not described as physical sensor proof without a separately trusted sensor-binding profile.
- Every transform references exact named producer outputs, and every reachable edge validates.
- Multi-input operations and multi-output operations with shared content ancestry work without flattening lineage; differing output dependency sets are split into separate records.
- Cycles, graph splicing, missing parents, artifact substitutions, changed parameters, invalid signatures, and unknown critical extensions fail closed.
- Timestamps and locations remain claims unless independently verified.
- A verifier can operate from an externally selected root and an explicit trust policy; bundle order and suggested roots are untrusted.
- C2PA 2.4 export and import preserve supported provenance and visibly report lossy mappings.
- Dregg is replaceable, optional, and clearly experimental until audited.
- A complete bundle can be verified offline with no dependency on Loom, NEAL, DREGG, or a hosted API.
- Privacy-sensitive fields and all external publication steps require explicit user intent.

## Specification artifacts

- [v1 overview](../../specs/image-provenance/v1/README.md)
- [Normative contract](../../specs/image-provenance/v1/CONTRACT.md)
- [Normative CDDL](../../specs/image-provenance/v1/contract.cddl)
- [TypeScript domain and port types](../../specs/image-provenance/v1/types.ts)
- [Dependency-free diagnostic evaluator](../../specs/image-provenance/v1/reference/core.mjs)
- [Diagnostic evaluator tests](../../specs/image-provenance/v1/reference/core.test.mjs)
- [Runnable diagnostic example](../../specs/image-provenance/v1/reference/verify-example.mjs)
- [Reference schema evaluator](../../specs/image-provenance/v1/reference/schema-validator.mjs)
- [Draft 2020-12 bundle schema](../../specs/image-provenance/v1/schema/bundle.schema.json)
- [Linear-chain diagnostic fixture](../../specs/image-provenance/v1/examples/linear-bundle.json)
