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

// --- C2 selection logic -----------------------------------------------------

type Ledger = map<address, LedgerEntry>

// Held long enough to be eligible for this draw.
fun isEligible(entry: LedgerEntry, currentEpoch: EpochId, minHoldEpochs: uint16): bool {
    return currentEpoch - entry.joinEpoch >= minHoldEpochs;
}

// Tickets an eligible entry contributes: its balance (weighted) or 1 (flat).
fun entryTickets(entry: LedgerEntry, flat: bool): coins {
    return flat ? 1 : entry.weight;
}

fun eligibleWeight(ledger: Ledger, currentEpoch: EpochId, minHoldEpochs: uint16, flat: bool): coins {
    var total: coins = 0;
    var r = ledger.findFirst();
    while (r.isFound) {
        val e = r.loadValue();
        if (isEligible(e, currentEpoch, minHoldEpochs)) {
            total += entryTickets(e, flat);
        }
        r = ledger.iterateNext(r);
    }
    return total;
}

fun participantCount(ledger: Ledger): int {
    var n = 0;
    var r = ledger.findFirst();
    while (r.isFound) {
        n += 1;
        r = ledger.iterateNext(r);
    }
    return n;
}

// addr's share of the eligible weight, in basis points (0 if absent or ineligible).
fun oddsBps(ledger: Ledger, who: address, currentEpoch: EpochId, minHoldEpochs: uint16): int {
    val found = ledger.get(who);
    if (!found.isFound) { return 0; }
    val e = found.loadValue();
    if (!isEligible(e, currentEpoch, minHoldEpochs)) { return 0; }
    val total = eligibleWeight(ledger, currentEpoch, minHoldEpochs, false);
    if (total == 0) { return 0; }
    return e.weight * 10000 / total;
}

// Deterministic winner for `word`: target = word % totalEligible, walk the
// cumulative weight until it is crossed. Same algorithm a verifier reruns
// off-chain against the published seed.
fun selectWinner(ledger: Ledger, currentEpoch: EpochId, minHoldEpochs: uint16, flat: bool, word: uint256): address {
    val total = eligibleWeight(ledger, currentEpoch, minHoldEpochs, flat);
    assert (total != 0) throw ERR_NO_DEPOSITORS;
    val target = word % total;
    var cumulative: coins = 0;
    var r = ledger.findFirst();
    while (r.isFound) {
        val e = r.loadValue();
        if (isEligible(e, currentEpoch, minHoldEpochs)) {
            cumulative += entryTickets(e, flat);
            if (cumulative > target) {
                return r.getKey();
            }
        }
        r = ledger.iterateNext(r);
    }
    throw ERR_NO_DEPOSITORS; // unreachable: total > 0 guarantees a hit
}
