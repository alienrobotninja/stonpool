// C2 selection-ledger surface. LedgerEntry is the per-depositor value pool-core
// keys by address; selection logic (weighted cumulative pick, eligibility) lands
// in S2. The message structs describe the select request/result wire format.
import "shared"

// Balance-weighted ticket count + the epoch the entry was (re)established, used
// for the min-hold eligibility gate.
struct LedgerEntry {
    weight: coins
    joinEpoch: EpochId
}

// pool-core -> selection: pick winners for `tierCount` prize tiers from `seed`.
struct (0x10000021) SelectWinners {
    queryId: uint64
    seed: uint256
    tierCount: uint16
}

// selection -> pool-core / indexers: header for a completed selection.
struct (0x10000022) WinnersResult {
    queryId: uint64
    epoch: EpochId
    seed: uint256
    tierCount: uint16
}
