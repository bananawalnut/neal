# Loom image-provenance v1

## Status and scope

This directory defines the draft v1, platform-neutral contract for committing image bytes at a declared capture or source boundary and recording subsequent enhancement as a verifiable directed acyclic graph.

The specification defines evidence containers and verification ports; it does not declare any phone, operating system, application, signer, witness, or ledger trustworthy. Deployments choose trust roots and policy independently. In particular, ordinary iOS and Android camera APIs do not, by themselves, prove that an artifact originated at a physical sensor.

The accompanying [initiative](../../../docs/initiatives/003-loom-mobile-image-provenance.md) explains the intended product, delivery phases, and acceptance criteria.

## Files

- [CONTRACT.md](CONTRACT.md) — normative semantics, canonicalization, graph invariants, signatures, evidence, verification, and public interfaces.
- [contract.cddl](contract.cddl) — normative CDDL wire grammar for the signed and content-addressed objects.
- [types.ts](types.ts) — platform-neutral TypeScript domain types and producer, storage, witness, evidence, proof, and verifier ports.
- [reference/core.mjs](reference/core.mjs) — dependency-free canonicalizer, identifier/signature helpers, and diagnostic evaluator for already-verified profile results; it is not the production `Verifier` port.
- [reference/core.test.mjs](reference/core.test.mjs) — deterministic identifier, signature, graph, and tamper-detection tests.
- [reference/verify-example.mjs](reference/verify-example.mjs) — runnable diagnostic verification of the signed linear fixture.
- [reference/schema-validator.mjs](reference/schema-validator.mjs) — dependency-free evaluator for the schema keywords and Loom lexical formats used by the diagnostic core.
- [schema/bundle.schema.json](schema/bundle.schema.json) — self-contained JSON Schema Draft 2020-12 validator for a transport bundle.
- [examples/linear-bundle.json](examples/linear-bundle.json) — deterministic, cryptographically valid diagnostic fixture for a capture followed by generic enhancements; its example witness is not a production trust root.

If an interface type and a normative wire rule appear to disagree, the normative contract and CDDL govern. JSON Schema and TypeScript are validation and integration surfaces; neither may silently widen a signed type.

## Model at a glance

```text
CaptureRecord or SourceRecord
             │ named, digest-bound output
             ▼
       TransformRecord ◀── uses: mask / LUT / model / colour profile
             │
             ├──────────────▶ rendition A
             └──────────────▶ rendition B

records ──▶ signed journal entries ──▶ optional WitnessSink receipts
   │
   └──────▶ optional C2PA 2.4 adapter
```

The provenance graph and append journal solve different problems:

- The graph establishes exact artifact lineage.
- The journal commits records in an append-only sequence and tracks graph heads.
- A witness receipt can add profile-specific publication, inclusion, ordering, or checkpoint evidence.
- None of those layers establishes trusted physical capture time or sensor origin unless verified evidence explicitly binds those facts.

## Core invariants

### Exact artifacts

An artifact reference identifies exact bytes using SHA-256, a decimal-string byte length, media type, representation, and any required layout. The trusted `ArtifactWriter` computes the digest and length while receiving bytes; a provider-supplied digest is not accepted as proof of what was stored.

Encoded files, sensor samples, pixel planes, depth maps, masks, model weights, LUTs, colour profiles, and other resources are distinct representations. A decoded pixel plane is not the same artifact as the JPEG or HEIC that produced it.

### Content-addressed records

A record body does not contain its own identifier. Its `recordId` is derived with the contract's domain-separated hash over its RFC 8785 canonical JSON bytes. Signatures and later endorsements are outside the body so they can be added without changing the record identifier or creating a hash cycle.

Signed material must not depend on locale formatting, floating-point JSON numbers, map insertion order, implicit Unicode normalization, or transport array order. Exact integers use decimal strings; non-integral values use the canonical decimal representation.

### Generic DAG

Every input edge selects a producer record, a named output, and the complete expected artifact reference. A verifier checks the edge against that producer output rather than accepting a matching digest in isolation.

`consumes` edges carry content ancestry. `uses` edges bind resources that affect execution, such as a mask, model, LUT, colour profile, or operation descriptor. A valid selected root has an acyclic, policy-complete reachable graph whose roots are capture or explicit source records.

V1 makes content dependency record-wide: every `consumes` input contributes to every named output. An operation with output-specific dependency sets is represented by separate transform records. Camera-origin assurance follows only `consumes`; `uses` inputs remain fully integrity- and policy-checked but cannot promote origin.

Bundle order and `suggestedRoots` are convenience data. The verifier's caller selects the root output.

### Evidence without claim promotion

Evidence is interpreted only by a registered verifier for its exact profile URI. Unknown evidence remains unsupported. Unknown critical extensions invalidate or make the affected path indeterminate according to policy.

The assurance vocabulary is deliberately layered:

- `self-declared` — the record contains only the producer's claim;
- `app-attested` — evidence binds the claim and bytes to an identified application key or execution context;
- `os-attested` — a trusted profile establishes its documented OS/device guarantees and artifact binding;
- `sensor-path-attested` — a trusted profile specifically establishes a documented sensor-to-output binding.

No verifier infers a higher level from a lower one. Secure key storage, app/device integrity, EXIF, wall-clock metadata, or use of a camera API is not a substitute for sensor binding.

## Producer flow

