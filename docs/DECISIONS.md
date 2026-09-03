# NEAL decision record

## Accepted

- `D-001`: Pump.fun is the only canonical NEAL mint creator.
- `D-002`: NEAL launches on Solana and initially pairs with SOL.
- `D-003`: Mayhem mode is off.
- `D-004`: Tidemark remains generic and contains no NEAL launch preset.
- `D-005`: The prior 50/42/8 and 42/8/42/8 models are obsolete historical notes, not NEAL tokenomics.
- `D-006`: Quest rewards require proven funded inventory.
- `D-007`: DREGG pairing is secondary and deferred.
- `D-008`: Wallet signing remains human-controlled; no private-key automation is allowed.
- `D-009`: Pump.fun cashback is off. 42% of creator fees routes to the disclosed treasury for NEAL market buys; the remaining 58% routes to the disclosed dev recipient.
- `D-010`: The dev buys his own NEAL from the Pump.fun market with no fixed supply-percentage target. The dev wallet, spend, fill, and transaction are published after they exist.
- `D-011`: The treasury buys NEAL for quest rewards and airdrops to open-source developers with its creator-fee share. The treasury wallet, every market buy, and every distribution are published.
- `D-012`: A community suggestion costs exactly 1 NEAL or 1 DREGG and routes the selected token to the quest treasury. DREGG is not selectable until its canonical mint is verified. The community can rally around published suggestions; Lord NEAL may turn one into a quest. No paid entry opens before the destination wallet, registry, and reviewed transaction builder are public.
- `D-013` (superseded draft): Three free on-chain YAHOOS per wallet per Solana-Clock UTC day followed by a 0.1-token price was explored but is not approved tokenomics.
- `D-014`: YAHOOS are active now as an all-free browser-local toy with local-only records. No wallet or transaction is required. Any future on-chain, paid, or global form remains explicitly undecided.
- `D-015`: The final Pump.fun description is recorded in the launch contract and the public site is `https://nealtheseal.org`.
- `D-016`: The disclosed address `5p7H68DeSmg7LhRg5PvTph8H8HPsaNHKWboBzsLV39eu` is both the creator wallet and the initial creator-fee recipient. The separate treasury address is `7voXHusYTMQoZgrEJBgheRPYCrG1mhwSpn1voX6r4x3q`.
- `D-017`: NEAL will opt into Pump's V2 creator-fee sharing after mint creation, using one final two-recipient split: 58% to the disclosed dev recipient and 42% to the treasury. The one-time final share update waits for the canonical mint. Fees received before activation follow the same 42% obligation through disclosed manual sweeps.
- `D-018`: The treasury's 42% fee share funds quests and airdrops to open-source developers through market buys. NEAL earmarked for developer airdrops may not exceed 18% of total supply in the treasury at any point in time unless every NEAL holder approves a higher cap. This is not a genesis allocation. No override is valid until a reviewed unanimous-holder approval mechanism exists, and airdrops remain locked until eligibility and distribution rules are published.

## Open

- `O-001`: Optional banner, or an explicit decision to omit it
- `O-003`: Final social URLs, or an explicit decision to omit them
- `O-006`: Exact integer-lamport budget and slippage cap for the dev's launch purchase
- `O-007`: Launch date and time
- `O-008`: Treasury/multisig membership and approval threshold
- `O-009`: Quest eligibility and anti-sybil rules
- `O-010`: Public suggestion registry, ranking rules, moderation policy, and appeals process
- `O-011`: Reviewed YAHOO program ID, treasury token accounts, indexer endpoint, upgrade authority, and pause authority
- `O-012`: Open-source-developer airdrop eligibility, review, sybil-resistance, disclosure, vesting or lock policy, and appeals process

Every open decision must be resolved in `launch-config.json` or an explicitly versioned successor before the relevant transaction is built.
