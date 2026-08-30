# Issue: Decide whether and how YAHOOS move on-chain

Status: Open / decision required  
Area: YAHOOS, Solana, wallet identity, leaderboards  
Current owner: Unassigned

## Current behaviour

YAHOOS are active now as an all-free, browser-local toy. They require no wallet and create no transaction. Events and personal records are stored only in the current browser under `neal.local-yahoos/v1`. They are not global, verified, durable, or on-chain.

## Decision is deliberately open

Do not treat the earlier “three free per wallet per UTC day, then 0.1 NEAL or 0.1 DREGG” sketch as approved tokenomics. Before any on-chain implementation, decide:

- whether YAHOOS should remain free forever;
- whether a wallet should be required at all;
- whether any daily allowance or rate limit is desirable;
- whether NEAL or DREGG should ever be charged, burned, or sent to a treasury;
- whether local records should migrate, reset, or remain a separate game;
- whether a global leaderboard is worth the sybil, spam, privacy, indexing, and moderation cost;
- how streak and speed records should use slots, block time, or an application oracle;
- what pause, upgrade, replay-protection, and incident-response controls would be acceptable.

## Acceptance criteria

- [ ] A written community/product decision chooses free, paid, or mixed behaviour.
- [ ] Wallet and token requirements are explicitly approved rather than inferred from the old sketch.
- [ ] The data model states whether local records migrate or remain local-only.
- [ ] Any on-chain program, transaction builder, treasury, and indexer receive independent security review.
- [ ] The site does not call local records verified, global, or on-chain.
- [ ] The public contract and copy change together only after the decision is recorded.

## Non-goal

This issue does not authorize a mainnet program, token charge, treasury transfer, or global identity system. It exists to keep that future choice visibly undecided.
