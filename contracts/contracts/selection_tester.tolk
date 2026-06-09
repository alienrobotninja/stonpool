// Test fixture for C2: holds a sample ledger, exposes the selection + demo
// read-methods. Mirrors how pool-core (C1) will surface them. Not deployed.
import "shared"
import "selection"

struct TesterStorage {
    currentEpoch: EpochId
    minHoldEpochs: uint16
    ledger: map<address, LedgerEntry>
}

fun TesterStorage.load() { return TesterStorage.fromCell(contract.getData()) }
fun TesterStorage.save(self) { contract.setData(self.toCell()) }

struct (0x7e570001) AddEntry {
    queryId: uint64
    who: address
    weight: coins
    joinEpoch: EpochId
}

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; } // deploy
    val msg = lazy AddEntry.fromSlice(in.body);
    var storage = lazy TesterStorage.load();
    val entry: LedgerEntry = { weight: msg.weight, joinEpoch: msg.joinEpoch };
    storage.ledger.set(msg.who, entry);
    storage.save();
}

get fun get_participant_count(): int {
    val s = lazy TesterStorage.load();
    return participantCount(s.ledger);
}
get fun get_total_weight(): coins {
    val s = lazy TesterStorage.load();
    return eligibleWeight(s.ledger, s.currentEpoch, s.minHoldEpochs, false);
}
get fun get_eligible_count(): int {
    val s = lazy TesterStorage.load();
    return eligibleCount(s.ledger, s.currentEpoch, s.minHoldEpochs);
}
get fun get_odds(who: address): int {
    val s = lazy TesterStorage.load();
    return oddsBps(s.ledger, who, s.currentEpoch, s.minHoldEpochs);
}
get fun preview_winner(word: uint256): address {
    val s = lazy TesterStorage.load();
    return selectWinner(s.ledger, s.currentEpoch, s.minHoldEpochs, false, word);
}
get fun preview_winner_flat(word: uint256): address {
    val s = lazy TesterStorage.load();
    return selectWinner(s.ledger, s.currentEpoch, s.minHoldEpochs, true, word);
}
get fun tier_word(seed: uint256, tier: int): uint256 {
    return tierWord(seed, tier);
}

// ledger keys in iteration order; lets a verifier reproduce the cumulative walk.
get fun get_order(): array<address> {
    val s = lazy TesterStorage.load();
    var out: array<address> = [];
    var r = s.ledger.findFirst();
    while (r.isFound) {
        out.push(r.getKey());
        r = s.ledger.iterateNext(r);
    }
    return out;
}

// the full tiered draw: word_i = tierWord(seed, i), winner_i sampled without
// replacement. This is exactly the loop pool-core runs on a DrawResult.
get fun select_winners(seed: uint256, tierCount: int): array<address> {
    val s = lazy TesterStorage.load();
    var chosen = createEmptyMap<address, bool>();
    var out: array<address> = [];
    var tier = 0;
    while (tier < tierCount) {
        val w = selectWinnerEx(s.ledger, s.currentEpoch, s.minHoldEpochs, false, tierWord(seed, tier), chosen);
        chosen.set(w, true);
        out.push(w);
        tier += 1;
    }
    return out;
}
