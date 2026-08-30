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
- `D-009`: Pump.fun cashback is off. 42% of creator fees fund disclosed NEAL buybacks through the quest treasury; use of the remaining creator-fee share is unresolved.
- `D-010`: The dev buys his own NEAL from the Pump.fun market with no fixed supply-percentage target. The dev wallet, spend, fill, and transaction are published after they exist.
- `D-011`: The quest treasury buys NEAL for quest rewards with its creator-fee share. The treasury wallet and every buyback are published after they exist.
- `D-012`: A community suggestion costs exactly 1 NEAL or 1 DREGG and routes the selected token to the quest treasury. DREGG is not selectable until its canonical mint is verified. The community can rally around published suggestions; Lord NEAL may turn one into a quest. No paid entry opens before the destination wallet, registry, and reviewed transaction builder are public.
- `D-013` (superseded draft): Three free on-chain YAHOOS per wallet per Solana-Clock UTC day followed by a 0.1-token price was explored but is not approved tokenomics.
- `D-014`: YAHOOS are active now as an all-free browser-local toy with local-only records. No wallet or transaction is required. Any future on-chain, paid, or global form remains explicitly undecided.

## Open

- `O-001`: Final image and banner
- `O-002`: Final immutable description
- `O-003`: Website and social URLs, or approved linkless launch
- `O-005`: Creator and creator-fee-recipient addresses
- `O-006`: Exact integer-lamport budget and slippage cap for the dev's launch purchase
- `O-007`: Launch date and time
- `O-008`: Treasury/multisig membership and approval threshold
- `O-009`: Quest eligibility and anti-sybil rules
- `O-010`: Public suggestion registry, ranking rules, moderation policy, and appeals process
- `O-011`: Reviewed YAHOO program ID, treasury token accounts, indexer endpoint, upgrade authority, and pause authority

Every open decision must be resolved in `launch-config.json` or an explicitly versioned successor before the relevant transaction is built.
