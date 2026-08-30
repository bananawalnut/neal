# Local YAHOO protocol

## Public rule now

Every YAHOO is free. No wallet is required, no token is charged, and no transaction is created. The site records YAHOOS only in the current browser using the `neal.local-yahoos/v1` local-storage record.

The future on-chain policy is explicitly undecided. The old idea—three free per wallet per UTC day, then 0.1 NEAL or DREGG—is retained only as historical design context and must not be presented as approved tokenomics.

## Local state

The current browser record contains only:

- schema identifier `neal.local-yahoos/v1`;
- an ordered array of local millisecond timestamps.

No address, email, wallet proof, token balance, IP address, or server account is stored. The implementation retains at most 10,000 timestamps. Clearing this site's browser data clears the record.

## Local tables

The site derives three personal records from the timestamps:

1. `total`: every stored local YAHOO.
2. `fastestThreeMs`: the smallest elapsed browser time between the first and third events in any consecutive three-event run.
3. `peakPerMinute`: the largest event count inside any rolling 60,000-millisecond local window.

These are this-browser records only. They are not verified, global, durable, sybil-resistant, or on-chain. They cannot award tokens, quests, governance power, or eligibility.

## Compatibility

`programs.yahoos.localMode` is additive to `neal.public-record/v1`. A consumer that understands it activates the free local toy when:

- `enabled` is `true`;
- `storage` is `browser_local_storage`;
- `price` is `free`;
- `rankingScope` is `this_browser`.

Older consumers can continue reading the older YAHOO draft fields, but those fields do not override local mode and are not an approved future policy. `futureOnChainPolicyStatus` remains `undecided`.

## Future decision

The open issue at `docs/issues/001-decide-future-yahoo-policy.md` owns any discussion of wallet requirements, token prices, global rankings, migration, program design, or indexing. No on-chain build is authorized until that issue produces a new recorded decision.