1. Have the trusted orchestrator start an `ArtifactWriter` for each expected output.
2. Give the provider only each writer's `ArtifactSink`; the provider cannot seal, abort, or author the digest.
3. Have the orchestrator seal the writers and join its opaque sealed receipts to the returned declarations.
4. Commit the canonical record body and its domain-separated signature together with the signed journal entry in one durable transaction.
5. Expose the record only after that atomic commit succeeds.
6. Optionally add detached evidence, execution proof, C2PA material, or witness receipts.
7. Export a bundle containing only the artifacts and disclosures the user selected.

Capture and transform providers do not assign trust verdicts. They describe capabilities, claims, and evidence; independent verifiers apply policy.

## Consumer flow

1. Select the intended root output outside the untrusted bundle.
2. Parse exact UTF-8 JSON bytes with duplicate-key detection and byte/nesting/string/member/value limits before materialization.
3. Recompute record and journal identifiers from canonical bodies.
4. Verify artifact bytes, named output edges, graph acyclicity, signatures, and trust roots across the full dependency closure; calculate origin only over the `consumes` closure.
5. Dispatch referenced keys, evidence, execution proof, and witness receipts only to exact-profile resolvers/verifiers. External blob locations remain inert unless a caller-configured, SSRF-safe resolver is present, and fetched bytes are always rehashed.
6. Replay transforms when required and supported, or verify a detached execution proof or execution-attestation profile.
7. Return the structured `loom.image-provenance/verification-report/v1` result.

The report keeps structural validity, byte integrity, signatures, signer trust, lineage completeness, content-root composition, capture evidence, execution verification, anchoring, time, and location separate. A `mixed` result never turns its capture ingredients' assurance into a claim that the whole output came from a camera. Its top-level verdict can be `accept`, `reject`, or `indeterminate`; consumers should display the findings rather than treating provenance as a single authenticity score.

## C2PA 2.4 adapter profile

The native v1 graph is independent of C2PA. An adapter may exchange supported data with the [C2PA Technical Specification 2.4](https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html):

- native transforms map to supported C2PA actions;
- content ancestors and external sources map to ingredients;
- artifact binding maps to the applicable C2PA hard-binding mechanism;
- C2PA signer, claim, assertion, and validation results remain distinct from local trust decisions; and
- original manifest bytes are retained by digest when an import or export is not lossless.

C2PA conformance or a valid claim signature does not automatically establish sensor origin, truthful assertions, correct enhancement execution, trusted time, or asset ownership. The adapter records its mapping profile and reports omitted or unsupported semantics.

## Witness profile, including Dregg

`WitnessSink` is an optional port. Its opaque receipt binds to a signed journal entry and is interpreted only by the matching witness verifier and configured checkpoints. The provenance graph, artifacts, and record signatures remain independently usable when no witness is configured or reachable.

Dregg is reserved as the optional experimental profile `loom.image-provenance/witness/dregg/v1`. It is active research and not audit-ready. A Dregg receipt must not be treated as camera-origin, enhancement-correctness, ownership, trusted-time, or general truth proof. Production policies should leave it disabled until the protocol and implementation receive independent security, privacy, finality, and recovery review.

## Compatibility rules

- v1 producers emit the canonical v1 forms and preserve exact schema identifiers.
- Consumers reject unsupported major versions.
- Additive non-critical extensions may be retained or ignored according to policy.
- Unknown critical extensions never pass silently.
- Evidence, proof, witness, and C2PA profiles version independently from the core bundle.
- A newer attachment may endorse an existing record without changing its `recordId`.
- Implementations must preserve unknown fields when acting as lossless transport; a verifier still evaluates only understood semantics.

## Minimum conformance suite

A conforming implementation should validate the provided fixture and cover:

- deterministic identifiers across at least two implementations;
- one capture-to-transform linear path and one multi-input graph;
- bit changes, byte-length changes, missing blobs, and media/layout substitution;
- missing parents, wrong output names, graph splicing, and cycles;
- `uses`-only origin laundering and multi-output dependency-set ambiguity;
- incomplete capture-evidence output coverage and mixed capture/source roots;
- changed, deleted, duplicated, and reordered journal entries;
- an authorized journal fork both before and after an otherwise valid anchored tip;
- invalid, untrusted, expired, or revoked signing keys;
- unknown evidence and unknown critical extensions;
- false replay claims and mismatched execution proofs;
- parser, candidate-count, referenced-byte, and hashing-work limit exhaustion,
  including multiple locations for one digest; and
- a commodity mobile capture whose byte integrity is valid while sensor binding remains `not-present`, `unsupported`, or `indeterminate`.

## Current verification status

- Producer: contract and ports are defined; the dependency-free diagnostic evaluator exercises canonical identifiers and signatures through deterministic tests.
- Consumer: the production byte-oriented orchestrating `Verifier` is specified. The included evaluator is intentionally diagnostic because its preverified-result maps are caller-forgeable test seams; an independent production implementation is still pending.
- Live artifact: JSON Schema and diagnostic fixture are supplied for parser validation, not as trusted production evidence.
- Example: run `node specs/image-provenance/v1/reference/verify-example.mjs` for a deterministic diagnostic pass over the fixture.
- C2PA adapter: specified as a boundary; implementation and round-trip tests pending.
- Dregg witness: experimental research only and not audit-ready.
- Risk: additive and isolated from existing `neal.*` contracts. No existing producer or consumer is changed.
